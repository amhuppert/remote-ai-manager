import type { AuthoringReviewProjection } from "./authoring-review-projection";
import {
  approvalRecordFromRow,
  type ApprovalApplicability,
  type ApprovalSubjectKind,
} from "./approval-applicability";
import { dialRequiresHumanApproval } from "./policy";
import { elementHandleInSnapshot } from "./review-state";
import {
  actorProvenanceSchema,
  type ActorProvenance,
  type SpecApprovalRequestScope,
  type SpecApprovalRow,
  type SpecExecutionRow,
  type SpecGate,
  type SpecRevision,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
} from "./schemas";

/**
 * One approval a human still owes for the current revision (or the selected
 * run). This is also the set a request may name: an approval outside it either
 * has already been given or cannot be given yet, so requesting it would open a
 * Needs You entry no human act can clear.
 */
export interface PendingApproval {
  gate: SpecGate;
  subject: string;
  elementId: string | null;
}

/** The gates whose admissions are per-execution rather than per-revision. */
export const EXECUTION_SCOPED_GATES: ReadonlySet<string> = new Set([
  "execution_start",
  "delivery",
]);

/**
 * The revision every read projection calls "current": the highest-numbered
 * one, whatever its state. An open draft is current, and so is the latest
 * approved one once no draft is open.
 */
export function latestRevision(
  revisions: readonly SpecRevision[],
): SpecRevision | null {
  return (
    [...revisions].sort((left, right) => right.number - left.number)[0] ?? null
  );
}

/**
 * The human approval of this subject that stands for the revision the
 * projection reads, or null when none does. Decided by
 * `approvalAppliesToRevision` alone, so status, request validation, and
 * sign-off cannot disagree about what is outstanding.
 *
 * The row itself is returned because which revision the approving human read
 * is what separates a carried approval from one granted on this revision. When
 * a subject holds several — a human re-approving content an ancestor approval
 * already carried — the most recently granted one is the act to report.
 */
export function approvalHeld(
  approvals: readonly SpecApprovalRow[],
  applies: ApprovalApplicability,
  subjectKind: ApprovalSubjectKind,
  elementId: string | null,
): SpecApprovalRow | null {
  let held: SpecApprovalRow | null = null;
  for (const approval of approvals) {
    if (approval.subject_kind !== subjectKind) continue;
    if (approval.element_id !== elementId) continue;
    const record = approvalRecordFromRow(approval);
    if (record === null || !applies(record)) continue;
    if (
      held === null ||
      approval.granted_at > held.granted_at ||
      (approval.granted_at === held.granted_at && approval.id > held.id)
    ) {
      held = approval;
    }
  }
  return held;
}

/**
 * Address of an element within a projection: its handle, falling back to the
 * element id for the rows that have none (sections and unnumbered elements),
 * which is how those rows are addressed everywhere on this surface.
 */
export function elementHandle(
  snapshot: SpecRevisionSnapshot,
  row: SpecRevisionElement,
): string {
  return elementHandleInSnapshot(snapshot, row.element.id) ?? row.element.id;
}

/**
 * Whether a human act exists right now for an execution-scoped gate. Before a
 * run exists there is nothing to approve, so a pending entry would be a Needs
 * You no act can clear — the same rule authoring subjects already obey.
 * Execution start is approvable exactly while the compiled definition parks
 * with its workflow lane linked (the grant path refuses in every other
 * position); delivery is grantable for any run that has not ended.
 */
export function executionGateActionable(
  gate: "execution_start" | "delivery",
  execution: Pick<SpecExecutionRow, "state" | "workflow_execution_id"> | null,
): boolean {
  if (execution === null) return false;
  if (gate === "execution_start") {
    return (
      execution.state === "definition_review" &&
      execution.workflow_execution_id !== null
    );
  }
  return (
    execution.state === "definition_review" || execution.state === "running"
  );
}

/**
 * The run a gate reads against: the one still in flight, otherwise the most
 * recent, so a delivered run's admissions stay visible after it ends.
 */
export function currentExecution(
  executions: readonly SpecExecutionRow[],
): SpecExecutionRow | null {
  const active = executions.find(
    (execution) =>
      execution.state === "definition_review" || execution.state === "running",
  );
  if (active !== undefined) return active;
  let latest: SpecExecutionRow | null = null;
  for (const execution of executions) {
    if (
      latest === null ||
      execution.created_at > latest.created_at ||
      (execution.created_at === latest.created_at && execution.id > latest.id)
    ) {
      latest = execution;
    }
  }
  return latest;
}

/**
 * Actor provenance is stored as JSON text, so a row written by an older build
 * (or hand-edited) may not parse, and the read surface must not 500 on one bad
 * record — it degrades to null.
 */
