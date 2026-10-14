import type {
  ApprovalCitationState,
  ApprovalApplicability,
  ApprovalRecord,
} from "./approval-applicability";
import {
  activeAuthoringStages,
  authoringStageForElement,
  authoringStageIndex,
  consultedAuthoringGates,
  nextAuthoringStage,
  type AuthoringGate,
} from "./authoring-gates";
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
  type RevisionCitation,
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
  SpecGatePolicy,
  SpecRevisionState,
} from "./schemas";

export {
  authoringStages,
  consultedAuthoringGates,
  nextAuthoringStage,
  type AuthoringGate,
} from "./authoring-gates";

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

export interface OpenDraftSnapshot {
  revisionNumber: number;
  authoringStage: SpecAuthoringStage;
}

export interface PolicyChangeContext {
  actor: ActorProvenance;
  currentPolicy: SpecGatePolicy;
  proposedPolicy: SpecGatePolicy;
  hardConfirmed: boolean;
  /** Absent when no draft is open; an approved revision is never one. */
  openDraft?: OpenDraftSnapshot;
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

export type ResolvedAuthoringDials = Record<AuthoringGate, ResolvedGateDial>;

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
  if (stage === "plan")
    return refused(
      "stage_blocked",
      ["Legacy plan revisions are read-only."],
      "Open a design amendment.",
    );
  const elementStage = authoringStageForElement(elementKind, sectionRole);
  const elementStagePosition = authoringStageIndex(elementStage);
  const currentStagePosition = authoringStageIndex(stage);
  if (elementStagePosition === currentStagePosition) {
    return allowed();
  }

  const label = elementLabel(elementKind, sectionRole);
  if (elementStage === "plan") {
    return refused(
      "stage_blocked",
      [
        `A ${label} is legacy read-only content. Plan implementation with a run.`,
      ],
      "Create implementation work with `cctl run launch`.",
      { rationale: PLAN_IN_EVERGREEN_RATIONALE },
    );
  }
  if (elementStagePosition < currentStagePosition) {
    return refused(
      "stage_blocked",
      [`A ${label} cannot be authored during the ${stage} stage.`],
      `Return to the ${elementStage} stage before authoring ${label} content.`,
      { rationale: LATER_STAGE_RATIONALE },
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
    return "design";
  }

  return "requirements";
}

export function advanceAuthoringStage(
  stage: SpecAuthoringStage,
  policy: SpecGatePolicy,
): TransitionDecision {
  if (nextAuthoringStage(stage) === null) {
    return refused(
      "gate_blocked",
      ["Design is the final evergreen authoring stage."],
      "Propose the design stage when it is ready for review.",
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
 * Sign-off freezes the draft, so it owes every blocking finding: the ones
 * that also stop the author's review request and the ones only a frozen
 * revision cannot carry.
 */
function signOffBlockingFindings(
  draft: RevisionSnapshot,
  records: SpecRecords,
): LintFinding[] {
  return lint(draft, records).filter(
    (finding) => finding.severity !== "advisory",
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
  const signOffFindings = signOffBlockingFindings(draft, records);
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

/**
 * The author's review request. It changes no state: the draft stays editable
 * and reviewable. Only when every consulted gate is Notify or Off does it
 * freeze the draft itself, because no human act follows to do it.
 */
export function propose(context: ProposeContext): TransitionDecision {
  if (context.authoringStage === "plan")
    return refused(
      "stage_blocked",
      ["Legacy plan revisions are read-only."],
      "Open a design amendment.",
    );
  if (context.revisionState !== "draft") {
    return refused(
      "gate_blocked",
      ["Only a draft revision can be proposed."],
      "Open or reuse a draft revision before proposing it.",
    );
  }

  // What blocks propose is read from the shared projection rather than
  // re-filtered here, so the refusal, `cctl spec lint`, the status tier, and
  // Studio's inline lint summary cannot disagree about which findings are blocking.
  const health = draftHealth(lint(context.draft, context.records));
  if (health.blocking > 0) {
    return refused(
      "lint_blocked",
      health.blockingFindings.map((finding) => finding.message),
      `Nothing was proposed for revision ${context.review.revisionId}. Run \`cctl spec lint ${context.draft.specHandle}\`, resolve every blocking finding it reports, then re-run \`cctl spec propose ${context.draft.specHandle} --notes-file <notes.md>\`.`,
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

  if (context.revisionState !== "draft") {
    return refused(
      "gate_blocked",
      ["Elements can be approved only on the open draft."],
      "Open an amendment to change approved content.",
    );
  }

  return allowed();
}

export function signOffRevision(context: SignOffContext): TransitionDecision {
  if (context.authoringStage === "plan")
    return refused(
      "stage_blocked",
      ["Legacy plan revisions are read-only."],
      "Open a design amendment.",
    );
  if (context.revisionState === "approved") {
    return allowed();
  }
  if (context.revisionState !== "draft") {
    return refused(
      "gate_blocked",
      ["Only the open draft can be signed off."],
      "Open an amendment to change approved content.",
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

export function changePolicy(context: PolicyChangeContext): TransitionDecision {
  if (context.actor.kind !== "human") {
    return refused(
      "human_act_required",
      ["Gate policy changes are human-only acts."],
      "Ask a human to change the policy in Spec Studio.",
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
        `Sign off or withdraw revision ${draft.revisionNumber} before changing the policy.`,
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
