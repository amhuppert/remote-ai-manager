import type {
  ApprovalApplicability,
  ApprovalCitationState,
  ApprovalSubjectKind,
} from "./approval-applicability";
import {
  APPROVAL_CARRY_RULE,
  emptyApprovalLedger,
  type ApprovalLedger,
  type ApprovalLedgerClass,
  type ApprovalLedgerSubject,
} from "./approval-ledger";
import {
  EXECUTION_SCOPED_GATES,
  approvalHeld,
  elementHandle,
  executionGateActionable,
  parseProvenance,
  type PendingApproval,
} from "./gate-projection";
import {
  elementApprovalBasis,
  type ElementApprovalBasis,
} from "./import-baseline";
import type { LintFinding } from "./lint";
import {
  authoringApprovalsCollapseIntoSignOff,
  dialRequiresHumanApproval,
  resolveDial,
} from "./policy";
import {
  toCitationDiffContext,
  toDiffCitations,
  toDiffRows,
} from "./review-state";
import type { RevisionElement } from "./revision-diff";
import {
  specGateSchema,
  type ActorProvenance,
  type ResolvedGateDial,
  type SpecApprovalRow,
  type SpecExecutionRow,
  type SpecGate,
  type SpecGateAdmissionRow,
  type SpecGatePolicy,
  type SpecRevisionSnapshot,
} from "./schemas";
import {
  approvalUnmetConditions,
  consultedAuthoringGates,
  unresolvedThreadConditions,
  type AuthoringGate,
  type ReviewThreadSnapshot,
} from "./transitions";

/**
 * Why a gate does or does not ask something of this revision.
 *
 * `current_stage` and `changed_since_governance_base` are the two ways a gate
 * is consulted; the other two are the two ways it is not. The baseline is
 * always the nearest APPROVED ancestor, never the immediate parent: an
 * obligation introduced by an attempt a human withdrew is unchanged against
 * that attempt and still unadmitted against the last thing anyone approved.
 *
 * The execution-scoped gates are applicable per run rather than per stage, so
 * the stage reasons do not describe them: they read `current_stage` exactly
 * while a run can receive the act, and `dial_off` — "asks nothing of a human
 * right now" — both when the dial requires no approval and when no run is in a
 * position to be admitted. A withdrawn revision reads `dial_off` for the same
 * reason: it is terminal, so no transition will consult its gates again.
 */
export type SpecGateApplicabilityReason =
  | "current_stage"
  | "changed_since_governance_base"
  | "unchanged_since_governance_base"
  | "dial_off";

export interface SpecGateApplicability {
  reason: SpecGateApplicabilityReason;
  /** Null when no ancestor of the current revision has ever been approved. */
  governanceBaseRevisionId: string | null;
}

/**
 * One admission row in projection shape. Whether it satisfies anything is said
 * by which list it lands in — `currentAdmissions` or `priorAdmissions` — and
 * never by the record itself.
 */
export interface SpecGateAdmissionRecord {
  revisionId: string;
  revisionNumber: number;
  /** The run the admission covered, for the per-execution gates. */
  executionId: string | null;
  basis: SpecGateAdmissionRow["basis"];
  actor: ActorProvenance | null;
  admittedAt: string;
}

export interface ProjectedGateStatus {
  gate: SpecGate;
  dial: ResolvedGateDial;
  state: "pending" | "admitted" | "not_required";
  applicability: SpecGateApplicability;
  /**
   * Admissions this gate holds for the revision (or run) the projection reads.
   * These are what explain who admitted the CURRENT revision.
   */
  currentAdmissions: SpecGateAdmissionRecord[];
  /**
   * Admissions from other revisions or runs. Strictly historical provenance
   * (Requirement 24.13): nothing here asserts the gate is satisfied now, and
   * no consumer may fold them into `state`.
   */
  priorAdmissions: SpecGateAdmissionRecord[];
}

export interface RevisionSignOffProjection {
  revisionId: string;
  revisionNumber: number;
  /**
   * `ready` is the position a consulted human gate reaches once its last
   * subject is approved: the gate stays pending until a human signs the
   * revision off, because sign-off is never a side effect of approving the
   * last element.
   */
  state: "blocked" | "ready" | "signed_off";
  outstandingSubjectCount: number;
  unmetConditions: string[];
  approval: SpecApprovalRow | null;
}

