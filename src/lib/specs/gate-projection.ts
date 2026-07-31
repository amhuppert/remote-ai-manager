import { dialRequiresHumanApproval, resolveDial } from "./policy";
import { elementHandleInSnapshot, toDiffRows } from "./review-state";
import {
  actorProvenanceSchema,
  specGateSchema,
  type ActorProvenance,
  type ResolvedGateDial,
  type Spec,
  type SpecApprovalRow,
  type SpecExecutionRow,
  type SpecGate,
  type SpecGateAdmissionRow,
  type SpecRevision,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
} from "./schemas";
import { consultedAuthoringGates } from "./transitions";

/**
 * An admission this gate received on some other revision or run. Strictly
 * historical provenance: nothing here establishes that the content the gate
 * governs is unchanged since, so it must never be rendered as satisfaction.
 * `basis` stays visible so a Notify/Off policy admission is not mistaken for
 * a human approval.
 */
export interface SpecGatePriorAdmission {
  revisionId: string;
  revisionNumber: number;
  /** The run the admission covered, for the per-execution gates. */
  executionId: string | null;
  basis: SpecGateAdmissionRow["basis"];
  actor: ActorProvenance | null;
  admittedAt: string;
}

export interface SpecGateStatus {
  gate: SpecGate;
  dial: ResolvedGateDial;
  /** Evaluated against the current revision (or the selected run) only. */
  state: "pending" | "admitted" | "not_required";
  priorAdmissions: SpecGatePriorAdmission[];
}

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
 * one, whatever its state. A proposed revision under review is current, and so
 * is the latest approved one once no draft is open.
 */
export function latestRevision(
  revisions: readonly SpecRevision[],
): SpecRevision | null {
  return (
    [...revisions].sort((left, right) => right.number - left.number)[0] ?? null
  );
}

