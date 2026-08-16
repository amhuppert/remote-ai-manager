import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import type {
  ActorProvenance,
  Refusal,
  Spec,
  SpecCriterionDisposition,
  SpecCriterionDispositionRow,
  SpecWaiverRow,
} from "./schemas";
import { executionScopeSchema } from "./scope-validation";
import { grantWaiver as grantWaiverTransition } from "./transitions";

const logger = createLogger("specs.evidence-service");

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Refusal };

export type EvidenceMutationActor = ActorProvenance | { kind: "system" };

export interface EvidenceMutationRecord {
  specId: string;
  actor: EvidenceMutationActor;
  occurredAt: string;
  kind: string;
  payload: Record<string, unknown>;
  /**
   * Envelope context for the typed spec-evidence-changed SSE event. Required
   * for every evidence mutation kind; durable-only kinds (waiver routing,
   * interventions) omit it and never publish.
   */
  sse?: {
    revisionId: string;
    criterionId?: string;
    taskId?: string;
    executionId?: string;
  };
}

export interface EvidenceMutationRecorderDeps {
  eventsRepo: Pick<SpecEventsRepo, "appendInTransaction">;
  events: SpecEventsPublisher;
  findSpecById(specId: string): Spec | null;
  runInImmediateTransaction<T>(operation: () => T): T;
}

/**
 * Records durable evidence mutations and publishes their typed SSE envelopes
 * only after the surrounding transaction commits; the returned pair must be
 * composed together so the recorder can defer publication to the wrapped
 * transaction boundary (remediation: execution-evidence-sse).
 */