export interface PendingGateBlock {
  gate: SpecGate;
  dial: ResolvedGateDial;
  state: ProjectedGateStatus["state"];
  applicability: SpecGateApplicability;
  /** The outstanding subject handles this gate is waiting on. */
  subjects: string[];
  /**
   * Subject handles this gate asks nobody for because the import that created
   * them admitted them. Reported beside `subjects`, never folded into it or
   * silently dropped: absence from the outstanding list is how a surface
   * concludes "approved", and no human approved these.
   */
  importCarriedSubjects: string[];
}

/**
 * A subject settled by an import admission rather than by a human. It is
 * neither pending — nobody is being asked for it — nor approved: no approval
 * row exists and no human read the content. Surfaces render it from here so
 * they can say what is true of it.
 */
export interface ImportCarriedApproval {
  gate: SpecGate;
  subject: string;
  elementId: string;
}

/**
 * Everything a transition response has to say about what still blocks the
 * revision, authored where the truth lives. A caller renders it; it never
 * derives its own blocker from the authoring stage, which names the wrong gate
 * whenever an earlier stage is also consulted.
 */
export interface AuthoringPendingBlock {
  actsNext: "human" | "agent";
  gates: PendingGateBlock[];
  outstandingSubjects: PendingApproval[];
  signOff: RevisionSignOffProjection | null;
  /** Blocking threads and sign-off lint findings block too, not only subjects. */
  unmetConditions: string[];
  display: string;
  instruction: string;
}

export interface AuthoringNextAction {
  kind:
    | "approve_gate"
    | "approve_subject"
    | "sign_off_revision"
    | "resolve_conditions"
    | "propose"
    | "amend"
    | "none";
  actsNext: "human" | "agent" | null;
  gate: SpecGate | null;
  subject: string | null;
  elementId: string | null;
  instruction: string;
}

/** One open review comment, as the projection needs it: where and how hard. */
export interface OpenCommentSnapshot {
  threadId: string;
  elementId: string;
  /** The element's handle where the current revision still carries it. */
  handle: string | null;
  blocking: boolean;
}

export interface ProjectedOpenComments {
  count: number;
  blockingCount: number;
  openThreadCount: number;
  openBlockingThreadCount: number;
  /** Deduped subject labels — handle when carried, element id otherwise — in first-seen order. */
  subjects: string[];
}

export interface AuthoringReviewProjection {
  /** The gates this revision's transition consults, in gate order. */
  applicableGates: SpecGate[];
  gates: ProjectedGateStatus[];
  pendingApprovals: PendingApproval[];
  /**
   * Consulted subjects an import admission settles. Empty for every natively
   * authored spec, and empty again once a human approves the subject itself.
   */
  importCarriedApprovals: ImportCarriedApproval[];
  /**
   * Every consulted subject with the act that settles it, or that none does.
   * Read beside `pendingApprovals` rather than derived from it: a collapsed
   * gate owes no per-subject approval and still governs its subjects.
   */
  approvalLedger: ApprovalLedger;
  revisionSignOff: RevisionSignOffProjection | null;
  pendingBlock: AuthoringPendingBlock | null;
  nextAction: AuthoringNextAction;
  /** Null when the caller supplied no open comments — feedback is then simply unknown here. */
  openComments: ProjectedOpenComments | null;
}

export interface AuthoringReviewProjectionInput {
  policy: SpecGatePolicy;
  /** The revision every read projection calls current; null for an empty spec. */
  snapshot: SpecRevisionSnapshot | null;
  /** The nearest approved ancestor of that revision, null when there is none. */
  governanceBaseSnapshot: SpecRevisionSnapshot | null;
  approvals: readonly SpecApprovalRow[];
  admissions: readonly SpecGateAdmissionRow[];
  /**
   * The import baseline revision's rows, null for a spec no import created —
   * the same authority the sign-off preconditions read, so a subject cannot be
   * outstanding here and settled there.
   */
  importBaselineRows: readonly RevisionElement[] | null;
  importBaselineCitationState: ApprovalCitationState | null;
  currentExecution: Pick<
    SpecExecutionRow,
    | "id"
    | "revision_id"
    | "state"
    | "workflow_execution_id"
    | "execution_start_dial"
  > | null;
  revisionNumberById: ReadonlyMap<string, number>;
  applies: ApprovalApplicability;
  blockingThreads: readonly ReviewThreadSnapshot[];
  /** The revision's lint findings whose severity blocks sign-off. */
  signOffFindings: readonly LintFinding[];
  /**
   * Open review comments on the projected revision. Optional display
   * enrichment: only the status read supplies them, and a caller that omits
   * them loses the comment-aware instructions, never correctness — pending
   * subjects, sign-off and gate states are computed without them.
   */
  openComments?: readonly OpenCommentSnapshot[];
  /** Names the exact `cctl spec comments` invocation in instructions. */
  specSlug?: string;
}

