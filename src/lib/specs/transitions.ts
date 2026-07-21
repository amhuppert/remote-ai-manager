import {
  lint,
  type LintFinding,
  type RevisionSnapshot,
  type SpecRecords,
} from "./lint";
import {
  COMBINED_APPROVAL_DIAL,
  isExploratoryShippingRefused,
  policyChangeRequiresHardConfirmation,
  resolveDial,
  type ResolvedGateDial,
} from "./policy";
import {
  diffRevisions,
  type RevisionElement as DiffRevisionElement,
} from "./revision-diff";
import type {
  ActorProvenance,
  Refusal,
  RefusalCode,
  SpecApprovalSubjectKind,
  SpecApprovalValidity,
  SpecExecutionState,
  SpecGatePolicy,
  SpecRevisionState,
} from "./schemas";
import {
  validateExecutionScope,
  type ExecutionScope,
  type ScopePlan,
} from "./scope-validation";

export type TransitionRefusal = Omit<Refusal, "findings"> & {
  findings?: LintFinding[];
};

export type TransitionDecision =
  | { ok: true }
  | { ok: false; refusal: TransitionRefusal };

export type DeliveryGateResult = TransitionDecision;

export interface ReviewThreadSnapshot {
  handle: string;
  resolved: boolean;
}

export interface ApprovalSnapshot {
  subjectKind: Exclude<SpecApprovalSubjectKind, "revision">;
  elementId?: string;
  revisionId: string;
  validity: SpecApprovalValidity;
}

export interface SignOffReviewSnapshot {
  revisionId: string;
  baseRevisionRows: DiffRevisionElement[];
  revisionRows: DiffRevisionElement[];
  blockingThreads: ReviewThreadSnapshot[];
  approvals: ApprovalSnapshot[];
}

export interface ProposeContext {
  revisionState: SpecRevisionState;
  policy: SpecGatePolicy;
  draft: RevisionSnapshot;
  records: SpecRecords;
  review: SignOffReviewSnapshot;
}

export interface ElementApprovalContext {
  actor: ActorProvenance;
  revisionState: SpecRevisionState;
  subjectKind: Extract<SpecApprovalSubjectKind, "requirement" | "decision">;
}

export interface SignOffContext {
  actor: ActorProvenance;
  revisionState: SpecRevisionState;
  policy: SpecGatePolicy;
  draft: RevisionSnapshot;
  records: SpecRecords;
  review: SignOffReviewSnapshot;
}

export interface StartExecutionContext {
  policy: SpecGatePolicy;
  specAbandoned: boolean;
  revisionId?: string;
  revisionState: SpecRevisionState;
  scope?: ExecutionScope;
  plan: ScopePlan;
  activeExecution: boolean;
}

export interface TaskClaimContext {
  policy: SpecGatePolicy;
  draft: RevisionSnapshot;
  records: SpecRecords;
}

export interface WaiverContext {
  actor: ActorProvenance;
  reason: string;
  existingWaiver: boolean;
}

export interface PolicyChangeContext {
  actor: ActorProvenance;
  currentPolicy: SpecGatePolicy;
  proposedPolicy: SpecGatePolicy;
  hardConfirmed: boolean;
}

export interface DeliveryWaiverSnapshot {
  revisionId: string;
  grantedByHuman: boolean;
  reason: string;
  stale: boolean;
}

export interface DeliveryCriterionSnapshot {
  criterionId: string;
  handle: string;
  validProof: boolean;
  waiver: DeliveryWaiverSnapshot | null;
  deliveredByMergedExecution: boolean;
}

export interface DeliveryGateContext {
  policy: SpecGatePolicy;
  executionState: SpecExecutionState;
  pinnedRevisionId?: string;
  pinnedScope?: ExecutionScope;
  deliveryApprovalGranted: boolean;
  criteria: DeliveryCriterionSnapshot[];
}

function allowed(): TransitionDecision {
  return { ok: true };
}

