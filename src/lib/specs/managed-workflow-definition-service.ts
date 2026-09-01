import { createLogger } from "@/lib/logging";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionRecord,
} from "@/lib/workflow-graph/definition-schemas";
import type { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { workflowDefinitionHash } from "./delivery-plan-hash";
import {
  finalizeDeliveryPlanLaunch,
  type DeliveryPlanLaunchStage,
} from "./delivery-plan-finalization";
import type { Spec } from "./schemas";
import {
  definitionMutationCoordinator,
  type DefinitionMutationCoordinator,
} from "@/lib/workflow-graph/definition-mutation-coordinator";

const logger = createLogger("specs.managed-workflow-definition");

type WorkflowStorage = ReturnType<typeof createWorkflowStorageService>;

export class ManagedWorkflowDefinitionIntegrityError extends Error {
  readonly code = "integrity_mismatch" as const;

  constructor(
    readonly workflowId: string,
    readonly reason: string,
  ) {
    super(
      `Managed workflow definition ${workflowId} failed integrity: ${reason}`,
    );
    this.name = "ManagedWorkflowDefinitionIntegrityError";
  }
}

export interface ManagedWorkflowDefinitionService {
  runExclusive<T>(
    workflowDefinitionId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  get(input: {
    projectPath: string;
    workflowDefinitionId: string;
  }): Promise<WorkflowDefinitionRecord | null>;
  findOpenOrphan(input: {
    spec: Spec;
    pinnedRevisionId: string;
    existingAttemptIds: readonly string[];
  }): Promise<WorkflowDefinitionRecord | null>;
  findReopenOrphan(input: {
    spec: Spec;
    pinnedRevisionId: string;
    attemptId: string;
    linkedDefinitionIds: readonly string[];
  }): Promise<WorkflowDefinitionRecord | null>;
  removeExact(input: {
    projectPath: string;
    workflowDefinitionId: string;
    revision: number;
    definitionHash: string;
  }): Promise<boolean>;
  open(input: {
    spec: Spec;
    pinnedRevisionId: string;
    attemptId: string;
    launch: WorkflowDefinitionDraft;
  }): Promise<WorkflowDefinitionRecord>;
  clone(input: {
    spec: Spec;
    pinnedRevisionId: string;
    attemptId: string;
    sourceDefinitionId: string;
    cloneDefinitionId: string;
  }): Promise<WorkflowDefinitionRecord>;
  /**
   * Rewrite a managed definition at the given stage as its next revision:
   * `candidate` freezes the charter a proposal binds, `draft` hands it back to
   * the authoring surfaces. The identity (id, origin) never changes.
   */
  restage(input: {
    spec: Spec;
    pinnedRevisionId: string;
    attemptId: string;
    workflowDefinitionId: string;
    expectedRevision: number;
    stage: DeliveryPlanLaunchStage;
  }): Promise<WorkflowDefinitionRecord>;
  getExact(input: {
    projectPath: string;
    workflowDefinitionId: string;
    revision: number;
    definitionHash: string;
  }): Promise<WorkflowDefinitionRecord>;
}

function finalizedDraft(input: {
  spec: Spec;
  pinnedRevisionId: string;
  attemptId: string;
  candidateId: string;
  launch: WorkflowDefinitionDraft;
  stage: DeliveryPlanLaunchStage;
}): WorkflowDefinitionDraft {
  return finalizeDeliveryPlanLaunch({
    specId: input.spec.id,
    specSlug: input.spec.slug,
    pinnedRevisionId: input.pinnedRevisionId,
    attemptId: input.attemptId,
    candidateId: input.candidateId,
    launch: input.launch,
    stage: input.stage,
  });
}

export function createManagedWorkflowDefinitionService(deps: {
  storage: WorkflowStorage;
  mutationCoordinator?: DefinitionMutationCoordinator;
}): ManagedWorkflowDefinitionService {
  const coordinator = deps.mutationCoordinator ?? definitionMutationCoordinator;
  const projectScope = (projectPath: string) => ({
    kind: "project" as const,
    projectPath,
  });

  function sourceIdentity(
    record: WorkflowDefinitionRecord,
    input: { specId: string; pinnedRevisionId: string },
  ): { attemptId: string; candidateId: string } | null {
    const prefix = `spec-plan://${input.specId}/revisions/${input.pinnedRevisionId}/attempts/`;
    const sourceUri = record.definition.origin?.sourceUri;
    if (!sourceUri?.startsWith(prefix)) return null;
    const [attemptId, candidateId, ...extra] = sourceUri
      .slice(prefix.length)
      .split("/candidates/");
    if (
      !attemptId ||
      !candidateId ||
      extra.length > 0 ||
      record.id !== candidateId ||
      record.layout.workflowId !== candidateId
    ) {
      throw new ManagedWorkflowDefinitionIntegrityError(
        record.id,
        "managed source identity does not match the stored definition",
      );
    }
    return { attemptId, candidateId };
  }

  async function managedRecords(
    spec: Spec,
  ): Promise<WorkflowDefinitionRecord[]> {
    const scope = projectScope(spec.projectPath);
    const summaries = await deps.storage.list(scope);
    const records = await Promise.all(
      summaries.map((summary) => deps.storage.get(scope, summary.id)),
    );
    return records.filter(
      (record): record is WorkflowDefinitionRecord => record !== null,
    );
  }

  function soleOrphan(
    records: readonly WorkflowDefinitionRecord[],
    spec: Spec,
  ): WorkflowDefinitionRecord | null {
    if (records.length === 0) return null;
    if (records.length === 1) return records[0]!;
    logger.error("specs.delivery-plan.definition.integrity_mismatch", {
      specId: spec.id,
      reason: "ambiguous_orphans",
      orphanCount: records.length,
      workflowDefinitionIds: records.map((record) => record.id),
    });
    throw new ManagedWorkflowDefinitionIntegrityError(
      spec.id,
      `${records.length} unlinked managed workflow definitions match the delivery`,
    );
  }

  async function createOrReuse(input: {
    spec: Spec;
    pinnedRevisionId: string;
    attemptId: string;
    definitionId: string;
    launch: WorkflowDefinitionDraft;
    event: "created" | "cloned";
  }): Promise<WorkflowDefinitionRecord> {
    const scope = {
      kind: "project" as const,
      projectPath: input.spec.projectPath,
    };
    const finalized = finalizedDraft({
      spec: input.spec,
      pinnedRevisionId: input.pinnedRevisionId,
      attemptId: input.attemptId,
      candidateId: input.definitionId,
      launch: input.launch,
      stage: "draft",
    });
    const draft = {
      ...finalized,
      layout: { ...finalized.layout, workflowId: input.definitionId },
    };
    const existing = await deps.storage.get(scope, input.definitionId);
    if (existing) {
      if (workflowDefinitionHash(existing) !== workflowDefinitionHash(draft)) {
        logger.error("specs.delivery-plan.definition.integrity_mismatch", {
          specId: input.spec.id,
          attemptId: input.attemptId,
          workflowDefinitionId: input.definitionId,
          revision: existing.revision,
        });
        throw new ManagedWorkflowDefinitionIntegrityError(
          input.definitionId,
          "existing authored bytes differ from the expected managed definition",
        );
      }
      logger.info("specs.delivery-plan.definition.reused", {
        specId: input.spec.id,
        attemptId: input.attemptId,
        workflowDefinitionId: existing.id,
        revision: existing.revision,
        definitionHash: workflowDefinitionHash(existing),
      });
      return existing;
    }

    const created = await deps.storage.createWithId(
      scope,
      input.definitionId,
      draft,
    );
    logger.info(`specs.delivery-plan.definition.${input.event}`, {
      specId: input.spec.id,
      attemptId: input.attemptId,
      workflowDefinitionId: created.id,
      revision: created.revision,
      definitionHash: workflowDefinitionHash(created),
    });
    return created;
  }

  return {
    runExclusive(workflowDefinitionId, operation) {
      return coordinator.run(workflowDefinitionId, operation);
    },
    get(input) {
      return deps.storage.get(
        { kind: "project", projectPath: input.projectPath },
        input.workflowDefinitionId,
      );
    },
    async findOpenOrphan(input) {
      const existingAttemptIds = new Set(input.existingAttemptIds);
      const records = await managedRecords(input.spec);
      return soleOrphan(
        records.filter((record) => {
          const identity = sourceIdentity(record, {
            specId: input.spec.id,
            pinnedRevisionId: input.pinnedRevisionId,
          });
          return (
            identity !== null &&
            identity.attemptId === identity.candidateId &&
            !existingAttemptIds.has(identity.attemptId)
          );
        }),
        input.spec,
      );
    },
    async findReopenOrphan(input) {
      const linkedDefinitionIds = new Set(input.linkedDefinitionIds);
      const records = await managedRecords(input.spec);
      return soleOrphan(
        records.filter((record) => {
          const identity = sourceIdentity(record, {
            specId: input.spec.id,
            pinnedRevisionId: input.pinnedRevisionId,
          });
          return (
            identity?.attemptId === input.attemptId &&
            !linkedDefinitionIds.has(record.id)
          );
        }),
        input.spec,
      );
    },
    async removeExact(input) {
      await this.getExact(input);
      const removed = await deps.storage.delete(
        projectScope(input.projectPath),
        input.workflowDefinitionId,
      );
      logger.info("specs.delivery-plan.definition.removed_after_failure", {
        workflowDefinitionId: input.workflowDefinitionId,
        revision: input.revision,
        definitionHash: input.definitionHash,
        removed,
      });
      return removed;
    },
    open(input) {
      return createOrReuse({
        ...input,
        definitionId: input.attemptId,
        event: "created",
      });
    },
    async clone(input) {
      const scope = {
        kind: "project" as const,
        projectPath: input.spec.projectPath,
      };
      const source = await deps.storage.get(scope, input.sourceDefinitionId);
      if (!source) {
        throw new ManagedWorkflowDefinitionIntegrityError(
          input.sourceDefinitionId,
          "source definition is missing",
        );
      }
      return createOrReuse({
        spec: input.spec,
        pinnedRevisionId: input.pinnedRevisionId,
        attemptId: input.attemptId,
        definitionId: input.cloneDefinitionId,
        launch: source,
        event: "cloned",
      });
    },
    async restage(input) {
      const scope = projectScope(input.spec.projectPath);
      const existing = await deps.storage.get(
        scope,
        input.workflowDefinitionId,
      );
      if (!existing) {
        throw new ManagedWorkflowDefinitionIntegrityError(
          input.workflowDefinitionId,
          "definition file is missing",
        );
      }
      const finalized = finalizedDraft({
        spec: input.spec,
        pinnedRevisionId: input.pinnedRevisionId,
        attemptId: input.attemptId,
        candidateId: existing.id,
        launch: existing,
        stage: input.stage,
      });
      const restaged = await deps.storage.update(
        scope,
        existing.id,
        input.expectedRevision,
        {
          ...finalized,
          layout: { ...finalized.layout, workflowId: existing.id },
        },
      );
      logger.info("specs.delivery-plan.definition.restaged", {
        specId: input.spec.id,
        attemptId: input.attemptId,
        workflowDefinitionId: restaged.id,
        stage: input.stage,
        revision: restaged.revision,
        definitionHash: workflowDefinitionHash(restaged),
      });
      return restaged;
    },
    async getExact(input) {
      const record = await deps.storage.get(
        { kind: "project", projectPath: input.projectPath },
        input.workflowDefinitionId,
      );
      if (!record) {
        throw new ManagedWorkflowDefinitionIntegrityError(
          input.workflowDefinitionId,
          "definition file is missing",
        );
      }
      if (record.revision !== input.revision) {
        throw new ManagedWorkflowDefinitionIntegrityError(
          input.workflowDefinitionId,
          `stored revision ${record.revision} does not match ${input.revision}`,
        );
      }
      const actualHash = workflowDefinitionHash(record);
      if (actualHash !== input.definitionHash) {
        throw new ManagedWorkflowDefinitionIntegrityError(
          input.workflowDefinitionId,
          `stored definition hash ${actualHash} does not match ${input.definitionHash}`,
        );
      }
      return record;
    },
  };
}
