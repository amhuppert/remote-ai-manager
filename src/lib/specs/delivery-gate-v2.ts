import {
  criterionRecordsOf,
  type GraphWorkflowExecution,
} from "@/lib/workflow-graph/spec-bridge";
import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type {
  AuthoredContextOutcome,
  IntegrationReadyFinalCandidateOutcome,
} from "@/lib/workflow-graph/authored-context-outcome";
import type {
  CriterionOutcome,
  DeliveryGateEvaluation,
  DeliveryGateEvaluator,
  DeliveryGateSpecPresentation,
} from "@/lib/workflows/merge/types";
import { elementHandleInSnapshot } from "./review-state";
import { exclusionDispositionFromDeliveryPlan } from "./delivery-plan";
import type { SpecExecutionBindingPort } from "./execution-binding-service";
import type { SpecEventsPublisher } from "./events";
import { resolveDial } from "./policy";
import {
  recordPolicyGateAdmissionInTransaction,
  type SpecExecutionGateAdmissionNotifier,
} from "./policy-admissions";
import type {
  LinkedSpecExecutionBindingV2,
  SpecExecutionBindingSnapshotV2,
} from "./execution-binding";
import type {
  Spec,
  SpecExecutionRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import {
  evaluateDeliveryGate,
  type DeliveryCriterionSnapshot,
  type TransitionRefusal,
} from "./transitions";
import { isWaiverValidForExecution } from "./waiver-staleness";

const logger = createLogger("specs.delivery-gate-v2");

const ACTIVE_RECOVERY_INSTRUCTION =
  "Resume or repair the active graph execution until the named claimant is recertified, obtain any required Studio waiver, then retry delivery from its final integrated candidate.";
const ARCHIVED_RECOVERY_INSTRUCTION =
  "The claimant belongs to an archived graph execution and cannot be recertified in place. Obtain a current-revision Studio waiver for the refused criterion, or abandon the current spec execution and start a replacement delivery execution, then retry Merge.";
const RETRY_INSTRUCTION =
  "Repair the current graph execution or delivery binding, obtain any required Studio waiver, then retry delivery from a final integrated candidate.";

export interface GraphDeliveryOutcomePort {
  getAuthoredContextOutcome(
    executionId: string,
    authoredContextId: string,
  ): Promise<AuthoredContextOutcome>;
  getIntegrationReadyFinalCandidate(
    executionId: string,
    requiredAuthoredContextIds: readonly string[],
  ): Promise<IntegrationReadyFinalCandidateOutcome>;
}

export interface DeliveryGateIntervention {
  specId: string;
  actor: { kind: "system" };
  occurredAt: string;
  kind: "transition-refused";
  payload: Record<string, unknown>;
}

export interface DeliveryGateDeps {
  findWorkflowExecution?(executionId: string): GraphWorkflowExecution | null;
  bindingPort: SpecExecutionBindingPort;
  outcomePort: GraphDeliveryOutcomePort;
  deliveryRepo: Pick<
    SpecDeliveryRepo,
    | "findExecutionById"
    | "findWaiverForCriterionRevision"
    | "saveDeliveryVerdict"
  >;
  reviewRepo: Pick<
    SpecReviewRepo,
    | "hasValidHumanGateApproval"
    | "insertGateAdmission"
    | "findGateAdmissionsByRevision"
  >;
  specsRepo: Pick<SpecsRepo, "findById" | "getRevisionSnapshot">;
  /** The open approval requests a policy admission answers (#108). */
  attention: Pick<SpecEventsRepo, "listOpenApprovalRequests">;
  newVerdictId(): string;
  newAdmissionId(): string;
  events: SpecEventsPublisher;
  writeQueue: Pick<WriteQueue, "withWriteQueue">;
  runInImmediateTransaction<T>(fn: () => T): T;
  policyNotifier?: SpecExecutionGateAdmissionNotifier;
  recordIntervention(input: DeliveryGateIntervention): void;
  requestDeliveryApproval(input: {
    specId: string;
    revisionId: string;
    workflowExecutionId: string;
  }): Promise<void>;
  getProjectDisplayName(projectPath: string): string;
  now(): string;
}

interface CriterionContract {
  id: string;
  handle: string;
}

interface EvaluatedCriterion {
  contract: CriterionContract;
  outcome: CriterionOutcome;
  state: DeliveryCriterionSnapshot;
  satisfyingContextId: string | null;
  claimantOutcomes: LocatedClaimantOutcome[];
}

interface LocatedClaimantOutcome {
  contextId: string;
  outcome: AuthoredContextOutcome;
  failureDetails?: readonly string[];
}

function coveredFailureDetails(
  execution: GraphWorkflowExecution | null,
  contextId: string,
  criterionId: string,
): string[] {
  const context = execution?.launchDocument?.definition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  const round = execution?.contextStates[contextId]?.validationRound;
  if (!context || round?.phase !== "concluded" || round.outcome !== "failed")
    return [];
  const recordIds = new Set(
    criterionRecordsOf(context.acceptanceCriteria)
      .filter((record) => record.covers?.includes(criterionId))
      .map((record) => record.id),
  );
  return Object.values(round.specialists)
    .filter((specialist) => specialist.state === "verdict_fail")
    .flatMap((specialist) =>
      specialist.issues.flatMap((issue) =>
        issue.criterionId !== undefined && recordIds.has(issue.criterionId)
          ? [`${issue.criterionId}: ${issue.title} — ${issue.description}`]
          : [],
      ),
    );
}

export function createDeliveryGate(
  deps: DeliveryGateDeps,
): DeliveryGateEvaluator {
  return {
    async evaluate(input) {
      const linked = deps.bindingPort.resolveByWorkflowExecutionId(
        input.workflowExecutionId,
      );
      if (linked === null) {
        logger.debug("specs.delivery-gate-v2.pass-through", {
          workflowExecutionId: input.workflowExecutionId,
        });
        return { status: "pass", satisfied: [], deferred: [] };
      }

      const execution = deps.deliveryRepo.findExecutionById(
        linked.specExecutionId,
      );
      const evaluation = await evaluateLinkedExecution(
        deps,
        linked,
        execution,
        input,
      );
      if (evaluation.status === "refused") {
        deps.recordIntervention({
          specId: execution?.spec_id ?? linked.specExecutionId,
          actor: { kind: "system" },
          occurredAt: deps.now(),
          kind: "transition-refused",
          payload: {
            surface: "delivery_gate",
            code: "delivery_gate_failed",
            executionId: linked.specExecutionId,
            workflowExecutionId: input.workflowExecutionId,
            preparedSha: input.preparedSha,
            unmet: evaluation.unmet,
            instruction: evaluation.instruction,
          },
        });
      }
      return evaluation;
    },
  };
}

async function evaluateLinkedExecution(
  deps: DeliveryGateDeps,
  linked: LinkedSpecExecutionBindingV2,
  execution: SpecExecutionRow | null,
  input: Parameters<DeliveryGateEvaluator["evaluate"]>[0],
): Promise<DeliveryGateEvaluation> {
  if (
    execution === null ||
    execution.id !== linked.specExecutionId ||
    execution.workflow_execution_id !== input.workflowExecutionId ||
    linked.workflowExecutionId !== input.workflowExecutionId ||
    execution.revision_id !== linked.binding.pinnedRevisionId
  ) {
    return invalidBindingState(
      linked,
      "The current workflow execution's typed spec link or frozen binding does not match its persisted execution identity.",
    );
  }

  const [spec, snapshot] = await Promise.all([
    deps.specsRepo.findById(execution.spec_id),
    deps.specsRepo.getRevisionSnapshot(linked.binding.pinnedRevisionId),
  ]);
  if (
    spec === null ||
    snapshot === null ||
    spec.projectPath !== input.projectPath ||
    snapshot.revision.id !== linked.binding.pinnedRevisionId ||
    snapshot.revision.specId !== execution.spec_id
  ) {
    return invalidBindingState(
      linked,
      "The current execution's pinned spec state is unavailable for this merge project.",
    );
  }

  const contracts = criterionContracts(snapshot);
  const scope = executionScope(linked.binding);
  const deliveryApprovalGranted = deps.reviewRepo.hasValidHumanGateApproval({
    specId: execution.spec_id,
    revisionId: linked.binding.pinnedRevisionId,
    executionId: execution.id,
    gate: "delivery",
  });
  const specPresentation: DeliveryGateSpecPresentation = {
    specSlug: spec.slug,
    specName: spec.name,
    projectName: deps.getProjectDisplayName(spec.projectPath),
  };
  const policyDecision = evaluateDeliveryGate({
    policy: spec.gatePolicy,
    executionState: execution.state,
    pinnedRevisionId: linked.binding.pinnedRevisionId,
    pinnedScope: scope,
    deliveryApprovalGranted,
    criteria: scope.selectedCriterionIds.map((criterionId) => ({
      criterionId,
      handle: contracts.get(criterionId)?.handle ?? criterionId,
      validProof: true,
      waiver: null,
      deliveredByMergedExecution: false,
    })),
  });
  if (!policyDecision.ok) {
    await requestApprovalForRefusal(
      deps,
      execution,
      input.workflowExecutionId,
      policyDecision.refusal,
    );
    return refusedByTransition(
      execution,
      specPresentation,
      policyDecision.refusal,
    );
  }

  const claimsByCriterion = claimantIdsByCriterion(linked.binding);
  let failureExecution: GraphWorkflowExecution | null = null;
  try {
    failureExecution =
      deps.findWorkflowExecution?.(input.workflowExecutionId) ?? null;
  } catch (error) {
    logger.warn("specs.delivery-gate-v2.failure_details_unavailable", {
      workflowExecutionId: input.workflowExecutionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info("specs.delivery-gate-v2.evaluation-started", {
    specExecutionId: execution.id,
    workflowExecutionId: input.workflowExecutionId,
    candidateId: linked.binding.candidateId,
    selectedCriterionCount: scope.selectedCriterionIds.length,
    claimantCount: new Set(
      scope.selectedCriterionIds.flatMap(
        (criterionId) => claimsByCriterion.get(criterionId) ?? [],
      ),
    ).size,
  });

  const evaluated: EvaluatedCriterion[] = [];
  for (const criterionId of scope.selectedCriterionIds) {
    const contract = contracts.get(criterionId) ?? {
      id: criterionId,
      handle: criterionId,
    };
    const claimantIds = claimsByCriterion.get(criterionId) ?? [];
    const claimantOutcomes = await Promise.all(
      claimantIds.map(async (contextId) => ({
        contextId,
        failureDetails: coveredFailureDetails(
          failureExecution,
          contextId,
          criterionId,
        ),
        outcome: await deps.outcomePort.getAuthoredContextOutcome(
          input.workflowExecutionId,
          contextId,
        ),
      })),
    );
    const satisfyingContextId =
      claimantOutcomes.find(({ outcome }) => outcome.status === "satisfied")
        ?.contextId ?? null;
    const waiver =
      satisfyingContextId === null
        ? validWaiverForCriterion(deps, execution, criterionId)
        : null;
    const outcome =
      satisfyingContextId !== null
        ? satisfiedOutcome(
            contract,
            "satisfied",
            `Authored context ${satisfyingContextId} is satisfied in the current graph execution.`,
          )
        : waiver !== null
          ? satisfiedOutcome(
              contract,
              "waived",
              `Studio waiver ${waiver.id} is valid for the current pinned revision.`,
            )
          : unmetClaimantOutcome(contract, claimantOutcomes);
    evaluated.push({
      contract,
      outcome,
      satisfyingContextId,
      claimantOutcomes,
      state: {
        criterionId,
        handle: contract.handle,
        validProof: satisfyingContextId !== null,
        waiver:
          waiver === null
            ? null
            : {
                revisionId: waiver.revision_id,
                grantedByHuman: true,
                reason: waiver.reason,
                stale: waiver.stale === 1,
              },
        deliveredByMergedExecution: false,
      },
    });
  }

  const requiredContextIds = evaluated.flatMap((criterion) =>
    criterion.satisfyingContextId === null
      ? []
      : [criterion.satisfyingContextId],
  );
  const finalCandidate =
    await deps.outcomePort.getIntegrationReadyFinalCandidate(
      input.workflowExecutionId,
      requiredContextIds,
    );
  if (finalCandidate.status !== "satisfied") {
    const integrationOutcome: CriterionOutcome = {
      criterionId: execution.id,
      criterionHandle: spec.slug,
      outcome: "integration_failed",
      reason: `The current graph execution has no integration-ready final candidate (${finalCandidate.reason}).`,
    };
    logger.warn("specs.delivery-gate-v2.integration-refused", {
      specExecutionId: execution.id,
      workflowExecutionId: input.workflowExecutionId,
      candidateId: linked.binding.candidateId,
      finalCandidateStatus: finalCandidate.status,
      finalCandidateReason: finalCandidate.reason,
    });
    return refusedByTransition(
      execution,
      specPresentation,
      deliveryRefusal(
        [integrationOutcome.reason ?? RETRY_INSTRUCTION],
        finalCandidate.executionLocation === "archived"
          ? ARCHIVED_RECOVERY_INSTRUCTION
          : ACTIVE_RECOVERY_INSTRUCTION,
      ),
      [
        ...evaluated
          .filter(
            (criterion) =>
              !criterion.state.validProof && criterion.state.waiver === null,
          )
          .map((criterion) => criterion.outcome),
        integrationOutcome,
      ],
    );
  }

  await recordVerdicts(deps, linked, evaluated);

  const outcomeDecision = evaluateDeliveryGate({
    policy: spec.gatePolicy,
    executionState: execution.state,
    pinnedRevisionId: linked.binding.pinnedRevisionId,
    pinnedScope: scope,
    deliveryApprovalGranted,
    criteria: evaluated.map((criterion) => criterion.state),
  });
  if (!outcomeDecision.ok) {
    const unmet = evaluated
      .filter(
        (criterion) =>
          !criterion.state.validProof && criterion.state.waiver === null,
      )
      .map((criterion) => criterion.outcome);
    logger.warn("specs.delivery-gate-v2.claimants-refused", {
      specExecutionId: execution.id,
      workflowExecutionId: input.workflowExecutionId,
      candidateId: linked.binding.candidateId,
      unmetCriterionCount: unmet.length,
      claimantContextIds: evaluated.flatMap((criterion) =>
        criterion.state.validProof || criterion.state.waiver !== null
          ? []
          : criterion.claimantOutcomes.map(({ contextId }) => contextId),
      ),
    });
    return refusedByTransition(
      execution,
      specPresentation,
      {
        ...outcomeDecision.refusal,
        instruction: recoveryInstructionForClaimants(evaluated),
      },
      unmet,
    );
  }

  await recordPolicyDeliveryAdmission(deps, spec, execution);
  const satisfied = evaluated.map((criterion) => criterion.outcome);
  const deferred = linked.binding.dispositions.flatMap((disposition) =>
    disposition.disposition === "deferred"
      ? [
          contracts.get(disposition.criterionElementId)?.handle ??
            disposition.criterionElementId,
        ]
      : [],
  );
  logger.info("specs.delivery-gate-v2.passed", {
    specExecutionId: execution.id,
    workflowExecutionId: input.workflowExecutionId,
    candidateId: linked.binding.candidateId,
    candidateHash: linked.binding.candidateHash,
    satisfiedCriterionCount: satisfied.length,
    verdictCount: evaluated.filter(
      (criterion) => criterion.satisfyingContextId !== null,
    ).length,
    waivedCriterionCount: evaluated.filter(
      (criterion) => criterion.outcome.outcome === "waived",
    ).length,
    deferredCriterionCount: deferred.length,
  });
  return { status: "pass", satisfied, deferred };
}

function executionScope(
  binding: SpecExecutionBindingSnapshotV2,
): ExecutionScope {
  return {
    selectedTaskIds: [],
    selectedCriterionIds: binding.dispositions.flatMap((disposition) =>
      disposition.disposition === "in_scope"
        ? [disposition.criterionElementId]
        : [],
    ),
    exclusionDispositions: binding.dispositions.flatMap((disposition) =>
      disposition.disposition === "in_scope"
        ? []
        : [
            {
              criterionId: disposition.criterionElementId,
              disposition: exclusionDispositionFromDeliveryPlan(
                disposition.disposition,
              ),
            },
          ],
    ),
  };
}

function claimantIdsByCriterion(
  binding: SpecExecutionBindingSnapshotV2,
): Map<string, string[]> {
  const claimants = new Map<string, string[]>();
  for (const claim of binding.claims) {
    for (const criterionId of claim.criterionElementIds) {
      const contextIds = claimants.get(criterionId) ?? [];
      if (!contextIds.includes(claim.contextId)) {
        contextIds.push(claim.contextId);
      }
      claimants.set(criterionId, contextIds);
    }
  }
  return claimants;
}

function criterionContracts(
  snapshot: SpecRevisionSnapshot,
): Map<string, CriterionContract> {
  return new Map(
    snapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "criterion"
        ? [
            [
              element.id,
              {
                id: element.id,
                handle:
                  elementHandleInSnapshot(snapshot, element.id) ?? element.id,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

function validWaiverForCriterion(
  deps: DeliveryGateDeps,
  execution: SpecExecutionRow,
  criterionId: string,
): SpecWaiverRow | null {
  const waiver = deps.deliveryRepo.findWaiverForCriterionRevision(
    criterionId,
    execution.revision_id,
  );
  return isWaiverValidForExecution(waiver, execution, criterionId)
    ? waiver
    : null;
}

function unmetClaimantOutcome(
  contract: CriterionContract,
  claimantOutcomes: readonly LocatedClaimantOutcome[],
): CriterionOutcome {
  const outcomes = claimantOutcomes.map(({ outcome }) => outcome);
  const counts = { pending: 0, skipped: 0, failed: 0, satisfied: 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  const outcome =
    outcomes.length === 0
      ? "missing_claimant"
      : counts.pending > 0
        ? "pending"
        : counts.failed > 0
          ? "failed"
          : "skipped";
  return {
    criterionId: contract.id,
    criterionHandle: contract.handle,
    outcome,
    reason:
      outcomes.length === 0
        ? "The frozen binding has no authored claimant for this selected criterion."
        : `No authored claimant is satisfied in the current execution (pending=${counts.pending}, skipped=${counts.skipped}, failed=${counts.failed}). Claimants: ${claimantOutcomes
            .map(
              (claimant) =>
                `${describeClaimantOutcome(claimant)}${claimant.outcome.status === "failed" && claimant.failureDetails?.length ? `; ${claimant.failureDetails.join("; ")}` : ""}`,
            )
            .join("; ")}.`,
  };
}

function describeClaimantOutcome({
  contextId,
  outcome,
}: LocatedClaimantOutcome): string {
  if (
    outcome.status === "failed" &&
    outcome.reason === "validation_gate_failed" &&
    outcome.validation !== undefined
  ) {
    const round = outcome.validation.round;
    if (round === null) {
      return `${contextId} failed validation_gate_failed (required validation round is absent)`;
    }
    if (round.phase === "concluded") {
      return `${contextId} failed validation_gate_failed (validation round ${round.seq} is concluded with outcome ${round.outcome ?? "null"})`;
    }
    return `${contextId} failed validation_gate_failed (validation round ${round.seq} is open in phase ${round.phase} with outcome ${round.outcome ?? "null"})`;
  }
  return `${contextId} ${outcome.status} ${outcome.reason}`;
}

function recoveryInstructionForClaimants(
  evaluated: readonly EvaluatedCriterion[],
): string {
  const unmetClaimants = evaluated.flatMap((criterion) =>
    criterion.state.validProof || criterion.state.waiver !== null
      ? []
      : criterion.claimantOutcomes,
  );
  if (unmetClaimants.length === 0) return RETRY_INSTRUCTION;
  return unmetClaimants.some(
    ({ outcome }) => outcome.executionLocation === "archived",
  )
    ? ARCHIVED_RECOVERY_INSTRUCTION
    : ACTIVE_RECOVERY_INSTRUCTION;
}

function satisfiedOutcome(
  contract: CriterionContract,
  outcome: "satisfied" | "waived",
  reason: string,
): CriterionOutcome {
  return {
    criterionId: contract.id,
    criterionHandle: contract.handle,
    outcome,
    reason,
  };
}

async function recordVerdicts(
  deps: DeliveryGateDeps,
  linked: LinkedSpecExecutionBindingV2,
  evaluated: readonly EvaluatedCriterion[],
): Promise<void> {
  const satisfied = evaluated.filter(
    (
      criterion,
    ): criterion is EvaluatedCriterion & { satisfyingContextId: string } =>
      criterion.satisfyingContextId !== null,
  );
  if (satisfied.length === 0) return;
  await deps.writeQueue.withWriteQueue(
    `spec-delivery-verdicts[${linked.specExecutionId}]`,
    async () => {
      deps.runInImmediateTransaction(() => {
        for (const criterion of satisfied) {
          deps.deliveryRepo.saveDeliveryVerdict({
            id: deps.newVerdictId(),
            specExecutionId: linked.specExecutionId,
            workflowExecutionId: linked.workflowExecutionId,
            candidateId: linked.binding.candidateId,
            candidateHash: linked.binding.candidateHash,
            criterionElementId: criterion.contract.id,
            satisfyingContextId: criterion.satisfyingContextId,
            recordedAt: deps.now(),
          });
        }
      });
    },
  );
}

async function recordPolicyDeliveryAdmission(
  deps: DeliveryGateDeps,
  spec: Spec,
  execution: SpecExecutionRow,
): Promise<void> {
  const dial = resolveDial(spec.gatePolicy, "delivery");
  if (dial !== "notify" && dial !== "off") return;
  await deps.writeQueue.withWriteQueue(
    `spec-delivery-admission[${execution.id}]`,
    async () => {
      const recorded = deps.runInImmediateTransaction(() =>
        recordPolicyGateAdmissionInTransaction(
          {
            reviewRepo: deps.reviewRepo,
            attention: deps.attention,
            events: deps.events,
            newAdmissionId: deps.newAdmissionId,
            now: deps.now,
          },
          { spec, gate: "delivery", execution },
        ),
      );
      if (recorded === null) return;
      for (const prepared of recorded.prepared) {
        deps.events.publishAfterCommit(prepared);
      }
      if (recorded.notice !== null) {
        deps.policyNotifier?.policyAdmitted(recorded.notice);
      }
      if (recorded.requestsClosed !== null) {
        deps.policyNotifier?.approvalRequestsClosed(recorded.requestsClosed);
      }
    },
  );
}

async function requestApprovalForRefusal(
  deps: DeliveryGateDeps,
  execution: SpecExecutionRow,
  workflowExecutionId: string,
  refusal: TransitionRefusal,
): Promise<void> {
  if (refusal.reason !== "approval_required") return;
  try {
    await deps.requestDeliveryApproval({
      specId: execution.spec_id,
      revisionId: execution.revision_id,
      workflowExecutionId,
    });
  } catch (error) {
    logger.warn("specs.delivery-gate-v2.approval-request-failed", {
      specExecutionId: execution.id,
      workflowExecutionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function deliveryRefusal(
  unmetConditions: string[],
  instruction: string = RETRY_INSTRUCTION,
): TransitionRefusal {
  return {
    code: "delivery_gate_failed",
    unmetConditions,
    instruction,
  };
}

function refusedByTransition(
  execution: SpecExecutionRow,
  spec: DeliveryGateSpecPresentation,
  refusal: TransitionRefusal,
  criterionOutcomes: CriterionOutcome[] = [],
): DeliveryGateEvaluation {
  const unmet =
    refusal.code === "delivery_gate_failed" && criterionOutcomes.length > 0
      ? criterionOutcomes
      : refusal.unmetConditions.map((reason, index) => ({
          criterionId: `${execution.id}:gate:${index + 1}`,
          criterionHandle: spec.specSlug,
          outcome: refusal.code,
          reason,
        }));
  return {
    status: "refused",
    unmet,
    instruction: refusal.instruction,
    ...(refusal.reason === "approval_required"
      ? { refusalCode: refusal.reason }
      : {}),
    spec,
  };
}

function invalidBindingState(
  linked: LinkedSpecExecutionBindingV2,
  reason: string,
): DeliveryGateEvaluation {
  logger.warn("specs.delivery-gate-v2.invalid-binding", {
    specExecutionId: linked.specExecutionId,
    workflowExecutionId: linked.workflowExecutionId,
    candidateId: linked.binding.candidateId,
    reason,
  });
  return {
    status: "refused",
    unmet: [
      {
        criterionId: linked.specExecutionId,
        criterionHandle: linked.specExecutionId,
        outcome: "invalid_binding",
        reason,
      },
    ],
    instruction: RETRY_INSTRUCTION,
  };
}
