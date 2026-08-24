import type {
  ApprovalCitationState,
  ApprovalApplicability,
  ApprovalRecord,
} from "./approval-applicability";
import { draftHealth } from "./draft-health";
import { elementApprovalBasis } from "./import-baseline";
import {
  lint,
  type LintFinding,
  type RevisionSnapshot,
  type SpecRecords,
} from "./lint";
import {
  COMBINED_APPROVAL_DIAL,
  authoringApprovalsCollapseIntoSignOff,
  dialRequiresHumanApproval,
  isExploratoryShippingRefused,
  policyChangeRequiresHardConfirmation,
  resolveDial,
  type ResolvedGateDial,
} from "./policy";
import {
  LATER_STAGE_RATIONALE,
  PLAN_IN_EVERGREEN_RATIONALE,
  rationaleForCode,
} from "./refusal-rationale";
import {
  diffRevisions,
  type RevisionCitation,
  type RevisionCitationDiffContext,
  type RevisionElement as DiffRevisionElement,
} from "./revision-diff";
import type {
  ActorProvenance,
  Refusal,
  RefusalCode,
  SectionRole,
  SpecApprovalSubjectKind,
  SpecAuthoringStage,
  SpecElementKind,
  SpecExecutionState,
  SpecGate,
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
  /**
   * Self-identifying discriminator for the one delivery-gate refusal a human
   * approval clears. Set ONLY by the missing-delivery-approval branch of
   * `evaluateDeliveryGate`; every other refusal (terminal state, exploratory
   * shipping, invalid pin/scope, unmet criteria) leaves it unset so callers
   * never auto-request an approval a human act cannot satisfy.
   */
  reason?: "approval_required";
};

export type TransitionDecision =
  | { ok: true }
  | { ok: false; refusal: TransitionRefusal };

export type DeliveryGateResult = TransitionDecision;

export interface ReviewThreadSnapshot {
  handle: string;
  resolved: boolean;
}

export type ApprovalSnapshot = ApprovalRecord;

export interface SignOffReviewSnapshot {
  revisionId: string;
  /** Null when no ancestor of this revision has ever been approved. */
  governanceBaseRevisionId: string | null;
  /**
   * The nearest approved ancestor's rows, empty when there is none. Governs
   * which gates still owe an admission: an obligation introduced by a
   * withdrawn attempt is unchanged against the immediate parent but still
   * unadmitted against the last thing a human approved.
   */
  governanceBaseRevisionRows: DiffRevisionElement[];
  governanceBaseCitationState: ApprovalCitationState;
  revisionRows: DiffRevisionElement[];
  citationContractVersion: 1 | 2;
  citations: readonly RevisionCitation[];
  /**
   * The import baseline revision's rows, null for every spec no import
   * created. See `elementApprovalBasis` for what they carry.
   */
  importBaselineRows: readonly DiffRevisionElement[] | null;
  importBaselineCitationState: ApprovalCitationState | null;
  blockingThreads: ReviewThreadSnapshot[];
  approvals: ApprovalSnapshot[];
}

export interface ProposeContext {
  revisionState: SpecRevisionState;
  authoringStage: SpecAuthoringStage;
  policy: SpecGatePolicy;
  draft: RevisionSnapshot;
  records: SpecRecords;
  review: SignOffReviewSnapshot;
  approvalApplies: ApprovalApplicability;
}

export interface ElementApprovalContext {
  actor: ActorProvenance;
  revisionState: SpecRevisionState;
  subjectKind: Extract<SpecApprovalSubjectKind, "requirement" | "decision">;
}

export interface SignOffContext {
  actor: ActorProvenance;
  revisionState: SpecRevisionState;
  authoringStage: SpecAuthoringStage;
  policy: SpecGatePolicy;
  draft: RevisionSnapshot;
  records: SpecRecords;
  review: SignOffReviewSnapshot;
  approvalApplies: ApprovalApplicability;
}

export interface StartExecutionContext {
  policy: SpecGatePolicy;
  specAbandoned: boolean;
  revisionId?: string;
  revisionState: SpecRevisionState;
  authoringStage: SpecAuthoringStage;
  scope?: ExecutionScope;
  plan: ScopePlan;
  activeExecution: boolean;
}

export interface WaiverContext {
  actor: ActorProvenance;
  reason: string;
  existingWaiver: boolean;
}

export interface OpenDraftSnapshot {
  revisionNumber: number;
  authoringStage: SpecAuthoringStage;
}