const AUTHORING_GATES: readonly AuthoringGate[] = [
  "requirements",
  "design",
  "plan",
];

export function isAuthoringGate(gate: SpecGate): gate is AuthoringGate {
  return AUTHORING_GATES.includes(gate as AuthoringGate);
}

function admissionRecords(
  rows: readonly SpecGateAdmissionRow[],
  revisionNumberById: ReadonlyMap<string, number>,
): SpecGateAdmissionRecord[] {
  return rows
    .flatMap((admission) => {
      // A revision-less admission has no place in a per-revision history.
      const revisionId = admission.revision_id;
      const revisionNumber =
        revisionId === null ? undefined : revisionNumberById.get(revisionId);
      return revisionId === null || revisionNumber === undefined
        ? []
        : [
            {
              revisionId,
              revisionNumber,
              executionId: admission.execution_id,
              basis: admission.basis,
              actor: parseProvenance(admission.actor_json),
              admittedAt: admission.created_at,
            },
          ];
    })
    .sort(
      (left, right) =>
        left.revisionNumber - right.revisionNumber ||
        left.admittedAt.localeCompare(right.admittedAt),
    );
}

function projectGates(
  input: AuthoringReviewProjectionInput,
  consulted: ReadonlySet<AuthoringGate>,
): ProjectedGateStatus[] {
  const revisionId = input.snapshot?.revision.id ?? null;
  const stage = input.snapshot?.revision.authoringStage ?? null;
  const governanceBaseRevisionId =
    input.governanceBaseSnapshot?.revision.id ?? null;
  return specGateSchema.options.map((gate) => {
    const dial =
      gate === "execution_start" &&
      input.currentExecution?.execution_start_dial != null
        ? input.currentExecution.execution_start_dial
        : resolveDial(input.policy, gate);
    // Execution-scoped gates admit one run, read against the run's PINNED
    // revision: an older run's admission must not make the current run read as
    // admitted, and a newer draft amendment must not hide the active run's
    // admission (its rows carry the pinned revision, not the draft).
    const countsNow = (admission: SpecGateAdmissionRow) =>
      admission.gate !== gate
        ? false
        : EXECUTION_SCOPED_GATES.has(gate)
          ? input.currentExecution !== null &&
            admission.execution_id === input.currentExecution.id &&
            admission.revision_id === input.currentExecution.revision_id
          : revisionId === null || admission.revision_id === revisionId;
    const currentRows = input.admissions.filter(countsNow);
    const priorRows = input.admissions.filter(
      (admission) => admission.gate === gate && !countsNow(admission),
    );
    const authoring = isAuthoringGate(gate);
    // A withdrawn revision is terminal: no later transition consults its
    // gates, so none of them asks a human for anything on its behalf.
    const terminalRevision = input.snapshot?.revision.state === "withdrawn";
    const isConsulted = authoring && !terminalRevision && consulted.has(gate);
    const runActionable =
      !authoring &&
      dialRequiresHumanApproval(dial) &&
      executionGateActionable(
        gate === "execution_start" ? "execution_start" : "delivery",
        input.currentExecution,
      );
    const reason: SpecGateApplicabilityReason = authoring
      ? isConsulted
        ? gate === stage
          ? "current_stage"
          : "changed_since_governance_base"
        : !terminalRevision && dialRequiresHumanApproval(dial)
          ? "unchanged_since_governance_base"
          : "dial_off"
      : runActionable
        ? "current_stage"
        : "dial_off";
    // Execution start stays pending while the compiled definition parks even
    // under a dial that admits it without a human, because the run has not
    // been admitted yet. Every other unadmitted execution-gate position asks
    // nothing: with no run to receive the act, `pending` would deny the
    // applicability the same row reports.
    const executionActPending =
      !authoring &&
      (runActionable ||
        (gate === "execution_start" &&
          executionGateActionable("execution_start", input.currentExecution)));
    const state: ProjectedGateStatus["state"] =
      currentRows.length > 0
        ? "admitted"
        : authoring
          ? isConsulted && dialRequiresHumanApproval(dial)
            ? "pending"
            : "not_required"
          : executionActPending
            ? "pending"
            : "not_required";
    return {
      gate,
      dial,
      state,
      applicability: { reason, governanceBaseRevisionId },
      currentAdmissions: admissionRecords(
        currentRows,
        input.revisionNumberById,
      ),
      priorAdmissions: admissionRecords(priorRows, input.revisionNumberById),
    };
  });
}