export function parseProvenance(raw: string): ActorProvenance | null {
  try {
    const parsed = actorProvenanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ApprovalRequestContext {
  /**
   * The one projection status also reports. Validation reads gate state and
   * the outstanding set from it rather than recomputing them, so a request can
   * never be accepted for something status calls satisfied — or refused for
   * something status calls outstanding.
   */
  projection: AuthoringReviewProjection;
  /** The revision the caller named. */
  requestedRevisionId: string;
  /** The revision the authoring gates are evaluated against right now. */
  currentRevisionId: string | null;
  snapshot: SpecRevisionSnapshot | null;
  /** The run's pinned revision, where an execution-gate subject is addressed. */
  executionSnapshot: SpecRevisionSnapshot | null;
  approvals: readonly SpecApprovalRow[];
  applies: ApprovalApplicability;
  gate: SpecGate;
  /** Null is the whole-gate ask, never a request to guess a subject. */
  subject: string | null;
}

export type ApprovalRequestRefusalCode =
  | "stale_revision"
  | "gate_not_applicable"
  | "invalid_subject"
  | "already_satisfied";

export interface ApprovalRequestRefusal {
  code: ApprovalRequestRefusalCode;
  unmetConditions: string[];
  instruction: string;
}

/**
 * The ask a validated request records. `scope` is what the durable identity is
 * keyed on; `outstandingSubjects` is a display snapshot taken when the ask was
 * made and is deliberately NOT part of that identity — a gate request whose
 * identity moved as subjects were approved would open a second Needs You entry
 * for work a human is already looking at.
 */
export interface ValidatedApprovalRequest {
  scope: SpecApprovalRequestScope;
  gate: SpecGate;
  /** The gate name for a gate-scoped ask; the named handle for an item. */
  subject: string;
  elementId: string | null;
  outstandingSubjects: string[];
  /** Whether the revision still owes a human sign-off when the ask was made. */
  signOffOutstanding: boolean;
}

export type ApprovalRequestValidation =
  | { readonly ok: true; readonly request: ValidatedApprovalRequest }
  | { readonly ok: false; readonly refusal: ApprovalRequestRefusal };

function refuse(
  code: ApprovalRequestRefusalCode,
  condition: string,
  instruction: string,
): ApprovalRequestValidation {
  return {
    ok: false,
    refusal: { code, unmetConditions: [condition], instruction },
  };
}

/**
 * Whether the named approval is one a human can actually give right now.
 *
 * Requests become durable Needs You entries, so an unvalidated request is a
 * notification no act can clear: the human sees work that does not exist and
 * learns to ignore the queue. What is requestable is read off the current
 * status projection — the gates it reports as pending, and the subjects they
 * are pending on — rather than from the caller's word.
 */
export function validateApprovalRequest(
  context: ApprovalRequestContext,
): ApprovalRequestValidation {
  const authoringScoped = !EXECUTION_SCOPED_GATES.has(context.gate);
  if (
    authoringScoped &&
    context.currentRevisionId !== null &&
    context.requestedRevisionId !== context.currentRevisionId
  ) {
    return refuse(
      "stale_revision",
      `Revision ${context.requestedRevisionId} is not the revision the ${context.gate} gate is evaluated against.`,
      `Request approval for revision ${context.currentRevisionId}, which the ${context.gate} gate reads today.`,
    );
  }

  const status = context.projection.gates.find(
    (candidate) => candidate.gate === context.gate,
  );
  if (status === undefined || status.state === "not_required") {
    // A gate whose dial asks for nothing and a gate whose content this
    // revision did not touch are different answers to "why can I not request
    // this?", and only the second is about the governance baseline.
    if (status?.applicability.reason === "unchanged_since_governance_base") {
      const base = status.applicability.governanceBaseRevisionId;
      return refuse(
        "gate_not_applicable",
        base === null
          ? `The ${context.gate} gate is not consulted for revision ${context.currentRevisionId}: this revision authors nothing it governs.`
          : `The ${context.gate} gate is not consulted for revision ${context.currentRevisionId}: nothing it governs changed since revision ${base}.`,
        "Read the spec status for the gates that are actually blocking, then request one of those.",
      );
    }
    // A terminal revision and an unstarted run are both "the dial requires a
    // human, but nothing can receive the act", which the dial sentence below
    // would deny outright.
    if (context.snapshot?.revision.state === "withdrawn") {
      return refuse(
        "gate_not_applicable",
        `Revision ${context.currentRevisionId} was withdrawn, so no approval can be recorded against it.`,
        "Open an amendment draft, re-author what still applies, and propose it for review.",
      );
    }
    if (status !== undefined && dialRequiresHumanApproval(status.dial)) {
      return refuse(
        "gate_not_applicable",
        `The ${context.gate} gate has no run in a position to receive its approval right now.`,
        "Read the spec status for the gates that are actually blocking, then request one of those.",
      );
    }
    return refuse(
      "gate_not_applicable",
      `The ${context.gate} gate is set to ${status?.dial ?? "off"}, so it asks for no human approval.`,
      "Change the gate policy in Spec Studio if this gate should require an approval, then request it.",
    );
  }
  if (status.state === "admitted") {
    return refuse(
      "already_satisfied",
      `The ${context.gate} gate is already admitted for this revision.`,
      "Read the spec status; this gate is no longer blocking.",
    );
  }
  const forGate = context.projection.pendingApprovals.filter(
    (candidate) => candidate.gate === context.gate,
  );
  const outstandingSubjects = forGate.map((candidate) => candidate.subject);
  const signOff = context.projection.revisionSignOff;
  const signOffOutstanding =
    signOff !== null &&
    (signOff.state === "ready" || signOff.state === "blocked");
  const gateScoped = (
    subject: string,
    elementId: string | null,
  ): ApprovalRequestValidation => ({
    ok: true,
    request: {
      scope: "gate",
      gate: context.gate,
      subject,
      elementId,
      outstandingSubjects,
      signOffOutstanding,
    },
  });

  // An omitted subject is the whole-gate ask, at twelve outstanding subjects
  // or none. Resolving it to "the single outstanding subject" would make the
  // meaning of the same command change as approvals land, and a gate with a
  // dozen subjects would have no requestable form at all. The gate is still
  // answerable here: the checks above already refused an admitted gate, and a
  // gate whose subjects are all approved is exactly the sign-off tail.
  if (context.subject === null) {
    return gateScoped(context.gate, null);
  }
  const subject = context.subject;

  // An execution gate admits the run as a whole, so every request at one is
  // gate-scoped: a named subject is a deep-link pointer at the element the run
  // is blocked on, not an item a human can approve on its own.
  if (!authoringScoped) {
    if (subject === context.gate) return gateScoped(subject, null);
    const target = elementForSubject(context.executionSnapshot, subject);
    if (target !== null) return gateScoped(subject, target);
    return refuse(
      "invalid_subject",
      `${subject} addresses nothing in the revision this run pinned.`,
      `Name the element the ${context.gate} gate is blocked on, or the gate itself: ${context.gate}.`,
    );
  }

  const matched = forGate.find((candidate) => candidate.subject === subject);
  if (matched !== undefined) {
    return {
      ok: true,
      request: {
        scope: "item",
        gate: context.gate,
        subject: matched.subject,
        elementId: matched.elementId,
        outstandingSubjects,
        signOffOutstanding,
      },
    };
  }

  // A subject drops out of the outstanding set both when it has been approved
  // and when its gate is not consulted at this stage. Those are different
  // answers to "what do I do now?", so they get different refusals.
  if (subjectAlreadyApproved(context, subject)) {
    return refuse(
      "already_satisfied",
      `${subject} already holds a valid approval for the current revision.`,
      "Read the spec status; this subject is no longer blocking.",
    );
  }
  if (forGate.length === 0) {
    return refuse(
      "gate_not_applicable",
      `The ${context.gate} gate has no outstanding subject named ${subject} for the current revision.`,
      `Omit --subject to request the ${context.gate} gate itself, which is what the revision sign-off admits.`,
    );
  }
  return refuse(
    "invalid_subject",
    `${subject} is not an outstanding subject at the ${context.gate} gate.`,
    `Request one of: ${forGate.map((candidate) => candidate.subject).join(", ")} — or omit --subject to request the whole gate.`,
  );
}

/** The approval subject kind an authoring gate asks a human to record. */
function subjectKindForGate(gate: SpecGate): ApprovalSubjectKind | null {
  if (gate === "requirements") return "requirement";
  if (gate === "design") return "decision";
  if (gate === "plan") return "plan";
  return null;
}

function elementForSubject(
  snapshot: SpecRevisionSnapshot | null,
  subject: string,
): string | null {
  if (snapshot === null) return null;
  const row = snapshot.elements.find(
    (candidate) => elementHandle(snapshot, candidate) === subject,
  );
  return row?.element.id ?? null;
}

function subjectAlreadyApproved(
  context: ApprovalRequestContext,
  subject: string,
): boolean {
  const subjectKind = subjectKindForGate(context.gate);
  if (subjectKind === null) return false;
  if (subjectKind === "plan") {
    return (
      subject === "plan" &&
      approvalHeld(context.approvals, context.applies, "plan", null) !== null
    );
  }
  const elementId = elementForSubject(context.snapshot, subject);
  return (
    elementId !== null &&
    approvalHeld(context.approvals, context.applies, subjectKind, elementId) !==
      null
  );
}
