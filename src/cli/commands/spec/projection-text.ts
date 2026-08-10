/**
 * Renderings shared by `spec status` and the transition receipts. Every gate,
 * admission, and sign-off fact the CLI prints comes from the server's authoring
 * projection through this module, so the two surfaces cannot word the same fact
 * differently and neither reaches a verdict of its own.
 */
import type {
  AuthoringPendingBlockView,
  SpecGatePriorAdmission,
  SpecStatusView,
} from "@/lib/specs/view-schemas";

type ProjectedGate = SpecStatusView["gates"][number];
type GateApplicability = ProjectedGate["applicability"];
type GateState = ProjectedGate["state"];
type RevisionSignOff = SpecStatusView["revisionSignOff"];

/**
 * `pending` is evaluated against the current revision (or the selected run),
 * so say which revision it is pending on — otherwise a reader who also sees an
 * earlier admission cannot tell the two apart.
 */
function gateStateText(state: GateState): string {
  switch (state) {
    case "pending":
      return "pending on current revision";
    case "not_required":
      return "not required";
    case "admitted":
      return "admitted";
  }
}

/**
 * Why the gate does or does not ask something of this revision. The baseline
 * is the nearest APPROVED ancestor, never the immediate parent, so a gate can
 * be consulted for content that entered through an attempt a human withdrew.
 */
function gateApplicabilityText(applicability: GateApplicability): string {
  const base = applicability.governanceBaseRevisionId;
  switch (applicability.reason) {
    case "current_stage":
      return "consulted: the revision's current authoring stage";
    case "changed_since_governance_base":
      return base === null
        ? "consulted: no approved ancestor has admitted it"
        : `consulted: changed since revision ${base}`;
    case "unchanged_since_governance_base":
      return base === null
        ? "not consulted: this revision authors nothing it governs"
        : `not consulted: nothing it governs changed since revision ${base}`;
    case "dial_off":
      return "not consulted: it asks for no human approval right now";
  }
}

function gateLine(
  gate: Pick<ProjectedGate, "gate" | "dial" | "state" | "applicability">,
): string {
  return `${gate.gate}: ${gateStateText(gate.state)} (${gate.dial}) — ${gateApplicabilityText(gate.applicability)}`;
}

/**
 * One admission row. Whether it satisfies the current revision is said by the
 * list it came from — the projection's `currentAdmissions` or
 * `priorAdmissions` — so this text never claims either. `basis` stays visible
 * so a policy admission is not read as a human approval.
 */
function admissionText(admission: SpecGatePriorAdmission): string {
  const run =
    admission.executionId === null ? "" : ` for run ${admission.executionId}`;
  const actor = admission.actor === null ? "" : ` by ${admission.actor.kind}`;
  return `admitted on rev ${admission.revisionNumber}${run}${actor} (basis ${admission.basis})`;
}

/**
 * Each gate with the admissions that explain the current revision, then the
 * admissions that are only history. Nothing in the history position
 * establishes that the governed content is unchanged (Requirement 24.13), so
 * it is never folded into the state position or worded as still-satisfied.
 */
export function gateLines(gates: readonly ProjectedGate[]): string[] {
  return gates.flatMap((gate) => [
    `  ${gateLine(gate)}`,
    ...gate.currentAdmissions.map(
      (admission) => `    ${admissionText(admission)}`,
    ),
    ...gate.priorAdmissions.map(
      (admission) => `    history: ${admissionText(admission)}`,
    ),
  ]);
}

/**
 * The revision's own sign-off standing, reported beside the subject approvals
 * rather than folded into them: a consulted human gate stays pending after its
 * last subject approval until a human signs the revision off, so an empty
 * subject list is not an answer to "is anything outstanding".
 */
export function signOffLines(signOff: RevisionSignOff): string[] {
  if (signOff === null) return ["  none — no revision is under review"];
  const revision = `rev ${signOff.revisionNumber}`;
  switch (signOff.state) {
    case "signed_off":
      return [`  signed off (${revision})`];
    case "ready":
      return [
        `  outstanding (${revision}): nothing else blocks it — a human signs the revision off in Spec Studio`,
      ];
    case "blocked":
      return [
        `  outstanding (${revision}): ${signOff.unmetConditions.length} unmet condition${
          signOff.unmetConditions.length === 1 ? "" : "s"
        }`,
        ...signOff.unmetConditions.map((condition) => `    ${condition}`),
      ];
  }
}

/**
 * The block a transition receipt renders under its `acts next` line. Blocking
 * comment threads and sign-off lint findings block a revision as surely as an
 * outstanding subject does, so every unmet condition travels rather than one
 * subjects-or-sign-off scalar.
 */
export function pendingBlockLines(block: AuthoringPendingBlockView): string[] {
  return [
    ...(block.gates.length === 0
      ? []
      : [
          "blocking gates:",
          ...block.gates.map(
            (gate) =>
              `  ${gateLine(gate)}${
                gate.subjects.length === 0
                  ? ""
                  : ` — subjects: ${gate.subjects.join(", ")}`
              }`,
          ),
        ]),
    ...(block.unmetConditions.length === 0
      ? []
      : [
          "unmet conditions:",
          ...block.unmetConditions.map((condition) => `  ${condition}`),
        ]),
  ];
}

/** `2 elements`, `1 element` — pluralised where a count is read as prose. */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