function refused(
  code: RefusalCode,
  unmetConditions: string[],
  instruction: string,
  findings?: LintFinding[],
): TransitionDecision {
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

function blockingFindings(
  draft: RevisionSnapshot,
  records: SpecRecords,
  severity: LintFinding["severity"],
): LintFinding[] {
  return lint(draft, records).filter(
    (finding) => finding.severity === severity,
  );
}

function requiresHumanApproval(dial: ResolvedGateDial): boolean {
  return dial === "gate" || dial === COMBINED_APPROVAL_DIAL;
}

function approvalFor(
  review: SignOffReviewSnapshot,
  subjectKind: ApprovalSnapshot["subjectKind"],
  elementId?: string,
): ApprovalSnapshot | undefined {
  return review.approvals.find(
    (approval) =>
      approval.subjectKind === subjectKind &&
      approval.elementId === elementId &&
      approval.validity === "valid",
  );
}

function handleByElementId(draft: RevisionSnapshot): Map<string, string> {
  return new Map(draft.elements.map((element) => [element.id, element.handle]));
}

function approvalUnmetConditions(
  policy: SpecGatePolicy,
  draft: RevisionSnapshot,
  review: SignOffReviewSnapshot,
): string[] {
  const requirementsDial = resolveDial(policy, "requirements");
  const designDial = resolveDial(policy, "design");
  const planDial = resolveDial(policy, "plan");
  const allCombined = [requirementsDial, designDial, planDial].every(
    (dial) => dial === COMBINED_APPROVAL_DIAL,
  );

  if (allCombined) {
    // The combined dial collapses per-element approvals into one human act:
    // the sign-off itself (R11.5). signOffRevision refuses non-human actors
    // before reaching these preconditions, and propose absorbs sign-off only
    // when every dial is Notify/Off, so no combined-dial transition can get
    // here without a human sign-off in progress.
    return [];
  }

  const diff = diffRevisions(review.baseRevisionRows, review.revisionRows);
  const classifications = new Map(
    diff.classifications.map((classification) => [
      classification.elementId,
      classification,
    ]),
  );
  const handles = handleByElementId(draft);
  const unmetConditions: string[] = [];

  const requireElementApprovals = (
    dial: ResolvedGateDial,
    kind: "requirement" | "decision",
    label: "Requirement" | "Decision",
  ): void => {
    if (!requiresHumanApproval(dial)) {
      return;
    }

    const elements = review.revisionRows
      .filter((row) => row.payload.kind === kind)
      .sort((left, right) => left.elementId.localeCompare(right.elementId));

    for (const element of elements) {
      const approval = approvalFor(review, kind, element.elementId);
      const changed =
        classifications.get(element.elementId)?.classification !== "unchanged";
      const validForRevision =
        approval !== undefined &&
        (!changed || approval.revisionId === review.revisionId);
      if (validForRevision) {
        continue;
      }

      const handle = handles.get(element.elementId) ?? element.elementId;
      unmetConditions.push(
        `${label} ${handle} needs a valid approval for ${review.revisionId}.`,
      );
    }
  };

  requireElementApprovals(requirementsDial, "requirement", "Requirement");
  requireElementApprovals(designDial, "decision", "Decision");

  if (requiresHumanApproval(planDial)) {
    const approval = approvalFor(review, "plan");
    const validForRevision =
      approval !== undefined &&
      (!diff.planStale || approval.revisionId === review.revisionId);
    if (!validForRevision) {
      unmetConditions.push(
        `Execution plan needs a valid approval for ${review.revisionId}.`,
      );
    }
  }

  return unmetConditions;
}

function unresolvedThreadConditions(review: SignOffReviewSnapshot): string[] {
  return review.blockingThreads
    .filter((thread) => !thread.resolved)
    .sort((left, right) => left.handle.localeCompare(right.handle))
    .map((thread) => `Blocking thread ${thread.handle} is unresolved.`);
}

function signOffPreconditions(
  policy: SpecGatePolicy,
  draft: RevisionSnapshot,
  records: SpecRecords,
  review: SignOffReviewSnapshot,
): TransitionDecision {
  const signOffFindings = blockingFindings(draft, records, "blocks_signoff");
  const threadConditions = unresolvedThreadConditions(review);
  const approvalConditions = approvalUnmetConditions(policy, draft, review);
  const unmetConditions = [
    ...threadConditions,
    ...signOffFindings.map((finding) => finding.message),
    ...approvalConditions,
  ];

  if (unmetConditions.length === 0) {
    return allowed();
  }

  return refused(
    signOffFindings.length > 0 ? "lint_blocked" : "gate_blocked",
    unmetConditions,
    "Resolve the sign-off preconditions and sign off again.",
    signOffFindings.length > 0 ? signOffFindings : undefined,
  );
}

function proposeDials(policy: SpecGatePolicy): ResolvedGateDial[] {
  return (["requirements", "design", "plan"] as const).map((gate) =>
    resolveDial(policy, gate),
  );
}

export function propose(context: ProposeContext): TransitionDecision {
  if (context.revisionState !== "draft") {
    return refused(
      "gate_blocked",
      ["Only a draft revision can be proposed."],
      "Open or reuse a draft revision before proposing it.",
    );
  }

  const panelFindings = lint(context.draft, context.records);
  const blocking = panelFindings.filter(
    (finding) => finding.severity === "blocks_propose",
  );
  if (blocking.length > 0) {
    return refused(
      "lint_blocked",
      blocking.map((finding) => finding.message),
      "Resolve the blocking lint findings and propose again.",
      panelFindings,
    );
  }

  const dials = proposeDials(context.policy);
  const absorbsSignOff = dials.every(
    (dial) => dial === "notify" || dial === "off",
  );
  if (!absorbsSignOff) {
    return allowed();
  }

  return signOffPreconditions(
    context.policy,
    context.draft,
    context.records,
    context.review,
  );
}

export function approveElement(
  context: ElementApprovalContext,
): TransitionDecision {
  if (context.actor.kind !== "human") {
    return refused(
      "human_act_required",
      ["Element approval is a human-only act."],
      "Ask a human to approve the element in Spec Studio.",
    );
  }

  if (context.revisionState !== "proposed") {
    return refused(
      "gate_blocked",
      ["Elements can be approved only on a proposed revision."],
      "Propose the draft revision before approving its elements.",
    );
  }

  return allowed();
}

export function signOffRevision(context: SignOffContext): TransitionDecision {
  if (context.revisionState === "approved") {
    return allowed();
  }
  if (context.revisionState !== "proposed") {
    return refused(
      "gate_blocked",
      ["Only a proposed revision can be signed off."],
      "Propose the draft revision before signing it off.",
    );
  }

  const humanRequired = proposeDials(context.policy).some(
    requiresHumanApproval,
  );
  if (humanRequired && context.actor.kind !== "human") {
    return refused(
      "human_act_required",
      ["The configured sign-off gates require a human actor."],
      "Ask a human to sign off the revision in Spec Studio.",
    );
  }

  return signOffPreconditions(
    context.policy,
    context.draft,
    context.records,
    context.review,
  );
}

export function startExecution(
  context: StartExecutionContext,
): TransitionDecision {
  if (context.specAbandoned) {
    return refused(
      "gate_blocked",
      ["An abandoned spec is terminal and cannot start another execution."],
      "Use the abandoned spec history; create a new spec for future work.",
    );
  }

  const revisionId = context.revisionId;
  const scope = context.scope;
  const pinConditions: string[] = [];
  if (!revisionId) {
    pinConditions.push("Execution start requires a pinned revision.");
  }
  if (!scope) {
    pinConditions.push("Execution start requires a pinned scope.");
  }
  if (!revisionId || !scope) {
    return refused(
      "invalid_scope",
      pinConditions,
      "Select an approved revision and an explicit execution scope, then start again.",
    );
  }

  if (context.revisionState !== "approved") {
    return refused(
      "revision_not_approved",
      ["The pinned revision is not approved."],
      "Complete revision sign-off before starting execution.",
    );
  }

  if (context.activeExecution) {
    return refused(
      "execution_active",
      ["The spec already has an active execution."],
      "Finish or abandon the active execution before starting another.",
    );
  }

  const scopeResult = validateExecutionScope(context.plan, scope);
  if (!scopeResult.valid) {
    return refused(
      "invalid_scope",
      scopeResult.defects.map((defect) => defect.message),
      "Repair the selected tasks, criteria, and exclusions, then start again.",
    );
  }

  return allowed();
}

export function claimTaskComplete(
  context: TaskClaimContext,
): TransitionDecision {
  if (isExploratoryShippingRefused(context.policy)) {
    return refused(
      "gate_blocked",
      ["Exploratory specs cannot record task completion claims."],
      "Switch the spec to a shipping-capable preset through a human-confirmed policy change.",
    );
  }

  const findings = blockingFindings(
    context.draft,
    context.records,
    "blocks_claim",
  );
  if (findings.length > 0) {
    return refused(
      "lint_blocked",
      findings.map((finding) => finding.message),
      "Attach resolvable evidence for every covered criterion and claim again.",
      findings,
    );
  }

  return allowed();
}

export function grantWaiver(context: WaiverContext): TransitionDecision {
  const unmetConditions: string[] = [];
  if (context.actor.kind !== "human") {
    unmetConditions.push("Waiver grant is a human-only act.");
  }
  if (context.reason.trim().length === 0) {
    unmetConditions.push("A waiver requires a reason.");
  }
  if (unmetConditions.length > 0) {
    return refused(
      context.actor.kind !== "human" ? "human_act_required" : "validation",
      unmetConditions,
      context.actor.kind !== "human"
        ? "Ask a human to grant the waiver with a reason in Spec Studio."
        : "Provide a reason for the waiver.",
    );
  }

  if (context.existingWaiver) {
    return refused(
      "gate_blocked",
      ["This criterion and revision already has a terminal waiver decision."],
      "Use the existing waiver or create an amendment for a changed criterion.",
    );
  }

  return allowed();
}

export function changePolicy(context: PolicyChangeContext): TransitionDecision {
  if (context.actor.kind !== "human") {
    return refused(
      "human_act_required",
      ["Gate policy changes are human-only acts."],
      "Ask a human to change the policy in Spec Studio.",
    );
  }

  if (context.proposedPolicy.overrides?.delivery === "off") {
    return refused(
      "gate_blocked",
      ["The delivery gate can be Notify or Gate, but never Off."],
      "Set the delivery override to Notify or Gate.",
    );
  }

  if (
    !context.hardConfirmed &&
    policyChangeRequiresHardConfirmation(
      context.currentPolicy,
      context.proposedPolicy,
    )
  ) {
    return refused(
      "human_act_required",
      ["Preset switches and gate loosening require hard human confirmation."],
      "Hard-confirm the prospective policy change in Spec Studio.",
    );
  }

  return allowed();
}

function validWaiver(
  waiver: DeliveryWaiverSnapshot | null,
  pinnedRevisionId: string,
): boolean {
  return (
    waiver !== null &&
    waiver.revisionId === pinnedRevisionId &&
    waiver.grantedByHuman &&
    waiver.reason.trim().length > 0 &&
    !waiver.stale
  );
}

export function evaluateDeliveryGate(
  context: DeliveryGateContext,
): DeliveryGateResult {
  if (context.executionState !== "running") {
    return refused(
      "gate_blocked",
      [
        `Delivery requires a running execution; this execution is ${context.executionState}.`,
      ],
      "The execution is terminal or has not started; delivery cannot proceed from this state.",
    );
  }

  if (isExploratoryShippingRefused(context.policy)) {
    return refused(
      "delivery_gate_failed",
      ["Exploratory specs cannot merge."],
      "Switch the spec to a shipping-capable preset through a human-confirmed policy change.",
    );
  }

  const pinnedRevisionId = context.pinnedRevisionId;
  const pinnedScope = context.pinnedScope;
  const pinConditions: string[] = [];
  if (!pinnedRevisionId) {
    pinConditions.push("Delivery requires the execution's pinned revision.");
  }
  if (!pinnedScope) {
    pinConditions.push("Delivery requires the execution's pinned scope.");
  } else if (pinnedScope.selectedCriterionIds.length === 0) {
    pinConditions.push("Delivery scope selects no criteria.");
  }
  if (
    !pinnedRevisionId ||
    !pinnedScope ||
    pinnedScope.selectedCriterionIds.length === 0
  ) {
    return refused(
      "invalid_scope",
      pinConditions,
      "Restore the execution's immutable revision and scope pin before merging.",
    );
  }

  if (
    resolveDial(context.policy, "delivery") === "gate" &&
    !context.deliveryApprovalGranted
  ) {
    return refused(
      "gate_blocked",
      ["The delivery gate requires human approval."],
      "Ask a human to approve delivery in Spec Studio.",
    );
  }

  const criteriaById = new Map(
    context.criteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  const unmetConditions: string[] = [];

  for (const criterionId of pinnedScope.selectedCriterionIds) {
    const criterion = criteriaById.get(criterionId);
    if (!criterion) {
      unmetConditions.push(
        `${criterionId} has no loaded delivery state for the pinned scope.`,
      );
      continue;
    }

    if (
      criterion.validProof ||
      validWaiver(criterion.waiver, pinnedRevisionId) ||
      criterion.deliveredByMergedExecution
    ) {
      continue;
    }

    unmetConditions.push(
      `${criterion.handle} needs valid proof, a valid human waiver for ${pinnedRevisionId}, or prior merged delivery.`,
    );
  }

  if (unmetConditions.length > 0) {
    return refused(
      "delivery_gate_failed",
      unmetConditions,
      "Re-dispatch validation against the prepared candidate, obtain any required human waiver, or repair the delivery scope before merging.",
    );
  }

  return allowed();
}