export interface PolicyChangeContext {
  actor: ActorProvenance;
  currentPolicy: SpecGatePolicy;
  proposedPolicy: SpecGatePolicy;
  hardConfirmed: boolean;
  /** Absent when no draft is open; a proposed or approved revision is never one. */
  openDraft?: OpenDraftSnapshot;
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

/**
 * A code whose reason is the same wherever it is raised gets that reason here
 * rather than at each predicate; `extra.rationale` is for the codes whose
 * reason differs per branch.
 */
function refused(
  code: RefusalCode,
  unmetConditions: string[],
  instruction: string,
  extra?: { findings?: LintFinding[]; rationale?: string },
): TransitionDecision {
  const rationale = extra?.rationale ?? rationaleForCode(code);
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions,
      ...(extra?.findings === undefined ? {} : { findings: extra.findings }),
      ...(rationale === undefined ? {} : { rationale }),
      instruction,
    },
  };
}

export type AuthoringGate = Extract<
  SpecGate,
  "requirements" | "design" | "plan"
>;
export type ResolvedAuthoringDials = Record<AuthoringGate, ResolvedGateDial>;

export const authoringStages: readonly SpecAuthoringStage[] = [
  "requirements",
  "design",
  "plan",
];

export const activeAuthoringStages: readonly SpecAuthoringStage[] = [
  "requirements",
  "design",
];

export function authoringStageIndex(stage: SpecAuthoringStage): number {
  return authoringStages.indexOf(stage);
}

function stageForElement(
  kind: SpecElementKind,
  sectionRole?: SectionRole,
): SpecAuthoringStage {
  if (kind === "task") return "plan";
  if (kind === "decision") return "design";
  if (kind === "section" && sectionRole === "design_narrative") {
    return "design";
  }
  return "requirements";
}

function elementLabel(
  kind: SpecElementKind,
  sectionRole?: SectionRole,
): string {
  if (kind !== "section") return kind;
  return sectionRole === undefined
    ? "section"
    : `${sectionRole.replaceAll("_", "-")} section`;
}

export function resolveAuthoringDials(
  policy: SpecGatePolicy,
): ResolvedAuthoringDials {
  return {
    requirements: resolveDial(policy, "requirements"),
    design: resolveDial(policy, "design"),
    plan: resolveDial(policy, "plan"),
  };
}

export function admitDraftWrite(
  stage: SpecAuthoringStage,
  elementKind: SpecElementKind,
  sectionRole: SectionRole | undefined,
  resolvedDials: ResolvedAuthoringDials,
): TransitionDecision {
  const elementStage = stageForElement(elementKind, sectionRole);
  if (authoringStageIndex(elementStage) <= authoringStageIndex(stage)) {
    return allowed();
  }

  const label = elementLabel(elementKind, sectionRole);
  if (elementStage === "plan") {
    return refused(
      "stage_blocked",
      [
        `A ${label} is authored in a delivery plan attempt, not an evergreen revision.`,
      ],
      "Complete evergreen design review, then run `cctl spec plan open <slug>` and author the graph with `cctl spec plan edit <slug> --file <plan.json>`.",
      { rationale: PLAN_IN_EVERGREEN_RATIONALE },
    );
  }
  const dial = resolvedDials[stage];
  const instruction =
    dial === "notify" || dial === "off"
      ? `Advance the ${stage} stage before authoring ${label} content.`
      : `Propose the ${stage} stage and obtain sign-off before authoring ${label} content.`;
  return refused(
    "stage_blocked",
    [`A ${label} cannot be authored during the ${stage} stage.`],
    instruction,
    { rationale: LATER_STAGE_RATIONALE },
  );
}

export interface OpenDraftAuthoringStageContext {
  policy: SpecGatePolicy;
  baseRevision?: {
    state: Extract<SpecRevisionState, "approved" | "withdrawn">;
    authoringStage: SpecAuthoringStage;
  };
}

export function openDraftAuthoringStage(
  context: OpenDraftAuthoringStageContext,
): SpecAuthoringStage {
  const base = context.baseRevision;
  if (base?.state === "withdrawn") {
    return base.authoringStage === "plan" ? "design" : base.authoringStage;
  }
  if (base?.state === "approved") {
    return nextAuthoringStage(base.authoringStage) ?? "design";
  }

  return authoringApprovalsCollapseIntoSignOff(context.policy)
    ? "design"
    : "requirements";
}

export function nextAuthoringStage(
  stage: SpecAuthoringStage,
): SpecAuthoringStage | null {
  const index = activeAuthoringStages.indexOf(stage);
  if (index === -1) return null;
  return activeAuthoringStages[index + 1] ?? null;
}