/**
 * The approvals a human still owes for the current revision (or the selected
 * run), the consulted subjects an import admission settles instead, and the
 * two-sided ledger over every consulted subject. Read off the projected gate
 * states, so a gate that is not consulted cannot contribute a subject and a
 * consulted one cannot hide its subjects.
 *
 * The three are derived together because they answer the same question of the
 * same authority: `approvalHeld` for the human act, `elementApprovalBasis` for
 * the import admission. Splitting them is what would let a surface report a
 * subject as banked here and outstanding there.
 */
function projectPendingApprovals(
  input: AuthoringReviewProjectionInput,
  gates: readonly ProjectedGateStatus[],
): {
  pending: PendingApproval[];
  importCarried: ImportCarriedApproval[];
  ledger: ApprovalLedger;
} {
  const snapshot = input.snapshot;
  if (snapshot === null) {
    return { pending: [], importCarried: [], ledger: emptyApprovalLedger() };
  }
  const pending: PendingApproval[] = [];
  const importCarried: ImportCarriedApproval[] = [];
  const ledgerSubjects: ApprovalLedgerSubject[] = [];
  const gatePending = (gate: SpecGate) =>
    gates.some((status) => status.gate === gate && status.state === "pending");
  // R11.5: under the combined dial the sign-off act is itself the approval of
  // every item, and `approvalUnmetConditions` asks for no element approval. A
  // subject listed here would send the caller at an act the policy collapsed.
  const collapsed = authoringApprovalsCollapseIntoSignOff(
    input.policy,
    snapshot.revision.authoringStage,
  );
  const subjectPending = (gate: SpecGate) => !collapsed && gatePending(gate);
  // The ledger accounts for every subject of a gate this transition consults
  // whose dial makes it a human act — including a gate the sign-off already
  // admitted, which is where the satisfied side of the account lives. A
  // notify or off dial admits by policy and has no per-subject side at all.
  const gateLedgered = (gate: SpecGate) =>
    gates.some(
      (status) =>
        status.gate === gate &&
        dialRequiresHumanApproval(status.dial) &&
        (status.applicability.reason === "current_stage" ||
          status.applicability.reason === "changed_since_governance_base"),
    );
  // The collapsed dial records every subject through the one sign-off act, so
  // its subjects become settled exactly when that act exists — as a recorded
  // approval, or as the absorbed sign-off a propose writes straight onto the
  // revision.
  const combinedActRecorded =
    snapshot.revision.state === "approved" ||
    input.approvals.some(
      (candidate) =>
        candidate.subject_kind === "revision" &&
        candidate.revision_id === snapshot.revision.id,
    );
  const handles = new Map(
    snapshot.elements.map((row) => [
      row.element.id,
      elementHandle(snapshot, row),
    ]),
  );
  const revisionRows = toDiffRows(snapshot);
  // One authority, asked exactly as `approvalUnmetConditions` asks it: a
  // subject the sign-off no longer owes must not be listed here, and a subject
  // it does owe must not be hidden here. The approval row travels with the
  // basis because which revision the approving human read is the whole
  // difference between a carried approval and one granted on this revision.
  const settlement = (
    subjectKind: ApprovalSubjectKind,
    elementId: string | null,
  ): {
    held: SpecApprovalRow | null;
    basis: ElementApprovalBasis | null;
  } => {
    const held = approvalHeld(
      input.approvals,
      input.applies,
      subjectKind,
      elementId,
    );
    return {
      held,
      basis: elementApprovalBasis({
        approvalHeld: held !== null,
        subject: { subjectKind, elementId },
        revisionRows,
        revisionCitationState: {
          citationContractVersion: snapshot.revision.citationContractVersion,
          citations: toDiffCitations(snapshot),
        },
        importBaselineRows: input.importBaselineRows,
        importBaselineCitationState: input.importBaselineCitationState,
      }),
    };
  };
  const classify = (
    held: SpecApprovalRow | null,
    basis: ElementApprovalBasis | null,
  ): ApprovalLedgerClass => {
    // An import admission settles the subject without anyone reading it, so it
    // is answered before any human act is named.
    if (basis === "import_carry_forward") return "import_settled";
    // Under the collapsed dial nobody is ever asked per subject — yet the
    // sign-off transaction persists an approval row for every one of them
    // (R11.5, review-service). Reading those rows first would report each
    // subject as approved on this revision, which is precisely the act that
    // never happened, so the recorded combined act answers for them all.
    if (collapsed && combinedActRecorded) return "combined_act";
    if (held !== null) {
      return held.revision_id === snapshot.revision.id
        ? "current_revision"
        : "carried";
    }
    // Before the combined act the subjects an ancestor sign-off already
    // approved stay banked above; what is left is outstanding through that one
    // act rather than individually.
    return "pending";
  };
  const recordSubject = (
    gate: AuthoringGate,
    subject: string,
    elementId: string | null,
    subjectKind: ApprovalSubjectKind,
  ): void => {
    const { held, basis } = settlement(subjectKind, elementId);
    if (gateLedgered(gate)) {
      ledgerSubjects.push({
        gate,
        subject,
        elementId,
        classification: classify(held, basis),
      });
    }
    if (!subjectPending(gate)) return;
    if (basis === null) {
      pending.push({ gate, subject, elementId });
      return;
    }
    // The plan subject is never import-admitted, so a carried-forward subject
    // always addresses an element.
    if (basis === "import_carry_forward" && elementId !== null) {
      importCarried.push({ gate, subject, elementId });
    }
  };
  const asked = (gate: AuthoringGate) =>
    subjectPending(gate) || gateLedgered(gate);
  for (const row of snapshot.elements) {
    const subject = handles.get(row.element.id) ?? row.element.id;
    if (row.element.kind === "requirement" && asked("requirements")) {
      recordSubject("requirements", subject, row.element.id, "requirement");
    }
    if (row.element.kind === "decision" && asked("design")) {
      recordSubject("design", subject, row.element.id, "decision");
    }
  }
  if (snapshot.revision.authoringStage === "plan" && asked("plan")) {
    recordSubject("plan", "plan", null, "plan");
  }
  for (const gate of ["execution_start", "delivery"] as const) {
    if (
      gatePending(gate) &&
      executionGateActionable(gate, input.currentExecution)
    ) {
      pending.push({ gate, subject: gate, elementId: null });
    }
  }
  const subjects = inGateOrder(ledgerSubjects);
  const counted = (classification: ApprovalLedgerClass) =>
    subjects.filter((entry) => entry.classification === classification).length;
  const carried = counted("carried");
  const currentRevision = counted("current_revision");
  const importSettled = counted("import_settled");
  const combinedAct = counted("combined_act");
  return {
    pending,
    importCarried,
    ledger: {
      subjects,
      satisfied: carried + currentRevision + importSettled + combinedAct,
      carried,
      currentRevision,
      importSettled,
      combinedAct,
      pending: counted("pending"),
      governedBy: collapsed ? "combined_sign_off" : "per_subject",
      carryRule: APPROVAL_CARRY_RULE,
    },
  };
}

