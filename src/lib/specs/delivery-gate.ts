import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type {
  CandidateValidationFact,
  CriterionOutcome,
  DeliveryGateEvaluateInput,
  DeliveryGateEvaluation,
  DeliveryGateEvaluator,
  DeliveryGateSpecPresentation,
} from "@/lib/workflows/merge/types";
import { scopePlanFromRevision } from "./compiler";
import type { SpecEventsPublisher } from "./events";
import type {
  EvidenceMutationRecord,
  EvidenceService,
} from "./evidence-service";
import { resolveDial } from "./policy";
import {
  recordPolicyGateAdmissionInTransaction,
  type SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import {
  evaluateDeterministicValidatorCredit,
  evaluateEvidenceFreshness,
  type GitProbes,
} from "./freshness";
import {
  evidenceEvaluatedStateSchema,
  isMachineValidationEvidenceKind,
  type ActorProvenance,
  type EvidenceKind,
  type Spec,
  type SpecCriterionDispositionRow,
  type SpecEvidenceRow,
  type SpecExecutionRow,
  type SpecProofVerdictRow,
  type SpecRevisionSnapshot,
  type ValidationStrategy,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import {
  evaluateDeliveryGate,
  type DeliveryCriterionSnapshot,
  type TransitionRefusal,
} from "./transitions";
import { isWaiverValidForExecution } from "./waiver-staleness";

const logger = createLogger("specs.delivery-gate");

const REDISPATCH_INSTRUCTION =
  "Re-dispatch validation against the prepared candidate, resolve any remaining proof or waiver requirements, then retry delivery.";

export interface CandidateValidationSource {
  mergeJobId: string;
  validation: CandidateValidationFact;
  producer: ActorProvenance;
}

export interface CandidateValidationLookup {
  workflowExecutionId: string;
  validationRef: string;
}

export interface DeliveryGateDeps {
  deliveryRepo: SpecDeliveryRepo;
  reviewRepo: Pick<
    SpecReviewRepo,
    | "hasValidHumanGateApproval"
    | "insertGateAdmission"
    | "findGateAdmissionsByRevision"
  >;
  specsRepo: Pick<SpecsRepo, "findById" | "getRevisionSnapshot">;
  /** Id source for policy-basis delivery admissions the gate records. */
  newAdmissionId(): string;
  /**
   * Policy-basis delivery admissions are spec mutations like any other: they
   * serialize through the shared write queue and commit their typed gate
   * event atomically with the admission row (R19.1); under Notify the
   * notifier surfaces the admitted merge for post-hoc review (R11.2).
   */
  events: SpecEventsPublisher;
  writeQueue: WriteQueue;
  runInImmediateTransaction<T>(fn: () => T): T;
  policyNotifier?: SpecPolicyAdmissionNotifier;
  evidenceService: Pick<
    EvidenceService,
    "attachEvidence" | "recordProofVerdict"
  >;
  ingestExecutionEvidence(executionId: string): Promise<unknown>;
  gitProbesForProject(projectPath: string): GitProbes;
  resolveCandidateValidation(
    input: CandidateValidationLookup,
  ): Promise<CandidateValidationSource | null>;
  /** Lands refused evaluations in the durable spec event log (21.4). */
  recordIntervention(input: EvidenceMutationRecord): void;
  /**
   * Opens the durable Needs You approval request when the gate refuses on the
   * missing human delivery approval (F17). Best-effort: a failure is logged
   * and never blocks the refusal itself. Idempotency lives in the review
   * service (one request per spec/gate/subject/execution).
   */
  requestDeliveryApproval(input: {
    specId: string;
    revisionId: string;
    workflowExecutionId: string;
  }): Promise<void>;
  /** Display name Studio URLs use — halt surfaces deep-link with it (F18). */
  getProjectDisplayName(projectPath: string): string;
  now(): string;
}

interface CriterionContract {
  id: string;
  handle: string;
  strategy: ValidationStrategy;
}

interface ProofEvaluation {
  proven: boolean;
  reason: string;
}

export function createDeliveryGate(
  deps: DeliveryGateDeps,
): DeliveryGateEvaluator {
  return {
    async evaluate(input) {
      const execution = deps.deliveryRepo.findExecutionByWorkflowExecutionId(
        input.workflowExecutionId,
      );
      if (execution === null) {
        logger.debug("specs.delivery-gate.pass-through", {
          workflowExecutionId: input.workflowExecutionId,
        });
        return { status: "pass", satisfied: [], deferred: [] };
      }

      await deps.ingestExecutionEvidence(execution.id);
      const evaluation = await evaluateLinkedExecution(deps, execution, input);
      if (evaluation.status === "refused") {
        // The gate refuses on the server's own authority, so the intervention
        // row carries system provenance; the per-criterion outcomes are the
        // machine-readable detail the release evidence counts.
        deps.recordIntervention({
          specId: execution.spec_id,
          actor: { kind: "system" },
          occurredAt: deps.now(),
          kind: "transition-refused",
          payload: {
            surface: "delivery_gate",
            // Explicit machine-readable refusal code so release evidence can
            // count gate refusals without inferring from the surface (21.4).
            code: "delivery_gate_failed",
            executionId: execution.id,
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
  execution: SpecExecutionRow,
  input: DeliveryGateEvaluateInput,
): Promise<DeliveryGateEvaluation> {
  const [spec, snapshot] = await Promise.all([
    deps.specsRepo.findById(execution.spec_id),
    deps.specsRepo.getRevisionSnapshot(execution.revision_id),
  ]);
  if (
    spec === null ||
    snapshot === null ||
    snapshot.revision.specId !== execution.spec_id ||
    spec.projectPath !== input.projectPath
  ) {
    return invalidPinnedState(
      execution,
      "The pinned spec state is unavailable for this merge project.",
    );
  }

  const scope = parseExecutionScope(execution.scope_json);
  if (scope === null) {
    return invalidPinnedState(
      execution,
      "The execution's immutable scope is invalid.",
    );
  }

  const contracts = criterionContracts(spec.slug, snapshot);
  const dispositions = new Map(
    deps.deliveryRepo
      .findCriterionDispositionsByExecution(execution.id)
      .map((disposition) => [disposition.criterion_element_id, disposition]),
  );
  const deliveryApprovalGranted = deps.reviewRepo.hasValidHumanGateApproval({
    specId: execution.spec_id,
    revisionId: execution.revision_id,
    executionId: execution.id,
    gate: "delivery",
  });
  const policyDecision = evaluateDeliveryGate({
    policy: spec.gatePolicy,
    executionState: execution.state,
    pinnedRevisionId: execution.revision_id,
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
  const specPresentation: DeliveryGateSpecPresentation = {
    specSlug: spec.slug,
    specName: spec.name,
    projectName: deps.getProjectDisplayName(spec.projectPath),
  };

  if (!policyDecision.ok) {
    // Fires only on the refusal branch that self-identifies as waiting on a
    // human delivery approval; every other refusal (terminal, exploratory,
    // invalid pin/scope) would open a Needs You entry no approval can clear.
    if (policyDecision.refusal.reason === "approval_required") {
      try {
        await deps.requestDeliveryApproval({
          specId: execution.spec_id,
          revisionId: execution.revision_id,
          workflowExecutionId: input.workflowExecutionId,
        });
      } catch (error) {
        logger.warn("specs.delivery-gate.approval-request-failed", {
          specExecutionId: execution.id,
          workflowExecutionId: input.workflowExecutionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.warn("specs.delivery-gate.refused", {
      specExecutionId: execution.id,
      workflowExecutionId: input.workflowExecutionId,
      preparedSha: input.preparedSha,
      refusalCode: policyDecision.refusal.code,
      unmetConditionCount: policyDecision.refusal.unmetConditions.length,
    });
    return refusedByTransition(
      execution,
      specPresentation,
      policyDecision.refusal,
    );
  }

  const probes = deps.gitProbesForProject(input.projectPath);
  const satisfied: CriterionOutcome[] = [];
  const unmet: CriterionOutcome[] = [];
  const criterionStates: DeliveryCriterionSnapshot[] = [];

  for (const criterionId of scope.selectedCriterionIds) {
    const contract = contracts.get(criterionId);
    if (contract === undefined) {
      unmet.push({
        criterionId,
        criterionHandle: criterionId,
        outcome: "invalid_pin",
        reason:
          "The selected criterion is absent from the pinned approved revision.",
      });
      continue;
    }

    const disposition = dispositions.get(criterionId);
    const outcome = await evaluateCriterion(
      deps,
      execution,
      contract,
      disposition,
      input,
      probes,
    );
    criterionStates.push(
      deliveryCriterionSnapshot(
        deps.deliveryRepo,
        execution,
        contract,
        disposition,
        outcome,
      ),
    );
    (outcome.outcome === "proven" ||
    outcome.outcome === "waived" ||
    outcome.outcome === "delivered_elsewhere"
      ? satisfied
      : unmet
    ).push(outcome);
  }

  const deferred = scope.exclusionDispositions.flatMap((exclusion) => {
    if (exclusion.disposition !== "deferred") return [];
    const disposition = dispositions.get(exclusion.criterionId);
    if (disposition?.disposition !== "deferred") return [];
    return [
      contracts.get(exclusion.criterionId)?.handle ?? exclusion.criterionId,
    ];
  });

  const proofDecision = evaluateDeliveryGate({
    policy: spec.gatePolicy,
    executionState: execution.state,
    pinnedRevisionId: execution.revision_id,
    pinnedScope: scope,
    deliveryApprovalGranted,
    criteria: criterionStates,
  });
  if (!proofDecision.ok) {
    logger.warn("specs.delivery-gate.refused", {
      specExecutionId: execution.id,
      workflowExecutionId: input.workflowExecutionId,
      preparedSha: input.preparedSha,
      unmetCriterionCount: unmet.length,
      deferredCriterionCount: deferred.length,
    });
    return refusedByTransition(
      execution,
      specPresentation,
      proofDecision.refusal,
      unmet,
    );
  }

  await recordPolicyDeliveryAdmission(deps, spec, execution);
  logger.info("specs.delivery-gate.passed", {
    specExecutionId: execution.id,
    workflowExecutionId: input.workflowExecutionId,
    preparedSha: input.preparedSha,
    satisfiedCriterionCount: satisfied.length,
    deferredCriterionCount: deferred.length,
  });
  return { status: "pass", satisfied, deferred };
}

/**
 * A merge the gate admits without a human delivery approval is still an
 * admitted delivery transition: under the Notify/Off dials the admission
 * lands with a policy basis and its typed gate event — committed atomically
 * through the shared write queue — so `spec_gate_admissions` and the event
 * log record why every delivery was admitted (R11.2, R19.1), and under
 * Notify the human is told post hoc. Under the Gate dial the human grant
 * already wrote the admission. Repeated evaluations of the same execution
 * keep one row.
 */
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
            events: deps.events,
            newAdmissionId: deps.newAdmissionId,
            now: deps.now,
          },
          { spec, gate: "delivery", execution },
        ),
      );
      if (recorded === null) return;
      deps.events.publishAfterCommit(recorded.prepared);
      if (recorded.notice !== null) {
        deps.policyNotifier?.policyAdmitted(recorded.notice);
      }
    },
  );
}

function deliveryCriterionSnapshot(
  repo: SpecDeliveryRepo,
  execution: SpecExecutionRow,
  contract: CriterionContract,
  disposition: SpecCriterionDispositionRow | undefined,
  outcome: CriterionOutcome,
): DeliveryCriterionSnapshot {
  const waiver = disposition?.waiver_id
    ? repo.findWaiverById(disposition.waiver_id)
    : null;
  return {
    criterionId: contract.id,
    handle: contract.handle,
    validProof: outcome.outcome === "proven",
    waiver:
      waiver === null ||
      waiver.spec_id !== execution.spec_id ||
      waiver.criterion_element_id !== contract.id
        ? null
        : {
            revisionId: waiver.revision_id,
            grantedByHuman: true,
            reason: waiver.reason,
            stale: waiver.stale === 1,
          },
    deliveredByMergedExecution:
      disposition !== undefined &&
      isEarlierMergedDelivery(repo, execution, disposition),
  };
}

function refusedByTransition(
  execution: SpecExecutionRow,
  spec: DeliveryGateSpecPresentation,
  refusal: TransitionRefusal,
  criterionOutcomes: CriterionOutcome[] = [],
): DeliveryGateEvaluation {
  // The pseudo-criterion entries stay in the durable payload so release
  // evidence counting and old persisted halts are unchanged; the dedicated
  // approval presentation rides alongside as refusalCode/spec (F19).
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

async function evaluateCriterion(
  deps: DeliveryGateDeps,
  execution: SpecExecutionRow,
  contract: CriterionContract,
  disposition: SpecCriterionDispositionRow | undefined,
  input: DeliveryGateEvaluateInput,
  probes: GitProbes,
): Promise<CriterionOutcome> {
  if (disposition === undefined) {
    return unmetOutcome(
      contract,
      "missing_disposition",
      "The pinned criterion has no execution disposition.",
    );
  }

  if (disposition.disposition === "waived") {
    const waiver = disposition.waiver_id
      ? deps.deliveryRepo.findWaiverById(disposition.waiver_id)
      : null;
    if (isWaiverValidForExecution(waiver, execution, contract.id)) {
      return satisfiedOutcome(
        contract,
        "waived",
        `Human waiver ${waiver.id} is valid for the pinned revision.`,
      );
    }
    return unmetOutcome(
      contract,
      "invalid_waiver",
      "The criterion's waiver is missing, stale, or belongs to another revision.",
    );
  }

  if (disposition.disposition === "delivered_elsewhere") {
    if (isEarlierMergedDelivery(deps.deliveryRepo, execution, disposition)) {
      return satisfiedOutcome(
        contract,
        "delivered_elsewhere",
        `Earlier execution ${disposition.delivered_by_execution_id} successfully delivered this criterion.`,
      );
    }
    return unmetOutcome(
      contract,
      "invalid_prior_delivery",
      "The referenced execution is not an earlier successfully merged delivery.",
    );
  }

  if (disposition.disposition !== "in_scope") {
    return unmetOutcome(
      contract,
      "not_in_scope",
      `Selected criterion has ${disposition.disposition} disposition.`,
    );
  }

  let proof = await evaluateProof(
    deps.deliveryRepo,
    execution,
    contract,
    input.preparedSha,
    probes,
  );
  if (!proof.proven && input.candidateValidation !== undefined) {
    await issueCandidateProof(deps, execution, contract, input, probes);
    proof = await evaluateProof(
      deps.deliveryRepo,
      execution,
      contract,
      input.preparedSha,
      probes,
    );
  }

  return proof.proven
    ? satisfiedOutcome(contract, "proven", proof.reason)
    : unmetOutcome(contract, "proof_required", proof.reason);
}

async function evaluateProof(
  repo: SpecDeliveryRepo,
  execution: SpecExecutionRow,
  contract: CriterionContract,
  preparedSha: string,
  probes: GitProbes,
): Promise<ProofEvaluation> {
  const verdicts = repo.findProofVerdictsByCriterionRevision(
    contract.id,
    execution.revision_id,
  );
  let staleVerdictSeen = false;

  for (const verdict of verdicts) {
    if (verdict.stale_at !== null) {
      staleVerdictSeen = true;
      continue;
    }
    const evidence = evidenceForVerdict(repo, verdict, contract, execution);
    if (evidence === null) {
      staleVerdictSeen = true;
      continue;
    }
    if (
      await strategyHasFreshEvidence(
        repo,
        contract.strategy,
        evidence,
        preparedSha,
        probes,
      )
    ) {
      return {
        proven: true,
        reason: `Proof verdict ${verdict.id} is fresh for the prepared candidate.`,
      };
    }
    staleVerdictSeen = true;
  }

  return {
    proven: false,
    reason: staleVerdictSeen
      ? "Existing proof is stale for the prepared candidate."
      : "No valid proof verdict exists for the pinned criterion and revision.",
  };
}

function evidenceForVerdict(
  repo: SpecDeliveryRepo,
  verdict: SpecProofVerdictRow,
  contract: CriterionContract,
  execution: SpecExecutionRow,
): SpecEvidenceRow[] | null {
  const ids = parseStringArray(verdict.evidence_ids_json);
  if (ids === null) return null;
  const evidence: SpecEvidenceRow[] = [];
  for (const id of ids) {
    const record = repo.findEvidenceById(id);
    if (
      record === null ||
      record.spec_id !== execution.spec_id ||
      record.revision_id !== execution.revision_id ||
      record.criterion_element_id !== contract.id
    ) {
      return null;
    }
    evidence.push(record);
  }
  return evidence;
}

async function strategyHasFreshEvidence(
  repo: SpecDeliveryRepo,
  strategy: ValidationStrategy,
  evidence: readonly SpecEvidenceRow[],
  preparedSha: string,
  probes: GitProbes,
): Promise<boolean> {
  const freshKinds = new Set<EvidenceKind>();
  for (const record of evidence) {
    if (await evidenceIsFresh(repo, record, preparedSha, probes)) {
      freshKinds.add(record.kind);
    }
  }
  return [...new Set(strategy.kinds)].every((kind) => freshKinds.has(kind));
}

async function evidenceIsFresh(
  repo: SpecDeliveryRepo,
  evidence: SpecEvidenceRow,
  preparedSha: string,
  probes: GitProbes,
): Promise<boolean> {
  const evaluatedState = parseEvaluatedState(evidence.evaluated_state_json);
  const producingExecution = evidence.execution_id
    ? repo.findExecutionById(evidence.execution_id)
    : null;
  if (evaluatedState === null || producingExecution === null) return false;
  const freshness = await evaluateEvidenceFreshness(
    {
      id: evidence.id,
      kind: evidence.kind,
      evaluatedState,
      producingExecutionState: producingExecution.state,
    },
    { commitSha: preparedSha },
    probes,
  );
  return freshness.status === "valid";
}

async function issueCandidateProof(
  deps: DeliveryGateDeps,
  execution: SpecExecutionRow,
  contract: CriterionContract,
  input: DeliveryGateEvaluateInput,
  probes: GitProbes,
): Promise<void> {
  const candidate = input.candidateValidation;
  if (candidate === undefined) return;
  const machineKinds = [...new Set(contract.strategy.kinds)].filter(
    isMachineValidationEvidenceKind,
  );
  if (machineKinds.length === 0) return;

  const source = await deps.resolveCandidateValidation({
    workflowExecutionId: input.workflowExecutionId,
    validationRef: candidate.validationRef,
  });
  if (source === null || !sameValidationFact(source.validation, candidate)) {
    logger.warn("specs.delivery-gate.candidate-proof-unresolved", {
      specExecutionId: execution.id,
      criterionElementId: contract.id,
      validationRef: candidate.validationRef,
    });
    return;
  }
  const credit = await evaluateDeterministicValidatorCredit(
    candidate,
    { commitSha: input.preparedSha },
    probes,
  );
  if (credit.status !== "valid") {
    logger.warn("specs.delivery-gate.candidate-proof-stale", {
      specExecutionId: execution.id,
      criterionElementId: contract.id,
      validationRef: candidate.validationRef,
      reason: credit.reason,
    });
    return;
  }

  if (contract.strategy.kinds.includes("commit")) {
    const existing = deps.deliveryRepo
      .findEvidenceByCriterionRevision(contract.id, execution.revision_id)
      .some(
        (record) =>
          record.kind === "commit" &&
          gitObjectRef(record) === input.preparedSha,
      );
    if (!existing) {
      const attached = await deps.evidenceService.attachEvidence({
        specId: execution.spec_id,
        criterionElementId: contract.id,
        revisionId: execution.revision_id,
        kind: "commit",
        ref: { type: "git_object", objectId: input.preparedSha },
        evaluatedState: {
          commitSha: input.preparedSha,
          relevantPaths: [],
        },
        producer: source.producer,
        executionId: execution.id,
      });
      if (!attached.ok) {
        logger.warn("specs.delivery-gate.candidate-evidence-refused", {
          specExecutionId: execution.id,
          criterionElementId: contract.id,
          validationRef: candidate.validationRef,
          kind: "commit",
          code: attached.refusal.code,
        });
        return;
      }
    }
  }

  for (const kind of machineKinds) {
    const existing = deps.deliveryRepo
      .findEvidenceByMergeValidationRef(
        execution.id,
        contract.id,
        candidate.validationRef,
      )
      .some((record) => record.kind === kind);
    if (existing) continue;
    const attached = await deps.evidenceService.attachEvidence({
      specId: execution.spec_id,
      criterionElementId: contract.id,
      revisionId: execution.revision_id,
      kind,
      ref: {
        type: "merge_validation",
        mergeJobId: source.mergeJobId,
        validationRef: candidate.validationRef,
      },
      evaluatedState: {
        commitSha: input.preparedSha,
        relevantPaths: [],
        relevantTreeHash: candidate.validatedTreeHash,
      },
      producer: source.producer,
      executionId: execution.id,
    });
    if (!attached.ok) {
      logger.warn("specs.delivery-gate.candidate-evidence-refused", {
        specExecutionId: execution.id,
        criterionElementId: contract.id,
        validationRef: candidate.validationRef,
        kind,
        code: attached.refusal.code,
      });
      return;
    }
  }

  if (
    verdictAlreadyCitesCandidateProof(
      deps.deliveryRepo,
      contract,
      execution,
      candidate.validationRef,
      input.preparedSha,
    )
  ) {
    return;
  }
  const evidenceIds = await freshEvidenceIdsForStrategy(
    deps.deliveryRepo,
    contract,
    execution,
    candidate.validationRef,
    input.preparedSha,
    probes,
  );
  if (evidenceIds === null) return;
  const verdict = await deps.evidenceService.recordProofVerdict({
    specId: execution.spec_id,
    criterionElementId: contract.id,
    revisionId: execution.revision_id,
    executionId: execution.id,
    verdictKind: "deterministic_validator",
    origin: "execution_ingest",
    actor: { kind: "system" },
    evidenceIds,
    validationStrategy: contract.strategy,
    strategyAssessment: { adequate: true },
  });
  if (!verdict.ok) {
    logger.warn("specs.delivery-gate.candidate-verdict-refused", {
      specExecutionId: execution.id,
      criterionElementId: contract.id,
      validationRef: candidate.validationRef,
      code: verdict.refusal.code,
    });
    return;
  }
  logger.info("specs.delivery-gate.candidate-proof-issued", {
    specExecutionId: execution.id,
    criterionElementId: contract.id,
    validationRef: candidate.validationRef,
    verdictId: verdict.value.id,
    evidenceCount: evidenceIds.length,
  });
}

async function freshEvidenceIdsForStrategy(
  repo: SpecDeliveryRepo,
  contract: CriterionContract,
  execution: SpecExecutionRow,
  validationRef: string,
  preparedSha: string,
  probes: GitProbes,
): Promise<string[] | null> {
  const evidence = repo.findEvidenceByCriterionRevision(
    contract.id,
    execution.revision_id,
  );
  const evidenceIds: string[] = [];
  for (const kind of [...new Set(contract.strategy.kinds)]) {
    const mustCiteCandidate = isMachineValidationEvidenceKind(kind);
    const candidates = evidence.filter(
      (record) =>
        record.kind === kind &&
        (!mustCiteCandidate || mergeValidationRef(record) === validationRef),
    );
    let selectedId: string | null = null;
    for (const record of candidates) {
      if (await evidenceIsFresh(repo, record, preparedSha, probes)) {
        selectedId = record.id;
        break;
      }
    }
    if (selectedId === null) return null;
    evidenceIds.push(selectedId);
  }
  return evidenceIds;
}

function verdictAlreadyCitesCandidateProof(
  repo: SpecDeliveryRepo,
  contract: CriterionContract,
  execution: SpecExecutionRow,
  validationRef: string,
  preparedSha: string,
): boolean {
  return repo
    .findProofVerdictsByCriterionRevision(contract.id, execution.revision_id)
    .some((verdict) => {
      const evidence = evidenceForVerdict(repo, verdict, contract, execution);
      return [...new Set(contract.strategy.kinds)].every((kind) =>
        evidence?.some((record) => {
          if (record.kind !== kind) return false;
          return kind === "commit"
            ? gitObjectRef(record) === preparedSha
            : mergeValidationRef(record) === validationRef;
        }),
      );
    });
}

/**
 * Why a claimed `delivered_elsewhere` base is or is not an earlier merged
 * delivery. The gate itself only needs the yes/no, but a plan that refuses a
 * claim has to say which way it failed and name the id it judged — "this is
 * not an earlier delivery" leaves the author guessing between a typo, a run
 * that never merged, and one that merged too late.
 */
export type EarlierMergedDeliveryVerdict =
  | { readonly code: "accepted"; readonly baseExecutionId: string }
  | { readonly code: "missing_base"; readonly baseExecutionId: null }
  | { readonly code: "self_reference"; readonly baseExecutionId: string }
  | { readonly code: "unknown_base"; readonly baseExecutionId: string }
  | { readonly code: "foreign_spec"; readonly baseExecutionId: string }
  | { readonly code: "not_merged"; readonly baseExecutionId: string }
  | { readonly code: "not_earlier"; readonly baseExecutionId: string }
  | { readonly code: "base_did_not_deliver"; readonly baseExecutionId: string };

/**
 * The single owner of the prior-run rule for `delivered_elsewhere`
 * dispositions. Exported so the detail route's per-criterion projection and
 * the delivery-plan lint validate external delivery with exactly the rule the
 * gate enforces — a client, route, or plan re-derivation of "earlier merged
 * delivery" is how the Studio counter drifted from gate truth in the first
 * place (F26).
 */
export function classifyEarlierMergedDelivery(
  repo: Pick<
    SpecDeliveryRepo,
    "findExecutionById" | "findCriterionDisposition"
  >,
  /**
   * The run whose claim is being judged. Narrowed to what "earlier" is
   * measured from, so a delivery plan attempt — which is the execution before
   * it exists — is judged by exactly the gate's rule rather than a copy of it.
   */
  execution: Pick<SpecExecutionRow, "id" | "spec_id" | "created_at">,
  disposition: Pick<
    SpecCriterionDispositionRow,
    "criterion_element_id" | "delivered_by_execution_id"
  >,
): EarlierMergedDeliveryVerdict {
  const priorId = disposition.delivered_by_execution_id;
  if (priorId === null) return { code: "missing_base", baseExecutionId: null };
  if (priorId === execution.id) {
    return { code: "self_reference", baseExecutionId: priorId };
  }
  const prior = repo.findExecutionById(priorId);
  if (prior === null) {
    return { code: "unknown_base", baseExecutionId: priorId };
  }
  if (prior.spec_id !== execution.spec_id) {
    return { code: "foreign_spec", baseExecutionId: priorId };
  }
  if (prior.state !== "delivered" || prior.delivered_at === null) {
    return { code: "not_merged", baseExecutionId: priorId };
  }
  if (
    prior.created_at >= execution.created_at ||
    prior.delivered_at > execution.created_at
  ) {
    return { code: "not_earlier", baseExecutionId: priorId };
  }
  const priorDisposition = repo.findCriterionDisposition(
    prior.id,
    disposition.criterion_element_id,
  );
  return priorDisposition?.delivered_by_execution_id === prior.id
    ? { code: "accepted", baseExecutionId: priorId }
    : { code: "base_did_not_deliver", baseExecutionId: priorId };
}

export function isEarlierMergedDelivery(
  repo: Pick<
    SpecDeliveryRepo,
    "findExecutionById" | "findCriterionDisposition"
  >,
  execution: SpecExecutionRow,
  disposition: SpecCriterionDispositionRow,
): boolean {
  return (
    classifyEarlierMergedDelivery(repo, execution, disposition).code ===
    "accepted"
  );
}

function criterionContracts(
  specSlug: string,
  snapshot: SpecRevisionSnapshot,
): Map<string, CriterionContract> {
  const handles = new Map(
    scopePlanFromRevision(specSlug, snapshot).criteria.map((criterion) => [
      criterion.id,
      criterion.handle,
    ]),
  );
  const contracts = new Map<string, CriterionContract>();
  for (const item of snapshot.elements) {
    if (item.version.payload.kind !== "criterion") continue;
    contracts.set(item.element.id, {
      id: item.element.id,
      handle: handles.get(item.element.id) ?? item.element.id,
      strategy: item.version.payload.validationStrategy,
    });
  }
  return contracts;
}

function parseExecutionScope(raw: string): ExecutionScope | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const selectedTaskIds = stringArray(value.selectedTaskIds);
    const selectedCriterionIds = stringArray(value.selectedCriterionIds);
    if (
      selectedTaskIds === null ||
      selectedCriterionIds === null ||
      !Array.isArray(value.exclusionDispositions)
    ) {
      return null;
    }
    const exclusionDispositions: ExecutionScope["exclusionDispositions"] = [];
    for (const exclusion of value.exclusionDispositions) {
      if (
        !isRecord(exclusion) ||
        typeof exclusion.criterionId !== "string" ||
        (exclusion.disposition !== "deferred" &&
          exclusion.disposition !== "waived" &&
          exclusion.disposition !== "delivered_elsewhere")
      ) {
        return null;
      }
      exclusionDispositions.push({
        criterionId: exclusion.criterionId,
        disposition: exclusion.disposition,
      });
    }
    return { selectedTaskIds, selectedCriterionIds, exclusionDispositions };
  } catch {
    return null;
  }
}

function parseEvaluatedState(raw: string) {
  try {
    return evidenceEvaluatedStateSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    return stringArray(JSON.parse(raw));
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function mergeValidationRef(evidence: SpecEvidenceRow): string | null {
  try {
    const ref: unknown = JSON.parse(evidence.ref_json);
    return isRecord(ref) &&
      ref.type === "merge_validation" &&
      typeof ref.validationRef === "string"
      ? ref.validationRef
      : null;
  } catch {
    return null;
  }
}

function gitObjectRef(evidence: SpecEvidenceRow): string | null {
  try {
    const ref: unknown = JSON.parse(evidence.ref_json);
    return isRecord(ref) &&
      ref.type === "git_object" &&
      typeof ref.objectId === "string"
      ? ref.objectId
      : null;
  } catch {
    return null;
  }
}

function sameValidationFact(
  left: CandidateValidationFact,
  right: CandidateValidationFact,
): boolean {
  return (
    left.validationRef === right.validationRef &&
    left.validatedSha === right.validatedSha &&
    left.validatedTreeHash === right.validatedTreeHash &&
    left.commandIdentity === right.commandIdentity &&
    left.outcome === right.outcome
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function satisfiedOutcome(
  contract: CriterionContract,
  outcome: "proven" | "waived" | "delivered_elsewhere",
  reason: string,
): CriterionOutcome {
  return {
    criterionId: contract.id,
    criterionHandle: contract.handle,
    outcome,
    reason,
  };
}

function unmetOutcome(
  contract: CriterionContract,
  outcome: string,
  reason: string,
): CriterionOutcome {
  return {
    criterionId: contract.id,
    criterionHandle: contract.handle,
    outcome,
    reason,
  };
}

function invalidPinnedState(
  execution: SpecExecutionRow,
  reason: string,
): DeliveryGateEvaluation {
  logger.warn("specs.delivery-gate.invalid-pin", {
    specExecutionId: execution.id,
    revisionId: execution.revision_id,
    reason,
  });
  return {
    status: "refused",
    unmet: [
      {
        criterionId: execution.id,
        criterionHandle: execution.id,
        outcome: "invalid_pin",
        reason,
      },
    ],
    instruction: REDISPATCH_INSTRUCTION,
  };
}
