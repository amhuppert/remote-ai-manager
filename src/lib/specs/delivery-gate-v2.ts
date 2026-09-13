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
import { resolveDial, isExploratoryShippingRefused } from "./policy";
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
  SpecAcceptanceReview,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import {
  evaluateDeliveryGate,
  type DeliveryCriterionSnapshot,
  type TransitionRefusal,
} from "./transitions";
import { specDeliveryBasisSchema } from "./schemas";
import { executionScopeSchema } from "./scope-validation";
import { isWaiverValidForExecution } from "./waiver-staleness";
import {
  currentAcceptanceReview,
  criterionAcceptanceHash,
} from "./acceptance-review";

const logger = createLogger("specs.delivery-gate-v2");

const ACTIVE_RECOVERY_INSTRUCTION =
  "Resume or repair the active graph execution until the named claimant is recertified, or open Delivery in Spec Studio to mark criteria satisfied, waive evidence, and continue through session delivery.";
const ARCHIVED_RECOVERY_INSTRUCTION =
  "The claimant belongs to an archived graph execution and cannot be recertified in place. Open Delivery in Spec Studio to mark it satisfied or grant a Studio waiver, then continue in the session or start a replacement workflow.";
const RETRY_INSTRUCTION =
  "Repair the current graph execution or delivery binding, or open Delivery in Spec Studio to review acceptance and choose session delivery.";