export function createEvidenceMutationRecorder(
  deps: EvidenceMutationRecorderDeps,
): Pick<EvidenceServiceDeps, "recordMutation" | "runInImmediateTransaction"> {
  const pending: PreparedSpecEventPublication[] = [];
  let transactionDepth = 0;

  return {
    recordMutation(input) {
      const durableEventType =
        input.kind === "waiver-request-routed"
          ? "spec-attention-changed"
          : input.kind === "transition-refused"
            ? "spec-intervention-recorded"
            : "spec-evidence-changed";
      if (
        durableEventType !== "spec-evidence-changed" ||
        input.sse === undefined
      ) {
        deps.eventsRepo.appendInTransaction({
          spec_id: input.specId,
          occurred_at: input.occurredAt,
          event_type: durableEventType,
          actor_json: stableStringify(input.actor),
          payload_json: stableStringify({
            kind: input.kind,
            ...input.payload,
          }),
        });
        return;
      }
      const spec = deps.findSpecById(input.specId);
      if (spec === null) {
        throw new Error(`Spec ${input.specId} vanished mid-transaction`);
      }
      const prepared = deps.events.appendInTransaction({
        actor: input.actor,
        durableEventType,
        durablePayload: { kind: input.kind, ...input.payload },
        sseEvent: {
          type: "spec-evidence-changed",
          kind: input.kind,
          projectPath: spec.projectPath,
          specId: spec.id,
          specSlug: spec.slug,
          occurredAt: input.occurredAt,
          ...input.sse,
        },
      });
      if (transactionDepth > 0) {
        pending.push(prepared);
      } else {
        deps.events.publishAfterCommit(prepared);
      }
    },
    runInImmediateTransaction(operation) {
      transactionDepth += 1;
      try {
        const result = deps.runInImmediateTransaction(operation);
        if (transactionDepth === 1) {
          for (const prepared of pending.splice(0)) {
            deps.events.publishAfterCommit(prepared);
          }
        }
        return result;
      } catch (error) {
        if (transactionDepth === 1) pending.length = 0;
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
  };
}

export interface EvidenceServiceDeps {
  repo: SpecDeliveryRepo;
  nextId(kind: "evidence" | "verdict" | "claim" | "waiver"): string;
  now(): string;
  routeWaiverRequestToHuman(
    input: WaiverRequestInput,
  ): Promise<WaiverRequestReceipt>;
  getCriterionVersion(
    revisionId: string,
    criterionElementId: string,
  ): Promise<CriterionVersion | null>;
  wasCriterionDeliveredByMergedExecution(
    input: MergedCriterionDeliveryCheck,
  ): Promise<boolean>;
  recordMutation(input: EvidenceMutationRecord): void;
  runInImmediateTransaction<T>(operation: () => T): T;
  /** Clears the routed waiver request's Needs You item after a grant. */
  waiverNotifier?: Pick<SpecWaiverNotifier, "waiverGranted">;
  /** Resolve a criterion's bare handle for Needs You deep links (optional). */
  resolveCriterionHandle?(
    specId: string,
    criterionElementId: string,
  ): Promise<string | null>;
}

export interface CriterionVersion {
  specId: string;
  revisionNumber: number;
  payloadHash: string;
}

export interface MergedCriterionDeliveryCheck {
  executionId: string;
  criterionElementId: string;
  beforeExecutionId: string;
}

export interface WaiverInput {
  specId: string;
  criterionElementId: string;
  revisionId: string;
  actor: ActorProvenance;
  reason: string;
}

export type WaiverRequestSource =
  | Extract<ActorProvenance, { kind: "agent" }>
  | { kind: "policy"; dial: "notify" | "off" };

export interface WaiverRequestInput {
  specId: string;
  criterionElementId: string;
  revisionId: string;
  source: WaiverRequestSource;
  reason: string;
}

export interface WaiverRequestReceipt {
  attentionId: string;
}

/**
 * Notice shapes for the waiver attention pipeline (R14.3, R19.3). The domain
 * owns the shapes; the composed notifier (notifications/spec-approvals) owns
 * the durable notification consequences. `waiverRequested` is fired by the
 * production waiver-routing port; `waiverGranted` is forwarded by this
 * service after the grant transaction commits so the open Needs You item
 * clears.
 */
export interface SpecWaiverRequestNotice {
  specId: string;
  specSlug: string;
  specName: string;
  projectPath: string;
  criterionElementId: string;
  /**
   * The criterion's bare handle (R1.1) when resolvable — Needs You deep
   * links use it because the Studio resolver parses handles, not element ids.
   */
  criterionHandle?: string | null;
  revisionId: string;
  /** The routed attention id — the durable correlation key for resolution. */
  attentionId: string;
  reason: string;
  occurredAt: string;
}

export interface SpecWaiverGrantNotice {
  specId: string;
  criterionElementId: string;
  /** Same handle the request stored, so the grant resolves the same row. */
  criterionHandle?: string | null;
  revisionId: string;
  waiverId: string;
  occurredAt: string;
}

export interface SpecWaiverNotifier {
  waiverRequested(notice: SpecWaiverRequestNotice): void;
  waiverGranted(notice: SpecWaiverGrantNotice): void;
}

export interface MarkWaiverStaleInput {
  waiverId: string;
  laterRevisionId: string;
  actor: EvidenceMutationActor;
}

export interface DispositionInput {
  executionId: string;
  criterionElementId: string;
  disposition: SpecCriterionDisposition;
  waiverId?: string;
  deliveredByExecutionId?: string;
  actor: EvidenceMutationActor;
}

export interface EvidenceService {
  requestWaiver(
    input: WaiverRequestInput,
  ): Promise<ServiceResult<WaiverRequestReceipt>>;
  grantWaiver(input: WaiverInput): Promise<ServiceResult<SpecWaiverRow>>;
  markWaiverStaleForCriterionChange(
    input: MarkWaiverStaleInput,
  ): Promise<ServiceResult<SpecWaiverRow>>;
  setDisposition(
    input: DispositionInput,
  ): Promise<ServiceResult<SpecCriterionDispositionRow>>;
}

function refuse(
  code: Refusal["code"],
  unmetConditions: string[],
  instruction: string,
  findings?: Refusal["findings"],
): ServiceResult<never> {
  logger.warn("specs.evidence-service.refused", {
    code,
    unmetConditionCount: unmetConditions.length,
  });
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions,
      ...(findings === undefined ? {} : { findings }),
      instruction,
    },
  };
}