function projectSignOff(
  input: AuthoringReviewProjectionInput,
  outstandingSubjectCount: number,
): RevisionSignOffProjection | null {
  const snapshot = input.snapshot;
  // A draft owes a propose before it owes a sign-off, and a withdrawn revision
  // is terminal: neither has a sign-off outstanding.
  if (
    snapshot === null ||
    snapshot.revision.state === "draft" ||
    snapshot.revision.state === "withdrawn"
  ) {
    return null;
  }
  const revisionId = snapshot.revision.id;
  const approval =
    input.approvals.find(
      (candidate) =>
        candidate.subject_kind === "revision" &&
        candidate.revision_id === revisionId,
    ) ?? null;
  const unmetConditions =
    snapshot.revision.state === "approved"
      ? []
      : [
          ...unresolvedThreadConditions(input.blockingThreads),
          ...input.signOffFindings.map((finding) => finding.message),
          ...approvalUnmetConditions({
            policy: input.policy,
            authoringStage: snapshot.revision.authoringStage,
            revisionId,
            governanceBaseRevisionRows:
              input.governanceBaseSnapshot === null
                ? []
                : toDiffRows(input.governanceBaseSnapshot),
            governanceBaseCitationState:
              input.governanceBaseSnapshot === null
                ? {
                    citationContractVersion:
                      snapshot.revision.citationContractVersion,
                    citations: [],
                  }
                : {
                    citationContractVersion:
                      input.governanceBaseSnapshot.revision
                        .citationContractVersion,
                    citations: toDiffCitations(input.governanceBaseSnapshot),
                  },
            revisionRows: toDiffRows(snapshot),
            revisionCitationState: {
              citationContractVersion:
                snapshot.revision.citationContractVersion,
              citations: toDiffCitations(snapshot),
            },
            approvals: input.approvals.flatMap((candidate) =>
              candidate.subject_kind === "revision"
                ? []
                : [
                    {
                      subjectKind: candidate.subject_kind,
                      elementId: candidate.element_id,
                      revisionId: candidate.revision_id,
                      validity: candidate.validity,
                    },
                  ],
            ),
            handles: new Map(
              snapshot.elements.map((row) => [
                row.element.id,
                elementHandle(snapshot, row),
              ]),
            ),
            approvalApplies: input.applies,
            importBaselineRows: input.importBaselineRows,
            importBaselineCitationState: input.importBaselineCitationState,
          }),
        ];
  return {
    revisionId,
    revisionNumber: snapshot.revision.number,
    state:
      snapshot.revision.state === "approved"
        ? "signed_off"
        : unmetConditions.length > 0
          ? "blocked"
          : "ready",
    outstandingSubjectCount,
    unmetConditions,
    approval,
  };
}