export function advanceAuthoringStage(
  stage: SpecAuthoringStage,
  policy: SpecGatePolicy,
): TransitionDecision {
  if (nextAuthoringStage(stage) === null) {
    return refused(
      "gate_blocked",
      ["Design is the final evergreen authoring stage."],
      "Propose the design stage when it is ready for review, then run `cctl spec plan open <slug>` after sign-off.",
    );
  }
  const dial = resolveDial(policy, stage);
  if (dial === "notify" || dial === "off") return allowed();
  return refused(
    "human_act_required",
    [`The ${stage} gate requires human sign-off before advancing.`],
    `Propose the ${stage} stage and obtain human sign-off instead of advancing it directly.`,
  );
}

/**
 * The gates a transition on this revision consults: the current authoring
 * stage, plus every earlier stage whose content differs from the GOVERNANCE
 * baseline — the nearest approved ancestor.
 *
 * The governance baseline rather than the immediate parent is what makes the
 * set cumulative. A change that entered through an attempt a human withdrew is
 * unchanged against that attempt, so an immediate-parent comparison drops the
 * gate and the follow-up revision inherits an admission it never earned.
 */
export function consultedAuthoringGates(
  stage: SpecAuthoringStage,
  governanceBaseRows: DiffRevisionElement[],
  revisionRows: DiffRevisionElement[],
  citations: RevisionCitationDiffContext,
): AuthoringGate[] {
  const diff = diffRevisions(governanceBaseRows, revisionRows, citations);
  const baseById = new Map(
    governanceBaseRows.map((row) => [row.elementId, row]),
  );
  const revisionById = new Map(revisionRows.map((row) => [row.elementId, row]));
  const consulted = new Set<AuthoringGate>([stage]);
  const currentStageIndex = authoringStageIndex(stage);

  for (const classification of diff.classifications) {
    if (classification.classification === "unchanged") continue;
    const row =
      revisionById.get(classification.elementId) ??
      baseById.get(classification.elementId);
    if (row === undefined) continue;
    const elementStage = stageForElement(
      row.payload.kind,
      row.payload.kind === "section" ? row.payload.role : undefined,
    );
    if (authoringStageIndex(elementStage) < currentStageIndex) {
      consulted.add(elementStage);
    }
  }

  return authoringStages.filter((candidate) => consulted.has(candidate));
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

function approvalHeld(
  approvals: readonly ApprovalSnapshot[],
  applies: ApprovalApplicability,
  subjectKind: ApprovalSnapshot["subjectKind"],
  elementId: string | null,
): boolean {
  return approvals.some(
    (approval) =>
      approval.subjectKind === subjectKind &&
      approval.elementId === elementId &&
      applies(approval),
  );
}

function handleByElementId(draft: RevisionSnapshot): Map<string, string> {
  return new Map(draft.elements.map((element) => [element.id, element.handle]));
}

/**
 * What `approvalUnmetConditions` reads. Stated as its own context rather than
 * as a sign-off snapshot so the read projection can ask the same question of
 * the same authority without inventing the review fields it does not have.
 */
export interface ApprovalConditionsContext {
  policy: SpecGatePolicy;
  authoringStage: SpecAuthoringStage;
  revisionId: string;
  governanceBaseRevisionRows: DiffRevisionElement[];
  governanceBaseCitationState: ApprovalCitationState;
  revisionRows: DiffRevisionElement[];
  revisionCitationState: ApprovalCitationState;
  approvals: readonly ApprovalSnapshot[];
  /** Element id to the handle the condition text addresses it by. */
  handles: ReadonlyMap<string, string>;
  approvalApplies: ApprovalApplicability;
  /** The import baseline revision's rows; null for a natively authored spec. */
  importBaselineRows: readonly DiffRevisionElement[] | null;
  importBaselineCitationState: ApprovalCitationState | null;
}

export function approvalUnmetConditions(
  context: ApprovalConditionsContext,
): string[] {
  const { policy, authoringStage, handles, approvalApplies, revisionId } =
    context;
  const requirementsDial = resolveDial(policy, "requirements");
  const designDial = resolveDial(policy, "design");
  const planDial = resolveDial(policy, "plan");

  if (authoringApprovalsCollapseIntoSignOff(policy, authoringStage)) {
    // The combined dial collapses per-element approvals into one human act:
    // the sign-off itself (R11.5). signOffRevision refuses non-human actors
    // before reaching these preconditions, and propose absorbs sign-off only
    // when every dial is Notify/Off, so no combined-dial transition can get
    // here without a human sign-off in progress.
    return [];
  }

  const consulted = new Set(
    consultedAuthoringGates(
      authoringStage,
      context.governanceBaseRevisionRows,
      context.revisionRows,
      {
        baseCitationContractVersion:
          context.governanceBaseCitationState.citationContractVersion,
        draftCitationContractVersion:
          context.revisionCitationState.citationContractVersion,
        baseCitations: context.governanceBaseCitationState.citations,
        draftCitations: context.revisionCitationState.citations,
      },
    ),
  );
  const unmetConditions: string[] = [];

  const requireElementApprovals = (
    dial: ResolvedGateDial,
    kind: "requirement" | "decision",
    label: "Requirement" | "Decision",
  ): void => {
    if (!dialRequiresHumanApproval(dial)) {
      return;
    }

    const elements = context.revisionRows
      .filter((row) => row.payload.kind === kind)
      .sort((left, right) => left.elementId.localeCompare(right.elementId));

    for (const element of elements) {
      if (
        elementApprovalBasis({
          approvalHeld: approvalHeld(
            context.approvals,
            approvalApplies,
            kind,
            element.elementId,
          ),
          subject: { subjectKind: kind, elementId: element.elementId },
          revisionRows: context.revisionRows,
          revisionCitationState: context.revisionCitationState,
          importBaselineRows: context.importBaselineRows,
          importBaselineCitationState: context.importBaselineCitationState,
        }) !== null
      ) {
        continue;
      }

      const handle = handles.get(element.elementId) ?? element.elementId;
      unmetConditions.push(
        `${label} ${handle} needs a valid approval for ${revisionId}.`,
      );
    }
  };

  if (consulted.has("requirements")) {
    requireElementApprovals(requirementsDial, "requirement", "Requirement");
  }
  if (consulted.has("design")) {
    requireElementApprovals(designDial, "decision", "Decision");
  }

  if (
    authoringStage === "plan" &&
    dialRequiresHumanApproval(planDial) &&
    !approvalHeld(context.approvals, approvalApplies, "plan", null)
  ) {
    unmetConditions.push(
      `Execution plan needs a valid approval for ${revisionId}.`,
    );
  }

  return unmetConditions;
}

export function unresolvedThreadConditions(
  blockingThreads: readonly ReviewThreadSnapshot[],
): string[] {
  return blockingThreads
    .filter((thread) => !thread.resolved)
    .sort((left, right) => left.handle.localeCompare(right.handle))
    .map((thread) => `Blocking thread ${thread.handle} is unresolved.`);
}

function signOffPreconditions(
  policy: SpecGatePolicy,
  authoringStage: SpecAuthoringStage,
  draft: RevisionSnapshot,
  records: SpecRecords,
  review: SignOffReviewSnapshot,
  approvalApplies: ApprovalApplicability,
): TransitionDecision {
  const signOffFindings = blockingFindings(draft, records, "blocks_signoff");
  const threadConditions = unresolvedThreadConditions(review.blockingThreads);
  const approvalConditions = approvalUnmetConditions({
    policy,
    authoringStage,
    revisionId: review.revisionId,
    governanceBaseRevisionRows: review.governanceBaseRevisionRows,
    governanceBaseCitationState: review.governanceBaseCitationState,
    revisionRows: review.revisionRows,
    revisionCitationState: {
      citationContractVersion: review.citationContractVersion,
      citations: review.citations,
    },
    approvals: review.approvals,
    handles: handleByElementId(draft),
    approvalApplies,
    importBaselineRows: review.importBaselineRows,
    importBaselineCitationState: review.importBaselineCitationState,
  });
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
    signOffFindings.length > 0 ? { findings: signOffFindings } : undefined,
  );
}