export interface GraphDeliveryOutcomePort {
  getAuthoredContextOutcome(
    executionId: string,
    authoredContextId: string,
    purpose?: "delivery" | "retained_source",
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
    | "findAcceptanceReviewsBySpecId"
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
    workflowExecutionId?: string;
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
      if (input.specExecutionId !== undefined) {
        const execution = deps.deliveryRepo.findExecutionById(
          input.specExecutionId,
        );
        if (execution?.workflow_execution_id == null)
          return evaluateSessionDelivery(deps, execution, input);
        if (
          input.workflowExecutionId &&
          input.workflowExecutionId !== execution.workflow_execution_id
        ) {
          throw new Error(
            "Merge workflow and spec execution identities disagree",
          );
        }
        input = {
          ...input,
          workflowExecutionId: execution.workflow_execution_id,
        };
      }
      if (input.workflowExecutionId === undefined)
        throw new Error("Delivery evaluation requires an execution identity");
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
        { ...input, workflowExecutionId: input.workflowExecutionId },
      );
      if (evaluation.status === "refused" && !input.readOnly) {
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

async function evaluateSessionDelivery(
  deps: DeliveryGateDeps,
  execution: SpecExecutionRow | null,
  input: Parameters<DeliveryGateEvaluator["evaluate"]>[0],
): Promise<DeliveryGateEvaluation> {
  if (!execution) throw new Error("The delivery execution is unavailable");
  const spec = await deps.specsRepo.findById(execution.spec_id);
  const snapshot = await deps.specsRepo.getRevisionSnapshot(
    execution.revision_id,
  );
  if (
    !spec ||
    !snapshot ||
    spec.projectPath !== input.projectPath ||
    snapshot.revision.specId !== spec.id
  )
    throw new Error("The session delivery pin is unavailable for this project");
  const presentation = {
    specSlug: spec.slug,
    specName: spec.name,
    projectName: deps.getProjectDisplayName(spec.projectPath),
  };
  if (!execution.delivery_basis_json)
    return {
      status: "refused",
      spec: presentation,
      unmet: [
        {
          criterionId: execution.id,
          criterionHandle: spec.slug,
          outcome: "delivery_path_required",
          reason:
            "Choose session delivery or launch the planned graph before merging.",
        },
      ],
      instruction:
        "Open the delivery review in Spec Studio to choose how delivery continues.",
    };
  const basis = specDeliveryBasisSchema.parse(
    JSON.parse(execution.delivery_basis_json),
  );
  const scope = executionScopeSchema.parse(JSON.parse(execution.scope_json));
  const reviews = deps.deliveryRepo.findAcceptanceReviewsBySpecId(spec.id);
  const contracts = criterionContracts(snapshot);
  const approved = deps.reviewRepo.hasValidHumanGateApproval({
    specId: spec.id,
    revisionId: execution.revision_id,
    executionId: execution.id,
    gate: "delivery",
  });
  const criteria: DeliveryCriterionSnapshot[] = [];
  const satisfied: CriterionOutcome[] = [];
  const unmet: CriterionOutcome[] = [];
  for (const criterionId of scope.selectedCriterionIds) {
    const contract = contracts.get(criterionId) ?? {
      id: criterionId,
      handle: criterionId,
    };
    const hash = criterionAcceptanceHash(snapshot, criterionId);
    const currentReview = currentAcceptanceReview(
      reviews,
      criterionId,
      hash ?? "",
    );
    const decision =
      currentReview?.decision === "revoked" ? null : currentReview;
    const waiver = validWaiverForCriterion(
      deps,
      execution,
      criterionId,
      currentReview,
    );
    let provenBy: string | null = null;
    const automated: string[] = [];
    for (const sourceId of basis.sourceSpecExecutionIds) {
      const source = deps.deliveryRepo.findExecutionById(sourceId);
      if (
        !source ||
        source.spec_id !== spec.id ||
        source.session_name !== execution.session_name ||
        !source.workflow_execution_id
      )
        continue;
      const sourceSnapshot = await deps.specsRepo.getRevisionSnapshot(
        source.revision_id,
      );
      if (
        !sourceSnapshot ||
        criterionAcceptanceHash(sourceSnapshot, criterionId) !== hash
      )
        continue;
      const binding = deps.bindingPort.resolveByWorkflowExecutionId(
        source.workflow_execution_id,
      );
      if (!binding || binding.specExecutionId !== source.id) continue;
      for (const claim of binding.binding.claims) {
        if (!claim.criterionElementIds.includes(criterionId)) continue;
        const outcome = await deps.outcomePort.getAuthoredContextOutcome(
          source.workflow_execution_id,
          claim.contextId,
          "retained_source",
        );
        automated.push(
          `${source.workflow_execution_id}: ${describeClaimantOutcome({ contextId: claim.contextId, outcome })}`,
        );
        if (outcome.status === "satisfied") {
          provenBy = source.workflow_execution_id;
          break;
        }
      }
      if (provenBy) break;
    }
    criteria.push({
      criterionId,
      handle: contract.handle,
      validProof: provenBy !== null,
      humanAccepted: decision !== null,
      waiver:
        waiver === null
          ? null
          : {
              revisionId: waiver.revision_id,
              grantedByHuman: true,
              reason: waiver.reason,
              stale: false,
            },
      deliveredByMergedExecution: false,
    });
    if (provenBy)
      satisfied.push({
        ...satisfiedOutcome(
          contract,
          "satisfied",
          `Applicable automated proof from workflow ${provenBy}.`,
        ),
        automated,
      });
    else if (decision)
      satisfied.push({
        ...satisfiedOutcome(
          contract,
          decision.decision === "satisfied" ? "human_satisfied" : "waived",
          `Human review ${decision.id}. ${decision.note}`,
        ),
        automated,
      });
    else if (waiver)
      satisfied.push({
        ...satisfiedOutcome(
          contract,
          "waived",
          `Human waiver ${waiver.id}. ${waiver.reason}`,
        ),
        automated,
      });
    else
      unmet.push({
        criterionId,
        criterionHandle: contract.handle,
        outcome: "needs_review",
        automated,
        reason: "Mark satisfied or waive evidence in the delivery review.",
      });
  }
  const transition = evaluateDeliveryGate({
    policy: spec.gatePolicy,
    executionState: execution.state,
    pinnedRevisionId: snapshot.revision.id,
    pinnedScope: scope,
    deliveryApprovalGranted: approved,
    criteria,
  });
  if (!transition.ok) {
    if (transition.refusal.reason === "approval_required") {
      unmet.unshift({
        criterionId: `${execution.id}:delivery-approval`,
        criterionHandle: spec.slug,
        outcome: "approval_required",
        reason: "The delivery gate requires human approval.",
      });
      if (!input.readOnly)
        await requestApprovalForRefusal(
          deps,
          execution,
          undefined,
          transition.refusal,
        );
    } else if (
      unmet.length === 0 ||
      transition.refusal.code !== "delivery_gate_failed" ||
      isExploratoryShippingRefused(spec.gatePolicy)
    ) {
      unmet.push(
        ...transition.refusal.unmetConditions.map((reason) => ({
          criterionId: execution.id,
          criterionHandle: spec.slug,
          outcome: transition.refusal.code,
          reason,
        })),
      );
    }
    return {
      ...refusedByTransition(
        execution,
        presentation,
        transition.refusal,
        unmet,
      ),
      satisfied,
    };
  }
  if (basis.kind !== "session")
    throw new Error("External delivery cannot publish a session merge");
  if (!input.readOnly)
    await recordPolicyDeliveryAdmission(deps, spec, execution);
  logger.info("specs.delivery-gate.session-evaluated", {
    specExecutionId: execution.id,
    selectedCount: criteria.length,
    satisfiedCount: satisfied.length,
  });
  return {
    status: "pass",
    satisfied,
    deferred: scope.exclusionDispositions
      .filter((entry) => entry.disposition === "deferred")
      .map((entry) => entry.criterionId),
  };
}

async function evaluateLinkedExecution(
  deps: DeliveryGateDeps,
  linked: LinkedSpecExecutionBindingV2,
  execution: SpecExecutionRow | null,
  input: Parameters<DeliveryGateEvaluator["evaluate"]>[0] & {
    workflowExecutionId: string;
  },
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
  if (
    !policyDecision.ok &&
    policyDecision.refusal.reason !== "approval_required"
  ) {
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

  const approvalOutcomes: CriterionOutcome[] = [];
  if (!policyDecision.ok) {
    if (!input.readOnly)
      await requestApprovalForRefusal(
        deps,
        execution,
        input.workflowExecutionId,
        policyDecision.refusal,
      );
    approvalOutcomes.push({
      criterionId: `${execution.id}:delivery-approval`,
      criterionHandle: spec.slug,
      outcome: "approval_required",
      reason: "The delivery gate requires human approval.",
    });
  }
  const reviews = deps.deliveryRepo.findAcceptanceReviewsBySpecId(spec.id);

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
    const currentReview = currentAcceptanceReview(
      reviews,
      criterionId,
      criterionAcceptanceHash(snapshot, criterionId) ?? "",
    );
    const humanReview =
      currentReview?.decision === "revoked" ? null : currentReview;
    const waiver =
      satisfyingContextId === null
        ? validWaiverForCriterion(deps, execution, criterionId, currentReview)
        : null;
    const outcome =
      satisfyingContextId !== null
        ? satisfiedOutcome(
            contract,
            "satisfied",
            `Authored context ${satisfyingContextId} is satisfied in the current graph execution.`,
          )
        : humanReview !== null
          ? satisfiedOutcome(
              contract,
              humanReview.decision === "satisfied"
                ? "human_satisfied"
                : "waived",
              `Human review ${humanReview.id}: ${humanReview.decision === "satisfied" ? "criterion satisfied" : "evidence waived"}.${humanReview.note ? ` ${humanReview.note}` : ""}`,
            )
          : waiver !== null
            ? satisfiedOutcome(
                contract,
                "waived",
                `Studio waiver ${waiver.id} is valid for the current pinned revision.`,
              )
            : unmetClaimantOutcome(contract, claimantOutcomes);
    outcome.automated = claimantOutcomes.map(describeClaimantOutcome);
    evaluated.push({
      contract,
      outcome,
      satisfyingContextId,
      claimantOutcomes,
      state: {
        criterionId,
        handle: contract.handle,
        validProof: satisfyingContextId !== null,
        humanAccepted: humanReview !== null,
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
  const integrationOutcomes: CriterionOutcome[] = [];
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
    integrationOutcomes.push(integrationOutcome);
  }

  if (!input.readOnly && finalCandidate.status === "satisfied")
    await recordVerdicts(deps, linked, evaluated);

  const unmet = [
    ...approvalOutcomes,
    ...evaluated
      .filter(
        (criterion) =>
          !criterion.state.validProof &&
          !criterion.state.humanAccepted &&
          criterion.state.waiver === null,
      )
      .map((criterion) => criterion.outcome),
    ...integrationOutcomes,
  ];
  if (unmet.length > 0) {
    logger.warn("specs.delivery-gate-v2.readiness-refused", {
      specExecutionId: execution.id,
      approvalRequired: approvalOutcomes.length > 0,
      unmetCount: unmet.length,
    });
    return {
      ...refusedByTransition(
        execution,
        specPresentation,
        deliveryRefusal(
          unmet.map((outcome) => outcome.reason ?? outcome.outcome),
          approvalOutcomes.length > 0
            ? "Open the delivery review in Spec Studio to settle the listed criteria and approve delivery, then continue merge."
            : recoveryInstructionForClaimants(evaluated),
        ),
        unmet,
      ),
      satisfied: evaluated
        .filter(
          (criterion) =>
            criterion.state.validProof ||
            criterion.state.humanAccepted ||
            criterion.state.waiver !== null,
        )
        .map((criterion) => criterion.outcome),
      ...(approvalOutcomes.length > 0
        ? { refusalCode: "approval_required" as const }
        : {}),
    };
  }

  if (!input.readOnly)
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
  review: SpecAcceptanceReview | null,
): SpecWaiverRow | null {
  const waiver = deps.deliveryRepo.findWaiverForCriterionRevision(
    criterionId,
    execution.revision_id,
  );
  if (
    waiver &&
    review?.decision === "revoked" &&
    Date.parse(review.createdAt) >= Date.parse(waiver.waived_at)
  )
    return null;
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
    criterion.state.validProof ||
    criterion.state.humanAccepted ||
    criterion.state.waiver !== null
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
  outcome: "satisfied" | "human_satisfied" | "waived",
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
  workflowExecutionId: string | undefined,
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
    criterionOutcomes.length > 0
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