/**
 * Gate order, never the authoring stage: an earlier stage consulted through a
 * withdrawn ancestor is acted on before the stage the revision sits at.
 */
function inGateOrder<Subject extends { gate: SpecGate }>(
  subjects: readonly Subject[],
): Subject[] {
  return specGateSchema.options.flatMap((gate) =>
    subjects.filter((subject) => subject.gate === gate),
  );
}

function subjectSentence(subjects: readonly PendingApproval[]): string {
  return subjects
    .map((subject) => `${subject.gate}: ${subject.subject}`)
    .join(", ");
}

function projectPendingBlock(
  input: AuthoringReviewProjectionInput,
  gates: readonly ProjectedGateStatus[],
  applicableGates: readonly SpecGate[],
  pending: readonly PendingApproval[],
  importCarried: readonly ImportCarriedApproval[],
  signOff: RevisionSignOffProjection | null,
): AuthoringPendingBlock | null {
  const signOffOutstanding =
    signOff !== null &&
    (signOff.state === "ready" || signOff.state === "blocked");
  if (pending.length === 0 && !signOffOutstanding) return null;
  const revisionNumber = input.snapshot?.revision.number ?? null;
  const revisionLabel =
    revisionNumber === null ? "the revision" : `revision ${revisionNumber}`;
  const blockGates = gates
    .filter(
      (gate) =>
        applicableGates.includes(gate.gate) &&
        (gate.state === "pending" ||
          pending.some((subject) => subject.gate === gate.gate)),
    )
    .map((gate) => ({
      gate: gate.gate,
      dial: gate.dial,
      state: gate.state,
      applicability: gate.applicability,
      subjects: pending
        .filter((subject) => subject.gate === gate.gate)
        .map((subject) => subject.subject),
      importCarriedSubjects: importCarried
        .filter((subject) => subject.gate === gate.gate)
        .map((subject) => subject.subject),
    }));
  const first = pending[0];
  const nextGateSubjectCount =
    first === undefined
      ? 0
      : pending.filter((subject) => subject.gate === first.gate).length;
  // An open draft owes a propose before it owes anything to a human: the
  // subjects below are what the review will ask for, not what it is waiting on.
  const draft = input.snapshot?.revision.state === "draft";
  // R11.5: with the approvals collapsed, no subject was ever approved
  // individually, so saying they all were would describe acts that never
  // happened.
  const collapsed = authoringApprovalsCollapseIntoSignOff(
    input.policy,
    input.snapshot?.revision.authoringStage,
  );
  const display = draft
    ? `${revisionLabel} is an open draft; proposing it opens the review its consulted gates ask for`
    : first === undefined
      ? signOff?.state === "blocked"
        ? `${revisionLabel} cannot be signed off yet: ${signOff.unmetConditions.length} unmet condition${signOff.unmetConditions.length === 1 ? "" : "s"}`
        : collapsed
          ? `${revisionLabel} awaits one human sign-off, which approves every item under this policy`
          : // An import admission settles a subject without approving it, so a
            // revision carrying one has not had every subject approved and must
            // not be described as though a human had read them.
            importCarried.length > 0
            ? `${revisionLabel} has every consulted subject settled — ${importCarried.length} carried forward from the import rather than approved by a human — and awaits explicit human sign-off`
            : `${revisionLabel} has every consulted subject approved and awaits explicit human sign-off`
      : `${revisionLabel} needs ${pending.length} human approval${pending.length === 1 ? "" : "s"} — ${subjectSentence(pending)}`;
  const instruction = draft
    ? "Propose the draft revision when it is ready for review."
    : first === undefined
      ? signOff?.state === "blocked"
        ? `Resolve the unmet sign-off conditions, then sign ${revisionLabel} off in Spec Studio.`
        : `Ask a human to sign ${revisionLabel} off in Spec Studio; approving the last subject does not sign it off.`
      : nextGateSubjectCount > 1
        ? `Ask a human to approve all ${nextGateSubjectCount} outstanding subjects at the ${first.gate} gate in Spec Studio, or request the ${first.gate} gate without a subject.`
        : `Ask a human to approve ${first.subject} at the ${first.gate} gate in Spec Studio, or request it with gate ${first.gate} and subject ${first.subject}.`;
  // A draft cannot carry review comments — commenting refuses outside a
  // proposed revision — so the lead only decorates the in-review block, where
  // a human weighing "approve or Request Changes" is exactly who reads it.
  const open = draft ? null : projectOpenComments(input);
  return {
    actsNext: draft ? "agent" : "human",
    gates: blockGates,
    outstandingSubjects: [...pending],
    signOff,
    unmetConditions: signOff?.unmetConditions ?? [],
    display:
      open === null
        ? display
        : `${display}; ${open.openThreadCount} open thread${open.openThreadCount === 1 ? "" : "s"} await${open.openThreadCount === 1 ? "s" : ""} a response`,
    instruction:
      open === null
        ? instruction
        : `${openCommentLead(open, input.specSlug)} A human must approve what remains in Spec Studio or use Request Changes to reopen the draft before repairs can land.`,
  };
}

