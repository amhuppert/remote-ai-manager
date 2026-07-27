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
  EvidenceEvaluatedState,
  EvidenceKind,
  Refusal,
  Spec,
  SpecCriterionDisposition,
  SpecCriterionDispositionRow,
  SpecEvidenceRow,
  SpecGatePolicy,
  SpecProofVerdictKind,
  SpecProofVerdictRow,
  SpecTaskClaimRow,
  SpecWaiverRow,
  ValidationStrategy,
} from "./schemas";
import { isExploratoryShippingRefused } from "./policy";
import { executionScopeSchema } from "./scope-validation";
import type { RevisionSnapshot } from "./lint";
import {
  claimTaskComplete as claimTaskCompleteTransition,
  grantWaiver as grantWaiverTransition,
} from "./transitions";

const logger = createLogger("specs.evidence-service");

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Refusal };

export interface GitObjectEvidenceRef {
  type: "git_object";
  objectId: string;
}

export interface WorkflowEventEvidenceRef {
  type: "workflow_event";
  workflowExecutionId: string;
  eventId: number;
  contextId: string;
}

export interface MergeValidationEvidenceRef {
  type: "merge_validation";
  mergeJobId: string;
  validationRef: string;
}

export type EvidenceReference =
  | GitObjectEvidenceRef
  | WorkflowEventEvidenceRef
  | MergeValidationEvidenceRef;

export interface ApprovedCriterion {
  specId: string;
  validationStrategy: ValidationStrategy;
}

export interface StrategyInadequacy {
  specId: string;
  revisionId: string;
  criterionElementId: string;
  reason: string;
}

export interface EvidenceExecutionContext {
  specExecutionId: string;
  workflowExecutionId: string | null;
}

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
  ingestExecutionEvidence(executionId: string): Promise<unknown>;
  nextId(kind: "evidence" | "verdict" | "claim" | "waiver"): string;
  now(): string;
  getApprovedCriterion(
    revisionId: string,
    criterionElementId: string,
  ): Promise<ApprovedCriterion | null>;
  gitObjectExists(
    ref: GitObjectEvidenceRef,
    expectedExecution: EvidenceExecutionContext,
  ): Promise<boolean>;
  workflowEventExists(
    ref: WorkflowEventEvidenceRef,
    expectedExecution: EvidenceExecutionContext,
  ): Promise<boolean>;
  mergeValidationFactExists(
    ref: MergeValidationEvidenceRef,
    expectedExecution: EvidenceExecutionContext,
  ): Promise<boolean>;
  isEvidenceFresh(evidence: SpecEvidenceRow): Promise<boolean>;
  routeStrategyInadequacy(input: StrategyInadequacy): Promise<void>;
  routeWaiverRequestToHuman(
    input: WaiverRequestInput,
  ): Promise<WaiverRequestReceipt>;
  getTaskClaimContext(
    executionId: string,
    taskElementId: string,
  ): Promise<TaskClaimContext | null>;
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