function proposeDials(
  policy: SpecGatePolicy,
  authoringStage: SpecAuthoringStage,
  review: SignOffReviewSnapshot,
): ResolvedGateDial[] {
  return consultedAuthoringGates(
    authoringStage,
    review.governanceBaseRevisionRows,
    review.revisionRows,
    {
      baseCitationContractVersion:
        review.governanceBaseCitationState.citationContractVersion,
      draftCitationContractVersion: review.citationContractVersion,
      baseCitations: review.governanceBaseCitationState.citations,
      draftCitations: review.citations,
    },
  ).map((gate) => resolveDial(policy, gate));
}

export function propose(context: ProposeContext): TransitionDecision {
  if (context.revisionState !== "draft") {
    return refused(
      "gate_blocked",
      ["Only a draft revision can be proposed."],
      "Open or reuse a draft revision before proposing it.",
    );
  }

  // What blocks propose is read from the shared projection rather than
  // re-filtered here, so the refusal, `cctl spec lint`, the status tier, and
  // Studio's lint tab cannot disagree about which findings are blocking.
  const health = draftHealth(lint(context.draft, context.records));
  if (health.blocking > 0) {
    return refused(
      "lint_blocked",
      health.blockingFindings.map((finding) => finding.message),
      `Nothing was proposed for revision ${context.review.revisionId}. Run \`cctl spec lint ${context.draft.specHandle}\`, resolve every blocking finding it reports, then re-run \`cctl spec propose ${context.draft.specHandle} --notes <notes.md>\`.`,
      { findings: [...health.ordered] },
    );
  }

  const dials = proposeDials(
    context.policy,
    context.authoringStage,
    context.review,
  );
  const absorbsSignOff = dials.every(
    (dial) => dial === "notify" || dial === "off",
  );
  if (!absorbsSignOff) {
    return allowed();
  }

  return signOffPreconditions(
    context.policy,
    context.authoringStage,
    context.draft,
    context.records,
    context.review,
    context.approvalApplies,
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

  const humanRequired = proposeDials(
    context.policy,
    context.authoringStage,
    context.review,
  ).some(dialRequiresHumanApproval);
  if (humanRequired && context.actor.kind !== "human") {
    return refused(
      "human_act_required",
      ["The configured sign-off gates require a human actor."],
      "Ask a human to sign off the revision in Spec Studio.",
    );
  }

  return signOffPreconditions(
    context.policy,
    context.authoringStage,
    context.draft,
    context.records,
    context.review,
    context.approvalApplies,
  );
}

/**
 * Classifies the archived evergreen Plan-stage start contract. Production
 * starts resolve and launch an approved DeliveryPlanAttempt through
 * ExecutionService; this remains for legacy revision compatibility tests.
 */
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

  if (context.authoringStage !== "plan") {
    return refused(
      "gate_blocked",
      ["The pinned revision has not completed plan-stage authoring."],
      "Complete plan-stage authoring and sign off that revision before starting execution.",
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

  const draft = context.openDraft;
  if (draft !== undefined) {
    const undecided = undecidedAuthoringStages(
      context.proposedPolicy,
      draft.authoringStage,
    );
    if (
      undecided.length > 0 &&
      authoringStageIndex(draft.authoringStage) >
        authoringStageIndex(
          openDraftAuthoringStage({ policy: context.proposedPolicy }),
        )
    ) {
      return refused(
        "gate_blocked",
        [
          `Revision ${draft.revisionNumber} is open at the ${draft.authoringStage} stage and the proposed policy does not state what ${undecided.join(", ")} would conclude with.`,
        ],
        `Propose or abandon revision ${draft.revisionNumber} before changing the policy.`,
      );
    }
  }

  return allowed();
}

/**
 * R25.6's backstop: the remaining stages whose concluding transition the
 * proposed policy does not decide. Every dial the policy schema can express is
 * decided today, so this is empty for every expressible shape — the exhaustive
 * switch exists so a new dial value fails to compile until its staging
 * consequence is stated, rather than silently inheriting one.
 */
export function undecidedAuthoringStages(
  policy: SpecGatePolicy,
  pinnedStage: SpecAuthoringStage,
): SpecAuthoringStage[] {
  const remainingStages =
    pinnedStage === "plan"
      ? (["plan"] as const)
      : activeAuthoringStages.slice(authoringStageIndex(pinnedStage));
  return remainingStages.filter(
    (stage) => !stagingDecided(resolveDial(policy, stage)),
  );
}

function stagingDecided(dial: ResolvedGateDial): boolean {
  // Gate and combined conclude a stage with a human sign-off; Notify and Off
  // conclude it with a recorded advance. A dial with no case here leaves the
  // function without a return and fails to compile.
  switch (dial) {
    case "gate":
    case COMBINED_APPROVAL_DIAL:
    case "notify":
    case "off":
      return true;
  }
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
    return {
      ok: false,
      refusal: {
        code: "gate_blocked",
        reason: "approval_required",
        unmetConditions: ["The delivery gate requires human approval."],
        instruction:
          "Approve delivery in Spec Studio: open the spec's Controls view → Merge gate → Approve delivery for merge, then resume the merge.",
      },
    };
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
      "Repair or replace the graph execution until each required authored claimant has valid proof, obtain any required human waiver, or repair the delivery scope before merging.",
    );
  }

  return allowed();
}