function projectOpenComments(
  input: AuthoringReviewProjectionInput,
): ProjectedOpenComments | null {
  const comments = input.openComments ?? [];
  if (comments.length === 0) return null;
  const threads = new Map<string, { label: string; blocking: boolean }>();
  for (const comment of comments) {
    const existing = threads.get(comment.threadId);
    if (existing === undefined) {
      threads.set(comment.threadId, {
        label: comment.handle ?? comment.elementId,
        blocking: comment.blocking,
      });
      continue;
    }
    existing.blocking ||= comment.blocking;
  }
  const subjects: string[] = [];
  for (const { label } of threads.values()) {
    if (!subjects.includes(label)) subjects.push(label);
  }
  return {
    count: comments.length,
    blockingCount: comments.filter((comment) => comment.blocking).length,
    openThreadCount: threads.size,
    openBlockingThreadCount: [...threads.values()].filter(
      (thread) => thread.blocking,
    ).length,
    subjects,
  };
}

/**
 * The sentence that reroutes an instruction when reviewers left open comments:
 * the human named by actsNext is withholding the approval the plain
 * instruction would ask for, so pointing at the approval alone parks the loop.
 */
function openCommentLead(
  open: ProjectedOpenComments,
  specSlug: string | undefined,
): string {
  return `Open review threads on ${open.subjects.join(", ")} await a response — read them with cctl spec comments ${specSlug ?? "<slug>"} --open.`;
}