export interface TaskClaimContext {
  specId: string;
  revisionId: string;
  policy: SpecGatePolicy;
  draft: RevisionSnapshot;
  coveredCriterionElementIds: string[];
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

export interface AttachEvidenceInput {
  specId: string;
  criterionElementId: string;
  revisionId: string;
  kind: EvidenceKind;
  ref: EvidenceReference;
  evaluatedState: EvidenceEvaluatedState;
  producer: ActorProvenance;
  executionId: string;
  sourceEventId?: number;
}

export type ProofVerdictOrigin = "execution_ingest" | "ui_route";

export interface ProofVerdictInput {
  specId: string;
  criterionElementId: string;
  revisionId: string;
  executionId?: string;
  verdictKind: SpecProofVerdictKind;
  origin: ProofVerdictOrigin;
  actor: EvidenceMutationActor;
  evidenceIds: string[];
  validationStrategy?: ValidationStrategy;
  strategyAssessment?: { adequate: true } | { adequate: false; reason: string };
}

export interface TaskClaimInput {
  specId: string;
  taskElementId: string;
  executionId: string;
  actor: ActorProvenance;
  evidenceIds: string[];
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
  attachEvidence(
    input: AttachEvidenceInput,
  ): Promise<ServiceResult<SpecEvidenceRow>>;
  recordProofVerdict(
    input: ProofVerdictInput,
  ): Promise<ServiceResult<SpecProofVerdictRow>>;
  claimTaskComplete(
    input: TaskClaimInput,
  ): Promise<ServiceResult<SpecTaskClaimRow>>;
  reopenTaskClaim(
    claimId: string,
    actor: EvidenceMutationActor,
    changedIntentElementIds?: string[],
  ): Promise<ServiceResult<SpecTaskClaimRow>>;
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

function taskClaimLintFindings(
  context: TaskClaimContext,
  taskElementId: string,
  evidenceCriterionIds: Iterable<string>,
): Refusal["findings"] {
  const decision = claimTaskCompleteTransition({
    policy: context.policy,
    draft: context.draft,
    records: {
      evidence: [...evidenceCriterionIds].map((criterionElementId, index) => ({
        evidenceId: `claim-evidence-${index}`,
        criterionElementId,
      })),
      pendingTaskClaims: [{ taskElementId }],
    },
  });
  return decision.ok ? undefined : decision.refusal.findings;
}

function parseReference(evidence: SpecEvidenceRow): EvidenceReference | null {
  try {
    const ref = JSON.parse(evidence.ref_json) as unknown;
    if (typeof ref !== "object" || ref === null || !("type" in ref)) {
      return null;
    }
    return ref as EvidenceReference;
  } catch {
    return null;
  }
}

async function referenceResolves(
  deps: EvidenceServiceDeps,
  kind: EvidenceKind,
  ref: EvidenceReference,
  expectedExecutionId: string | null,
): Promise<boolean> {
  if (expectedExecutionId === null) return false;
  const execution = deps.repo.findExecutionById(expectedExecutionId);
  if (!execution) return false;
  const expectedExecution: EvidenceExecutionContext = {
    specExecutionId: execution.id,
    workflowExecutionId: execution.workflow_execution_id,
  };

  switch (kind) {
    case "commit":
      return (
        ref.type === "git_object" &&
        deps.gitObjectExists(ref, expectedExecution)
      );
    case "validator_verdict":
    case "test_run":
      if (ref.type === "workflow_event") {
        return (
          expectedExecution.workflowExecutionId !== null &&
          ref.workflowExecutionId === expectedExecution.workflowExecutionId &&
          deps.workflowEventExists(ref, expectedExecution)
        );
      }
      return (
        ref.type === "merge_validation" &&
        expectedExecution.workflowExecutionId !== null &&
        deps.mergeValidationFactExists(ref, expectedExecution)
      );
  }
}

function normalizedStrategy(strategy: ValidationStrategy): string {
  return stableStringify({
    kinds: [...new Set(strategy.kinds)].sort(),
    ...(strategy.note === undefined ? {} : { note: strategy.note }),
  });
}

function originIsAllowed(input: ProofVerdictInput): boolean {
  if (input.verdictKind === "human") {
    return input.origin === "ui_route";
  }
  return input.origin === "execution_ingest";
}

async function loadQualifiedEvidence(
  deps: EvidenceServiceDeps,
  input: ProofVerdictInput,
): Promise<
  | { ok: true; evidence: SpecEvidenceRow[] }
  | { ok: false; unresolvedIds: string[] }
> {
  const qualified: SpecEvidenceRow[] = [];
  const unresolvedIds: string[] = [];

  for (const evidenceId of input.evidenceIds) {
    const evidence = deps.repo.findEvidenceById(evidenceId);
    if (!evidence) {
      unresolvedIds.push(evidenceId);
      continue;
    }
    const ref = parseReference(evidence);
    if (
      !ref ||
      !(await referenceResolves(
        deps,
        evidence.kind,
        ref,
        evidence.execution_id,
      ))
    ) {
      unresolvedIds.push(evidenceId);
      continue;
    }
    if (
      evidence.spec_id !== input.specId ||
      evidence.revision_id !== input.revisionId ||
      evidence.criterion_element_id !== input.criterionElementId
    ) {
      continue;
    }
    if (await deps.isEvidenceFresh(evidence)) {
      qualified.push(evidence);
    }
  }

  if (unresolvedIds.length > 0) {
    return { ok: false, unresolvedIds };
  }
  return { ok: true, evidence: qualified };
}

export function createEvidenceService(
  deps: EvidenceServiceDeps,
): EvidenceService {
  return {
    async attachEvidence(input) {
      const criterion = await deps.getApprovedCriterion(
        input.revisionId,
        input.criterionElementId,
      );
      const execution = deps.repo.findExecutionById(input.executionId);
      if (!criterion || criterion.specId !== input.specId) {
        return refuse(
          "not_found",
          ["The criterion does not exist in the approved target revision."],
          "Attach evidence to a criterion in an approved revision.",
        );
      }
      if (
        !execution ||
        execution.spec_id !== input.specId ||
        execution.revision_id !== input.revisionId
      ) {
        return refuse(
          "validation",
          ["The producing execution does not pin the target spec revision."],
          "Attach evidence using the execution that produced it against this pinned revision.",
        );
      }

      if (
        !(await referenceResolves(
          deps,
          input.kind,
          input.ref,
          input.executionId,
        ))
      ) {
        logger.warn("specs.evidence.attach.refused", {
          code: "unresolvable_evidence",
          kind: input.kind,
          specId: input.specId,
          revisionId: input.revisionId,
          criterionElementId: input.criterionElementId,
        });
        return refuse(
          "unresolvable_evidence",
          [
            `${input.kind} evidence reference could not be resolved by the server.`,
          ],
          "Attach a reference to an object Command Center can resolve.",
        );
      }

      const occurredAt = deps.now();
      const evidence = deps.runInImmediateTransaction(() => {
        const persisted = deps.repo.insertEvidence({
          id: deps.nextId("evidence"),
          spec_id: input.specId,
          criterion_element_id: input.criterionElementId,
          revision_id: input.revisionId,
          kind: input.kind,
          ref_json: stableStringify(input.ref),
          evaluated_state_json: stableStringify(input.evaluatedState),
          producer_json: stableStringify(input.producer),
          execution_id: input.executionId,
          source_event_id: input.sourceEventId ?? null,
          created_at: occurredAt,
        });
        deps.recordMutation({
          specId: input.specId,
          actor: input.producer,
          occurredAt,
          kind: "evidence-attached",
          sse: {
            revisionId: input.revisionId,
            criterionId: input.criterionElementId,
            executionId: input.executionId,
          },
          payload: {
            evidenceId: persisted.id,
            criterionElementId: input.criterionElementId,
            revisionId: input.revisionId,
            executionId: input.executionId,
            measureEvents: [
              {
                kind: "evidence-attached",
                evidenceId: persisted.id,
                criterionId: input.criterionElementId,
                revisionId: input.revisionId,
                evidenceKind: persisted.kind,
                source:
                  input.sourceEventId !== undefined ||
                  input.ref.type === "merge_validation"
                    ? "execution_ingest"
                    : "manual",
                ...(input.evaluatedState.commitSha === undefined
                  ? {}
                  : {
                      evaluatedCommitSha: input.evaluatedState.commitSha,
                    }),
              },
            ],
          },
        });
        return persisted;
      });
      logger.info("specs.evidence.attach.persisted", {
        evidenceId: evidence.id,
        kind: evidence.kind,
        specId: evidence.spec_id,
        revisionId: evidence.revision_id,
        criterionElementId: evidence.criterion_element_id,
        executionId: evidence.execution_id,
      });
      return { ok: true, value: evidence };
    },

    async recordProofVerdict(input) {
      if (!originIsAllowed(input)) {
        logger.warn("specs.proof-verdict.record.refused", {
          code: "human_act_required",
          verdictKind: input.verdictKind,
          origin: input.origin,
          criterionElementId: input.criterionElementId,
        });
        return refuse(
          "human_act_required",
          [
            input.verdictKind === "human"
              ? "Human proof verdicts have no recording surface."
              : "Validator proof verdicts originate only from execution ingestion.",
          ],
          input.verdictKind === "human"
            ? "Waive the criterion instead: Spec Studio → Controls → Merge gate → Waive…, which records a human decision with a reason."
            : "Ingest the validator result from the linked execution.",
        );
      }

      const producingExecution = input.executionId
        ? deps.repo.findExecutionById(input.executionId)
        : null;
      if (
        input.verdictKind !== "human" &&
        (!producingExecution ||
          producingExecution.spec_id !== input.specId ||
          producingExecution.revision_id !== input.revisionId ||
          producingExecution.workflow_execution_id === null)
      ) {
        return refuse(
          "validation",
          [
            "Machine proof verdicts require a producing execution pinned to the target spec revision.",
          ],
          "Ingest the validator verdict from the linked execution that pins this revision.",
        );
      }
      if (
        input.verdictKind === "human" &&
        input.executionId !== undefined &&
        (!producingExecution ||
          producingExecution.spec_id !== input.specId ||
          producingExecution.revision_id !== input.revisionId)
      ) {
        return refuse(
          "validation",
          [
            "The proof verdict execution does not pin the target spec revision.",
          ],
          "Record the verdict without an execution or select the execution that pins this revision.",
        );
      }

      const criterion = await deps.getApprovedCriterion(
        input.revisionId,
        input.criterionElementId,
      );
      if (!criterion || criterion.specId !== input.specId) {
        return refuse(
          "not_found",
          ["The criterion does not exist in the approved revision."],
          "Target a criterion from the approved pinned revision.",
        );
      }

      if (
        input.validationStrategy &&
        normalizedStrategy(input.validationStrategy) !==
          normalizedStrategy(criterion.validationStrategy)
      ) {
        logger.warn("specs.proof-verdict.record.refused", {
          code: "amendment_required",
          criterionElementId: input.criterionElementId,
          revisionId: input.revisionId,
        });
        return refuse(
          "amendment_required",
          [
            "The proposed validation strategy differs from the approved revision.",
          ],
          "Create and approve a new spec revision before validating against a changed strategy.",
        );
      }

      if (input.strategyAssessment?.adequate === false) {
        await deps.routeStrategyInadequacy({
          specId: input.specId,
          revisionId: input.revisionId,
          criterionElementId: input.criterionElementId,
          reason: input.strategyAssessment.reason,
        });
        logger.warn("specs.proof-verdict.strategy_inadequacy.routed", {
          specId: input.specId,
          revisionId: input.revisionId,
          criterionElementId: input.criterionElementId,
        });
        return refuse(
          "validation",
          ["The approved validation strategy was reported as inadequate."],
          "Review the routed finding and amend the strategy if the human agrees.",
        );
      }

      const loaded = await loadQualifiedEvidence(deps, input);
      if (!loaded.ok) {
        return refuse(
          "unresolvable_evidence",
          loaded.unresolvedIds.map(
            (id) => `Evidence ${id} could not be resolved by the server.`,
          ),
          "Attach references to objects Command Center can resolve and record the verdict again.",
        );
      }

      const presentKinds = new Set(loaded.evidence.map((item) => item.kind));
      const missingKinds = [
        ...new Set(criterion.validationStrategy.kinds),
      ].filter((kind) => !presentKinds.has(kind));
      if (missingKinds.length > 0) {
        logger.warn("specs.proof-verdict.record.refused", {
          code: "validation",
          criterionElementId: input.criterionElementId,
          missingKinds,
        });
        return refuse(
          "validation",
          missingKinds.map(
            (kind) =>
              `The approved validation strategy requires fresh, resolvable ${kind} evidence.`,
          ),
          "Attach fresh, resolvable evidence for every kind in the approved validation strategy.",
        );
      }

      const occurredAt = deps.now();
      const verdict = deps.runInImmediateTransaction(() => {
        const persisted: SpecProofVerdictRow = {
          id: deps.nextId("verdict"),
          spec_id: input.specId,
          criterion_element_id: input.criterionElementId,
          revision_id: input.revisionId,
          execution_id: input.executionId ?? null,
          verdict_kind: input.verdictKind,
          evidence_ids_json: stableStringify(input.evidenceIds),
          verdict_at: occurredAt,
          stale_at: null,
          stale_reason: null,
        };
        deps.repo.saveProofVerdict(persisted);
        deps.recordMutation({
          specId: input.specId,
          actor: input.actor,
          occurredAt,
          kind: "proof-verdict-recorded",
          sse: {
            revisionId: input.revisionId,
            criterionId: input.criterionElementId,
            ...(typeof input.executionId === "string"
              ? { executionId: input.executionId }
              : {}),
          },
          payload: {
            verdictId: persisted.id,
            criterionElementId: input.criterionElementId,
            revisionId: input.revisionId,
            executionId: input.executionId ?? null,
            verdictKind: input.verdictKind,
            measureEvents: [
              {
                kind: "proof-verdict-recorded",
                verdictId: persisted.id,
                criterionId: input.criterionElementId,
                revisionId: input.revisionId,
                evidenceIds: input.evidenceIds,
                valid: persisted.stale_at === null,
              },
            ],
          },
        });
        return persisted;
      });
      logger.info("specs.proof-verdict.record.persisted", {
        verdictId: verdict.id,
        verdictKind: verdict.verdict_kind,
        specId: verdict.spec_id,
        revisionId: verdict.revision_id,
        criterionElementId: verdict.criterion_element_id,
        executionId: verdict.execution_id,
        evidenceCount: input.evidenceIds.length,
      });
      return { ok: true, value: verdict };
    },

    async claimTaskComplete(input) {
      // A refused claim is a server enforcement intervention: it must land in
      // the durable event log so release evidence can count refusals (21.4).
      const refuseClaim = (
        code: Refusal["code"],
        unmetConditions: string[],
        instruction: string,
        findings?: Refusal["findings"],
      ): ServiceResult<never> => {
        deps.recordMutation({
          specId: input.specId,
          actor: input.actor,
          occurredAt: deps.now(),
          kind: "transition-refused",
          payload: {
            surface: "task_claim",
            code,
            unmetConditions,
            instruction,
            taskElementId: input.taskElementId,
            executionId: input.executionId,
            ...(findings === undefined ? {} : { findings }),
          },
        });
        return refuse(code, unmetConditions, instruction, findings);
      };

      await deps.ingestExecutionEvidence(input.executionId);
      const context = await deps.getTaskClaimContext(
        input.executionId,
        input.taskElementId,
      );
      if (!context || context.specId !== input.specId) {
        return refuseClaim(
          "not_found",
          ["The task does not exist in the execution's pinned revision."],
          "Claim a task from the execution's pinned revision.",
        );
      }

      if (isExploratoryShippingRefused(context.policy)) {
        return refuseClaim(
          "gate_blocked",
          ["Exploratory specs cannot record task completion claims."],
          "Switch the spec to a shipping-capable preset through a human-confirmed policy change.",
        );
      }

      if (input.evidenceIds.length === 0) {
        return refuseClaim(
          "lint_blocked",
          ["A task completion claim must cite evidence."],
          "Cite ingested evidence ids for the task's covered criteria — the server ingests commit and validation evidence from workflow events — and claim again.",
          taskClaimLintFindings(context, input.taskElementId, []),
        );
      }

      const coveredCriteria = new Set(context.coveredCriterionElementIds);
      const citedCriteria = new Set<string>();
      for (const evidenceId of input.evidenceIds) {
        const evidence = deps.repo.findEvidenceById(evidenceId);
        const ref = evidence ? parseReference(evidence) : null;
        if (
          !evidence ||
          !ref ||
          !(await referenceResolves(
            deps,
            evidence.kind,
            ref,
            evidence.execution_id,
          ))
        ) {
          return refuseClaim(
            "unresolvable_evidence",
            [`Evidence ${evidenceId} could not be resolved by the server.`],
            "Cite an evidence id the server has already ingested for this execution and claim again.",
          );
        }
        if (
          evidence.spec_id !== input.specId ||
          evidence.revision_id !== context.revisionId
        ) {
          return refuseClaim(
            "validation",
            [
              `Evidence ${evidenceId} does not target the execution's pinned revision ${context.revisionId}.`,
            ],
            "Cite evidence attached to the task's covered criteria at the pinned revision.",
          );
        }
        if (!coveredCriteria.has(evidence.criterion_element_id)) {
          return refuseClaim(
            "validation",
            [
              `Evidence ${evidenceId} targets criterion ${evidence.criterion_element_id}, which task ${input.taskElementId} does not cover at revision ${context.revisionId}.`,
            ],
            "Cite evidence only for criteria the task covers at the pinned revision.",
          );
        }
        citedCriteria.add(evidence.criterion_element_id);
      }

      const uncoveredCriteria = context.coveredCriterionElementIds.filter(
        (criterionId) => !citedCriteria.has(criterionId),
      );
      if (uncoveredCriteria.length > 0) {
        return refuseClaim(
          "lint_blocked",
          uncoveredCriteria.map(
            (criterionId) =>
              `Covered criterion ${criterionId} has no cited evidence.`,
          ),
          "Cite ingested evidence for every covered criterion and claim again — a criterion with no evidence usually means its covering work has not been committed or validated yet.",
          taskClaimLintFindings(context, input.taskElementId, citedCriteria),
        );
      }

      const occurredAt = deps.now();
      const claim = deps.runInImmediateTransaction(() => {
        const persisted: SpecTaskClaimRow = {
          id: deps.nextId("claim"),
          spec_id: input.specId,
          task_element_id: input.taskElementId,
          execution_id: input.executionId,
          actor_json: stableStringify(input.actor),
          evidence_ids_json: stableStringify(input.evidenceIds),
          claimed_at: occurredAt,
          status: "accepted",
        };
        deps.repo.saveTaskClaim(persisted);
        deps.recordMutation({
          specId: input.specId,
          actor: input.actor,
          occurredAt,
          kind: "task-claim-accepted",
          payload: {
            claimId: persisted.id,
            taskElementId: input.taskElementId,
            executionId: input.executionId,
            evidenceIds: input.evidenceIds,
          },
          sse: {
            revisionId: context.revisionId,
            taskId: input.taskElementId,
            executionId: input.executionId,
          },
        });
        return persisted;
      });
      logger.info("specs.task-claim.accepted", {
        claimId: claim.id,
        specId: claim.spec_id,
        taskElementId: claim.task_element_id,
        executionId: claim.execution_id,
        evidenceCount: input.evidenceIds.length,
      });
      return { ok: true, value: claim };
    },

    async reopenTaskClaim(claimId, actor, changedIntentElementIds = []) {
      const claim = deps.repo.findTaskClaimById(claimId);
      if (!claim) {
        return refuse(
          "not_found",
          [`Task claim ${claimId} does not exist.`],
          "Reopen an existing accepted task claim.",
        );
      }
      const occurredAt = deps.now();
      const claimExecution =
        claim.execution_id === null
          ? null
          : deps.repo.findExecutionById(claim.execution_id);
      const reopened = deps.runInImmediateTransaction(() => {
        const persisted: SpecTaskClaimRow = {
          ...claim,
          status: "reopened",
        };
        deps.repo.saveTaskClaim(persisted);
        deps.recordMutation({
          specId: claim.spec_id,
          actor,
          occurredAt,
          kind: "task-claim-reopened",
          payload: {
            claimId,
            taskElementId: claim.task_element_id,
            executionId: claim.execution_id,
            measureEvents: [
              {
                kind: "task-claim-reopened",
                claimId,
                taskId: claim.task_element_id,
                changedIntentElementIds: [...changedIntentElementIds].sort(),
              },
            ],
          },
          ...(claimExecution === null
            ? {}
            : {
                sse: {
                  revisionId: claimExecution.revision_id,
                  taskId: claim.task_element_id,
                  executionId: claimExecution.id,
                },
              }),
        });
        return persisted;
      });
      logger.info("specs.task-claim.reopened", {
        claimId,
        specId: claim.spec_id,
        taskElementId: claim.task_element_id,
        executionId: claim.execution_id,
        changedIntentElementCount: changedIntentElementIds.length,
      });
      return { ok: true, value: reopened };
    },

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