export function createEvidenceService(
  deps: EvidenceServiceDeps,
): EvidenceService {
  return {
    async requestWaiver(input) {
      const criterion = await deps.getCriterionVersion(
        input.revisionId,
        input.criterionElementId,
      );
      if (!criterion || criterion.specId !== input.specId) {
        return refuse(
          "not_found",
          ["The criterion does not exist in the target revision."],
          "Request a waiver for an existing criterion and revision.",
        );
      }
      if (input.reason.trim().length === 0) {
        return refuse(
          "validation",
          ["A waiver request requires a reason for the human reviewer."],
          "Explain why a waiver decision is needed and request it again.",
        );
      }
      const validSource =
        input.source.kind === "agent" ||
        (input.source.kind === "policy" &&
          (input.source.dial === "notify" || input.source.dial === "off"));
      if (!validSource) {
        return refuse(
          "validation",
          [
            "Waiver requests may be routed only by an agent or Notify/Off policy.",
          ],
          "Route the request from an agent or the active Notify/Off policy.",
        );
      }

      const routedInput: WaiverRequestInput = {
        ...input,
        reason: input.reason.trim(),
      };
      const receipt = await deps.routeWaiverRequestToHuman(routedInput);
      deps.recordMutation({
        specId: input.specId,
        actor:
          input.source.kind === "agent" ? input.source : { kind: "system" },
        occurredAt: deps.now(),
        kind: "waiver-request-routed",
        payload: {
          attentionId: receipt.attentionId,
          criterionElementId: input.criterionElementId,
          revisionId: input.revisionId,
        },
      });
      logger.info("specs.waiver-request.routed", {
        attentionId: receipt.attentionId,
        specId: input.specId,
        criterionElementId: input.criterionElementId,
        revisionId: input.revisionId,
        sourceKind: input.source.kind,
      });
      return { ok: true, value: receipt };
    },

    async grantWaiver(input) {
      const criterion = await deps.getCriterionVersion(
        input.revisionId,
        input.criterionElementId,
      );
      if (!criterion || criterion.specId !== input.specId) {
        return refuse(
          "not_found",
          ["The criterion does not exist in the target revision."],
          "Grant a waiver for an existing criterion and revision.",
        );
      }
      const existing = deps.repo.findWaiverForCriterionRevision(
        input.criterionElementId,
        input.revisionId,
      );
      const decision = grantWaiverTransition({
        actor: input.actor,
        reason: input.reason,
        existingWaiver: existing !== null,
      });
      if (!decision.ok) {
        logger.warn("specs.waiver.grant.refused", {
          code: decision.refusal.code,
          specId: input.specId,
          criterionElementId: input.criterionElementId,
          revisionId: input.revisionId,
        });
        return { ok: false, refusal: decision.refusal };
      }

      const occurredAt = deps.now();
      const waiver = deps.runInImmediateTransaction(() => {
        const persisted: SpecWaiverRow = {
          id: deps.nextId("waiver"),
          spec_id: input.specId,
          criterion_element_id: input.criterionElementId,
          revision_id: input.revisionId,
          reason: input.reason.trim(),
          waived_at: occurredAt,
          stale: 0,
        };
        deps.repo.saveWaiver(persisted);
        deps.recordMutation({
          specId: input.specId,
          actor: input.actor,
          occurredAt,
          kind: "waiver-granted",
          sse: {
            revisionId: input.revisionId,
            criterionId: input.criterionElementId,
          },
          payload: {
            waiverId: persisted.id,
            criterionElementId: input.criterionElementId,
            revisionId: input.revisionId,
          },
        });
        return persisted;
      });
      const criterionHandle =
        (await deps.resolveCriterionHandle?.(
          input.specId,
          input.criterionElementId,
        )) ?? null;
      deps.waiverNotifier?.waiverGranted({
        specId: input.specId,
        criterionElementId: input.criterionElementId,
        criterionHandle,
        revisionId: input.revisionId,
        waiverId: waiver.id,
        occurredAt,
      });
      logger.info("specs.waiver.granted", {
        waiverId: waiver.id,
        specId: waiver.spec_id,
        criterionElementId: waiver.criterion_element_id,
        revisionId: waiver.revision_id,
      });
      return { ok: true, value: waiver };
    },

    async markWaiverStaleForCriterionChange(input) {
      const waiver = deps.repo.findWaiverById(input.waiverId);
      if (!waiver) {
        return refuse(
          "not_found",
          [`Waiver ${input.waiverId} does not exist.`],
          "Reconcile staleness for an existing waiver.",
        );
      }
      const [waivedVersion, laterVersion] = await Promise.all([
        deps.getCriterionVersion(
          waiver.revision_id,
          waiver.criterion_element_id,
        ),
        deps.getCriterionVersion(
          input.laterRevisionId,
          waiver.criterion_element_id,
        ),
      ]);
      if (
        !waivedVersion ||
        !laterVersion ||
        laterVersion.specId !== waiver.spec_id ||
        laterVersion.revisionNumber <= waivedVersion.revisionNumber
      ) {
        return refuse(
          "validation",
          [
            "The waived criterion must exist in both revisions and the comparison revision must be later.",
          ],
          "Compare the waiver with a later revision containing the same criterion.",
        );
      }
      if (
        waiver.stale === 1 ||
        waivedVersion.payloadHash === laterVersion.payloadHash
      ) {
        return { ok: true, value: waiver };
      }

      const occurredAt = deps.now();
      const staleWaiver = deps.runInImmediateTransaction(() => {
        const persisted: SpecWaiverRow = { ...waiver, stale: 1 };
        deps.repo.saveWaiver(persisted);
        deps.recordMutation({
          specId: waiver.spec_id,
          actor: input.actor,
          occurredAt,
          kind: "waiver-staled",
          sse: {
            revisionId: waiver.revision_id,
            criterionId: waiver.criterion_element_id,
          },
          payload: {
            waiverId: waiver.id,
            criterionElementId: waiver.criterion_element_id,
            waivedRevisionId: waiver.revision_id,
            laterRevisionId: input.laterRevisionId,
          },
        });
        return persisted;
      });
      logger.info("specs.waiver.staled", {
        waiverId: waiver.id,
        specId: waiver.spec_id,
        criterionElementId: waiver.criterion_element_id,
        waivedRevisionId: waiver.revision_id,
        laterRevisionId: input.laterRevisionId,
      });
      return { ok: true, value: staleWaiver };
    },

    async setDisposition(input) {
      const execution = deps.repo.findExecutionById(input.executionId);
      if (!execution) {
        return refuse(
          "not_found",
          [`Execution ${input.executionId} does not exist.`],
          "Set a disposition on an existing spec execution.",
        );
      }
      const criterion = await deps.getCriterionVersion(
        execution.revision_id,
        input.criterionElementId,
      );
      if (!criterion || criterion.specId !== execution.spec_id) {
        return refuse(
          "not_found",
          ["The criterion does not exist in the execution's pinned revision."],
          "Set a disposition for a criterion at the pinned revision.",
        );
      }

      const pinnedAuthority = criterionScopeAuthority(
        execution.scope_json,
        input.criterionElementId,
      );
      if (pinnedAuthority === null) {
        return refuse(
          "invalid_scope",
          [
            `Criterion ${input.criterionElementId} has no authority in execution ${input.executionId}'s pinned scope.`,
          ],
          "Inspect the immutable execution scope and choose a criterion pinned to this run.",
        );
      }
      if (pinnedAuthority !== "in_scope") {
        return refuse(
          "amendment_required",
          [
            `Criterion ${input.criterionElementId} is pinned ${pinnedAuthority.replaceAll("_", " ")} for execution ${input.executionId}.`,
          ],
          "Preserve the excluded criterion as not in this delivery; abandon and restart from an amended approved revision to select it.",
        );
      }
      if (
        input.disposition === "in_scope" ||
        input.disposition === "deferred"
      ) {
        return refuse(
          "amendment_required",
          [
            `Criterion ${input.criterionElementId} is pinned in scope for execution ${input.executionId}.`,
          ],
          "Preserve the pinned scope; abandon and restart from an amended approved revision to change scope.",
        );
      }

      let waiverId: string | null = null;
      let deliveredByExecutionId: string | null = null;
      if (input.disposition === "waived") {
        const waiver = input.waiverId
          ? deps.repo.findWaiverById(input.waiverId)
          : null;
        if (
          !waiver ||
          waiver.stale === 1 ||
          waiver.spec_id !== execution.spec_id ||
          waiver.criterion_element_id !== input.criterionElementId ||
          waiver.revision_id !== execution.revision_id
        ) {
          return refuse(
            "validation",
            [
              "A waived disposition requires a valid waiver for this criterion and pinned revision.",
            ],
            "Obtain a human waiver for this criterion and revision, then set the disposition.",
          );
        }
        waiverId = waiver.id;
      }

      if (input.disposition === "delivered_elsewhere") {
        const priorExecutionId = input.deliveredByExecutionId;
        const delivered =
          priorExecutionId !== undefined &&
          (await deps.wasCriterionDeliveredByMergedExecution({
            executionId: priorExecutionId,
            criterionElementId: input.criterionElementId,
            beforeExecutionId: input.executionId,
          }));
        if (!priorExecutionId || !delivered) {
          return refuse(
            "validation",
            [
              `Execution ${priorExecutionId ?? "(missing)"} is not an earlier successfully merged delivery of criterion ${input.criterionElementId}.`,
            ],
            "Choose an earlier successfully merged execution that delivered this criterion.",
          );
        }
        deliveredByExecutionId = priorExecutionId;
      }

      const existing = deps.repo.findCriterionDisposition(
        input.executionId,
        input.criterionElementId,
      );
      const now = deps.now();
      const disposition = deps.runInImmediateTransaction(() => {
        const persisted: SpecCriterionDispositionRow = {
          execution_id: input.executionId,
          criterion_element_id: input.criterionElementId,
          disposition: input.disposition,
          waiver_id: waiverId,
          delivered_by_execution_id: deliveredByExecutionId,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        deps.repo.saveCriterionDisposition(persisted);
        deps.recordMutation({
          specId: execution.spec_id,
          actor: input.actor,
          occurredAt: now,
          kind: "criterion-disposition-saved",
          sse: {
            revisionId: execution.revision_id,
            criterionId: input.criterionElementId,
            executionId: input.executionId,
          },
          payload: {
            executionId: input.executionId,
            criterionElementId: input.criterionElementId,
            disposition: input.disposition,
            waiverId,
            deliveredByExecutionId,
          },
        });
        return persisted;
      });
      logger.info("specs.criterion-disposition.saved", {
        executionId: disposition.execution_id,
        criterionElementId: disposition.criterion_element_id,
        disposition: disposition.disposition,
        waiverId: disposition.waiver_id,
        deliveredByExecutionId: disposition.delivered_by_execution_id,
      });
      return { ok: true, value: disposition };
    },
  };
}

function criterionScopeAuthority(
  scopeJson: string,
  criterionElementId: string,
): SpecCriterionDisposition | null {
  let value: unknown;
  try {
    value = JSON.parse(scopeJson);
  } catch {
    return null;
  }
  const parsed = executionScopeSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.selectedCriterionIds.includes(criterionElementId)) {
    return "in_scope";
  }
  return (
    parsed.data.exclusionDispositions.find(
      (entry) => entry.criterionId === criterionElementId,
    )?.disposition ?? null
  );
}