export function validApproval(
  approvals: readonly SpecApprovalRow[],
  subjectKind: SpecApprovalRow["subject_kind"],
  elementId: string | null,
): boolean {
  return approvals.some(
    (approval) =>
      approval.subject_kind === subjectKind &&
      approval.element_id === elementId &&
      approval.validity === "valid",
  );
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

export function gateStatuses(
  spec: Spec,
  revisionId: string | null,
  admissions: readonly SpecGateAdmissionRow[],
  currentExecution: Pick<
    SpecExecutionRow,
    | "id"
    | "revision_id"
    | "state"
    | "workflow_execution_id"
    | "execution_start_dial"
  > | null,
  revisionNumberById: ReadonlyMap<string, number>,
): SpecGateStatus[] {
  return specGateSchema.options.map((gate) => {
    const dial =
      gate === "execution_start" &&
      currentExecution?.execution_start_dial != null
        ? currentExecution.execution_start_dial
        : resolveDial(spec.gatePolicy, gate);
    // Execution-scoped gates admit one run, read against the run's PINNED
    // revision: an older run's admission must not make the current run read
    // as admitted, and a newer draft amendment must not hide the active
    // run's admission (its rows carry the pinned revision, not the draft).
    const countsNow = (admission: SpecGateAdmissionRow) =>
      admission.gate !== gate
        ? false
        : EXECUTION_SCOPED_GATES.has(gate)
          ? currentExecution !== null &&
            admission.execution_id === currentExecution.id &&
            admission.revision_id === currentExecution.revision_id
          : revisionId === null || admission.revision_id === revisionId;
    const admitted = admissions.some(countsNow);
    const frozenExecutionStartPending =
      gate === "execution_start" &&
      executionGateActionable("execution_start", currentExecution);
    // Everything the gate ever admitted that today's `state` does NOT reflect.
    // An amendment legitimately leaves a gate pending; without this an
    // operator cannot tell that from an approval that was lost.
    const priorAdmissions = admissions
      .filter((admission) => admission.gate === gate && !countsNow(admission))
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
    return {
      gate,
      dial,
      priorAdmissions,
      state: admitted
        ? "admitted"
        : frozenExecutionStartPending
          ? "pending"
          : dialRequiresHumanApproval(dial)
            ? "pending"
            : "not_required",
    };
  });
}

/**
 * Whether a human act exists right now for an execution-scoped gate. Before a
 * run exists there is nothing to approve, so a pending entry would be a Needs
 * You no act can clear — the same rule authoring subjects already obey.
 * Execution start is approvable exactly while the compiled definition parks
 * with its workflow lane linked (the grant path refuses in every other
 * position); delivery is grantable for any run that has not ended.
 */
function executionGateActionable(
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

export function pendingApprovals(
  snapshot: SpecRevisionSnapshot | null,
  baseSnapshot: SpecRevisionSnapshot | null,
  approvals: readonly SpecApprovalRow[],
  gates: readonly SpecGateStatus[],
  currentExecution: Pick<
    SpecExecutionRow,
    "state" | "workflow_execution_id"
  > | null,
): PendingApproval[] {
  if (snapshot === null) return [];

  const pending: PendingApproval[] = [];
  const consulted = new Set(
    consultedAuthoringGates(
      snapshot.revision.authoringStage,
      baseSnapshot === null ? [] : toDiffRows(baseSnapshot),
      toDiffRows(snapshot),
    ),
  );
  const gatePending = (gate: SpecGate) =>
    gates.some((status) => status.gate === gate && status.state === "pending");
  const handles = new Map(
    snapshot.elements.map((row) => [
      row.element.id,
      elementHandle(snapshot, row),
    ]),
  );
  for (const row of snapshot.elements) {
    if (
      row.element.kind === "requirement" &&
      consulted.has("requirements") &&
      gatePending("requirements") &&
      !validApproval(approvals, "requirement", row.element.id)
    ) {
      pending.push({
        gate: "requirements",
        subject: handles.get(row.element.id) ?? row.element.id,
        elementId: row.element.id,
      });
    }
    if (
      row.element.kind === "decision" &&
      consulted.has("design") &&
      gatePending("design") &&
      !validApproval(approvals, "decision", row.element.id)
    ) {
      pending.push({
        gate: "design",
        subject: handles.get(row.element.id) ?? row.element.id,
        elementId: row.element.id,
      });
    }
  }
  if (
    consulted.has("plan") &&
    snapshot.revision.authoringStage === "plan" &&
    gatePending("plan") &&
    !validApproval(approvals, "plan", null)
  ) {
    pending.push({ gate: "plan", subject: "plan", elementId: null });
  }
  for (const gate of ["execution_start", "delivery"] as const) {
    if (gatePending(gate) && executionGateActionable(gate, currentExecution)) {
      pending.push({ gate, subject: gate, elementId: null });
    }
  }
  return pending;
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
  spec: Spec;
  /** The revision the caller named. */
  requestedRevisionId: string;
  /** The revision the authoring gates are evaluated against right now. */
  currentRevisionId: string | null;
  snapshot: SpecRevisionSnapshot | null;
  baseSnapshot: SpecRevisionSnapshot | null;
  /** The run's pinned revision, where an execution-gate subject is addressed. */
  executionSnapshot: SpecRevisionSnapshot | null;
  approvals: readonly SpecApprovalRow[];
  admissions: readonly SpecGateAdmissionRow[];
  currentExecution: Pick<
    SpecExecutionRow,
    | "id"
    | "revision_id"
    | "state"
    | "workflow_execution_id"
    | "execution_start_dial"
  > | null;
  revisionNumberById: ReadonlyMap<string, number>;
  gate: SpecGate;
  /** Null asks the validation to resolve the gate's outstanding subject. */
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

export type ApprovalRequestValidation =
  | { readonly ok: true; readonly approval: PendingApproval }
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
 * learns to ignore the queue. The requestable set is exactly the outstanding
 * approvals of the current status projection, which is why this reads the same
 * gate states the status surface reports rather than trusting the caller.
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

  const gates = gateStatuses(
    context.spec,
    context.currentRevisionId,
    context.admissions,
    context.currentExecution,
    context.revisionNumberById,
  );
  const status = gates.find((candidate) => candidate.gate === context.gate);
  if (status === undefined || status.state === "not_required") {
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

  const outstanding = pendingApprovals(
    context.snapshot,
    context.baseSnapshot,
    context.approvals,
    gates,
    context.currentExecution,
  );
  const forGate = outstanding.filter(
    (candidate) => candidate.gate === context.gate,
  );

  // An omitted subject resolves rather than refusing: an execution gate's
  // outstanding entry IS the gate, and an authoring gate with exactly one
  // outstanding subject has an unambiguous answer. Only a genuinely ambiguous
  // ask sends the caller back for a --subject, and the refusal lists them.
  let subject: string;
  if (context.subject !== null) {
    subject = context.subject;
  } else if (!authoringScoped) {
    subject = context.gate;
  } else {
    const only = forGate.length === 1 ? forGate[0] : undefined;
    if (only !== undefined) {
      subject = only.subject;
    } else if (forGate.length === 0) {
      return refuse(
        "gate_not_applicable",
        `The ${context.gate} gate has nothing outstanding for the current revision.`,
        "Read the spec status for the gates that are actually blocking, then request one of those.",
      );
    } else {
      return refuse(
        "invalid_subject",
        `The ${context.gate} gate has ${forGate.length} outstanding subjects.`,
        `Pass --subject with one of: ${forGate.map((candidate) => candidate.subject).join(", ")}.`,
      );
    }
  }

  const matched = forGate.find((candidate) => candidate.subject === subject);
  if (matched !== undefined) return { ok: true, approval: matched };

  // An execution gate admits the run as a whole, so its outstanding entry is
  // the gate itself. Callers may still name the element the run is blocked on
  // so the human lands on it; that pointer must address something real.
  if (!authoringScoped && forGate.length > 0) {
    const target = elementForSubject(context.executionSnapshot, subject);
    if (target !== null) {
      return {
        ok: true,
        approval: {
          gate: context.gate,
          subject,
          elementId: target,
        },
      };
    }
    return refuse(
      "invalid_subject",
      `${subject} addresses nothing in the revision this run pinned.`,
      `Name the element the ${context.gate} gate is blocked on, or the gate itself: ${context.gate}.`,
    );
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
      `The ${context.gate} gate has nothing outstanding for the current revision.`,
      "Read the spec status for the gates that are actually blocking, then request one of those.",
    );
  }
  return refuse(
    "invalid_subject",
    `${subject} is not an outstanding subject at the ${context.gate} gate.`,
    `Request one of: ${forGate.map((candidate) => candidate.subject).join(", ")}.`,
  );
}

/** The approval subject kind an authoring gate asks a human to record. */
function subjectKindForGate(
  gate: SpecGate,
): SpecApprovalRow["subject_kind"] | null {
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
    return subject === "plan" && validApproval(context.approvals, "plan", null);
  }
  const elementId = elementForSubject(context.snapshot, subject);
  return (
    elementId !== null &&
    validApproval(context.approvals, subjectKind, elementId)
  );
}