function projectNextAction(
  input: AuthoringReviewProjectionInput,
  pending: readonly PendingApproval[],
  signOff: RevisionSignOffProjection | null,
): AuthoringNextAction {
  // A withdrawn revision is terminal — every write and approval refuses on it
  // — so the only act that moves the spec is opening the amendment draft.
  if (input.snapshot?.revision.state === "withdrawn") {
    return {
      kind: "amend",
      actsNext: "agent",
      gate: null,
      subject: null,
      elementId: null,
      instruction: `Open an amendment draft: revision ${input.snapshot.revision.number} was withdrawn and carries nothing forward.`,
    };
  }
  if (
    input.snapshot?.revision.state === "approved" &&
    input.snapshot.revision.authoringStage === "requirements"
  ) {
    return {
      kind: "amend",
      actsNext: "agent",
      gate: null,
      subject: null,
      elementId: null,
      instruction: `Requirements are approved. Run cctl spec amend ${input.specSlug ?? "<slug>"} to open the Design draft.`,
    };
  }
  const open = projectOpenComments(input);
  // Element approval is refused on a draft, so naming a subject here would
  // send the caller at an act the transition cannot accept. The subjects stay
  // listed — they are what the review will ask for — but the act is propose.
  // A draft carrying open comments is the Request Changes repair loop: the
  // reviewer's feedback is what the next propose must answer.
  if (input.snapshot?.revision.state === "draft") {
    return {
      kind: "propose",
      actsNext: "agent",
      gate: null,
      subject: null,
      elementId: null,
      instruction:
        open === null
          ? "Propose the draft revision when it is ready for review."
          : `${openCommentLead(open, input.specSlug)} Repair or answer them in the draft, then propose it again.`,
    };
  }
  const orderedPending = inGateOrder(pending);
  const first = orderedPending[0];
  if (first !== undefined) {
    const gateSubjects = orderedPending.filter(
      (subject) => subject.gate === first.gate,
    );
    if (gateSubjects.length > 1) {
      return {
        kind: "approve_gate",
        actsNext: "human",
        gate: first.gate,
        subject: null,
        elementId: null,
        instruction:
          open === null
            ? `Ask a human to approve all ${gateSubjects.length} outstanding subjects at the ${first.gate} gate in Spec Studio.`
            : `${openCommentLead(open, input.specSlug)} A human must approve the remaining subjects in Spec Studio or use Request Changes to reopen the draft before repairs can land.`,
      };
    }
    return {
      kind: "approve_subject",
      actsNext: "human",
      gate: first.gate,
      subject: first.subject,
      elementId: first.elementId,
      instruction:
        open === null
          ? `Ask a human to approve ${first.subject} at the ${first.gate} gate in Spec Studio.`
          : `${openCommentLead(open, input.specSlug)} A human must approve the remaining subjects in Spec Studio or use Request Changes to reopen the draft before repairs can land.`,
    };
  }
  if (signOff?.state === "blocked") {
    return {
      kind: "resolve_conditions",
      actsNext: "agent",
      gate: null,
      subject: null,
      elementId: null,
      instruction:
        "Resolve the unmet sign-off conditions, then sign the revision off.",
    };
  }
  if (signOff?.state === "ready") {
    return {
      kind: "sign_off_revision",
      actsNext: "human",
      gate: null,
      subject: null,
      elementId: null,
      instruction:
        open === null
          ? `Ask a human to sign revision ${signOff.revisionNumber} off in Spec Studio.`
          : `${openCommentLead(open, input.specSlug)} A human can still sign revision ${signOff.revisionNumber} off in Spec Studio, or use Request Changes to reopen the draft for repairs.`,
    };
  }
  return {
    kind: "none",
    actsNext: null,
    gate: null,
    subject: null,
    elementId: null,
    instruction: "Nothing is outstanding for the current revision.",
  };
}

/**
 * The one server-side answer to "what does this revision still owe, and who
 * acts next" — consumed by propose, status, sign-off, approval-request
 * validation, and the CLI, so those surfaces cannot report different answers
 * from different sources.
 */
export function authoringReviewProjection(
  input: AuthoringReviewProjectionInput,
): AuthoringReviewProjection {
  const consulted = new Set<AuthoringGate>(
    input.snapshot === null
      ? []
      : consultedAuthoringGates(
          input.snapshot.revision.authoringStage,
          input.governanceBaseSnapshot === null
            ? []
            : toDiffRows(input.governanceBaseSnapshot),
          toDiffRows(input.snapshot),
          toCitationDiffContext(input.governanceBaseSnapshot, input.snapshot),
        ),
  );
  const gates = projectGates(input, consulted);
  const applicableGates = gates
    .filter(
      (gate) =>
        gate.applicability.reason === "current_stage" ||
        gate.applicability.reason === "changed_since_governance_base",
    )
    .map((gate) => gate.gate);
  const subjects = projectPendingApprovals(input, gates);
  const pending = inGateOrder(subjects.pending);
  const importCarried = inGateOrder(subjects.importCarried);
  const signOff = projectSignOff(
    input,
    pending.filter((subject) => isAuthoringGate(subject.gate)).length,
  );
  return {
    applicableGates,
    gates,
    pendingApprovals: pending,
    importCarriedApprovals: importCarried,
    approvalLedger: subjects.ledger,
    revisionSignOff: signOff,
    pendingBlock: projectPendingBlock(
      input,
      gates,
      applicableGates,
      pending,
      importCarried,
      signOff,
    ),
    nextAction: projectNextAction(input, pending, signOff),
    openComments: projectOpenComments(input),
  };
}
