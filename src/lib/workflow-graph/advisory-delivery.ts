/**
 * How a round's advisories reach the implementer, and how the answer comes back.
 *
 * Three ideas carry everything here.
 *
 * First, identity is the engine's to assign. An advisory is stamped
 * {roundSeq, assignmentId, ordinal} when the lane that raised it settles, and
 * every later reference — delivery, disposition, the execution-level index — is
 * to that triple. A validator writes about the work, not about itself, so an
 * identity it reported would be a claim the engine could not check.
 *
 * Second, delivery is exactly-once and round-scoped. `deliveredAt` on the round
 * record is the whole bookkeeping: the fresh set is the round's advisories that
 * carry none, and the mutation that delivers them stamps them. Nothing dedups
 * across rounds because nothing needs to — a round's advisories belong to that
 * round's `seq`, and the re-certification round runs no advisory lanes, so it
 * raises none to deliver.
 *
 * Third, the answer is a contract, not a courtesy. The dispositions come back
 * through the same structured-output gate every other engine capture uses. The
 * dispatched schema says the shape and the batch size — as much as a schema a
 * provider-native backend will accept can say. What it cannot say is checked in
 * {@link parseAdvisoryDispositions}: that the returned set is exactly the
 * delivered set, no advisory missed, invented, or answered twice, and that a
 * decline carries its reason. Each is reported as the same kind of failure as a
 * schema rejection, so the same retry answers it. Nothing else may produce a
 * disposition: a delivered advisory carries the turn's validated answer or the
 * turn failed, because the only value the engine could write in its place is one
 * no one decided.
 *
 * Pure: prompts, schemas, and set arithmetic only. The turn that carries them is
 * `advisory-response-runner.ts`, and the round record they are written to is the
 * orchestrator's.
 */

import {
  ADVISORY_DISPOSITION_VALUES,
  workflowAdvisoryDispositionsResultSchema,
  type WorkflowAdvisoryDispositionEntry,
  type WorkflowAdvisoryIdentity,
  type WorkflowValidatorAdvisory,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowValidationAdvisory,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";

/**
 * The framing every delivery carries, on both paths, verbatim.
 *
 * One constant rather than one wording per path: the permission to decline is
 * the substance of the non-binding channel, and a failing round's copy drifting
 * from a passing round's would make the same advisory binding in one and not in
 * the other.
 */
export const ADVISORY_NON_BINDING_FRAMING = [
  "These advisories are NOT requirements. None of them reopened a task, none of them",
  "failed this execution context, and none of them obliges you to change your work.",
  "Act on an advisory only where you judge it right. You may decline any of them, and",
  "a one-line reason is all a decline needs.",
].join("\n");

/** The stable rendering of an identity, for prompts, logs, and diagnostics. */
export function advisoryIdentityKey(
  identity: WorkflowAdvisoryIdentity,
): string {
  return `${identity.roundSeq}:${identity.assignmentId}:${identity.ordinal}`;
}

/**
 * Turn one lane's reported advisories into round records, stamping the identity
 * the engine — not the validator — decides.
 */
export function stampAdvisoryIdentities(input: {
  roundSeq: number;
  assignmentId: string;
  advisories: readonly WorkflowValidatorAdvisory[];
}): GraphWorkflowValidationAdvisory[] {
  return input.advisories.map((advisory, index) => ({
    kind: advisory.kind,
    title: advisory.title,
    description: advisory.description,
    identity: {
      roundSeq: input.roundSeq,
      assignmentId: input.assignmentId,
      // 1-based: an ordinal names a position in a list a human reads, and the
      // identity appears in prompts and in the advisory index.
      ordinal: index + 1,
    },
    deliveredAt: null,
    disposition: null,
  }));
}

/**
 * This round's advisories that the implementer has not been shown, in roster
 * order and then in the order each lane raised them.
 *
 * Roster order rather than record-insertion order: the roster is what the round
 * froze, so two runs of the same round deliver the same list whatever order the
 * lanes happened to settle in.
 */
export function collectFreshAdvisories(
  round: GraphWorkflowValidationRound,
): GraphWorkflowValidationAdvisory[] {
  const fresh: GraphWorkflowValidationAdvisory[] = [];
  for (const seat of round.roster) {
    const advisories = round.specialists[seat.assignmentId]?.advisories ?? [];
    fresh.push(
      ...[...advisories]
        .filter((advisory) => advisory.deliveredAt === null)
        .sort((left, right) => left.identity.ordinal - right.identity.ordinal),
    );
  }
  return fresh;
}

function renderAdvisory(advisory: GraphWorkflowValidationAdvisory): string {
  return [
    `### ${advisoryIdentityKey(advisory.identity)} (${advisory.kind}) — ${advisory.title}`,
    advisory.description,
  ].join("\n");
}

/**
 * The block appended to a reopened task's failure message on a failing round.
 *
 * The heading says whose voice this is and what it is not, because the message
 * it rides on is a list of things the implementer MUST fix, and an advisory
 * sitting under that heading unannounced would read as one more of them.
 */
export function buildAdvisoryFailureAppendix(
  advisories: readonly GraphWorkflowValidationAdvisory[],
): string {
  return [
    "",
    "## Validator advisories from this round (non-binding)",
    "",
    ADVISORY_NON_BINDING_FRAMING,
    "",
    ...advisories.map(renderAdvisory),
  ].join("\n");
}

/**
 * The advisory-response turn: the list, the framing, and what the engine expects
 * back. Dispatched only on a PASSING round — a failing round's advisories ride
 * the remediation the implementer is already being sent back to do.
 */
export function buildAdvisoryResponsePrompt(input: {
  contextTitle: string;
  advisories: readonly GraphWorkflowValidationAdvisory[];
}): string {
  const count = input.advisories.length;
  return [
    "# Validator Advisories",
    "",
    `The validators for execution context "${input.contextTitle}" passed it. Alongside their verdicts they raised ${count} advisory observation${count === 1 ? "" : "s"} for you.`,
    "",
    ADVISORY_NON_BINDING_FRAMING,
    "",
    "## Advisories",
    "",
    ...input.advisories.map(renderAdvisory),
    "",
    "## Required Output",
    "",
    `Return exactly ${count} disposition${count === 1 ? "" : "s"} — one per advisory above, carrying that advisory's identity verbatim:`,
    "- `addressed`: you changed the work in response to it.",
    "- `declined`: you are not acting on it. A one-line `reason` is required.",
    "- `deferred`: worth doing, but not as part of this execution context.",
    "",
    "Every disposition carries a `reason` field: the one-line explanation when you decline, and `null` otherwise.",
  ].join("\n");
}

/**
 * The re-ask after a disposition set that did not cover the batch.
 *
 * It restates the advisories rather than assuming the turn still remembers
 * them, and it names every violation by identity: the first ask already said
 * what the contract is, so a re-ask that only repeated it would be asking the
 * same question twice.
 */
export function buildAdvisoryResponseRetryPrompt(input: {
  contextTitle: string;
  advisories: readonly GraphWorkflowValidationAdvisory[];
  issues: readonly string[];
}): string {
  return [
    "Your dispositions did not match the advisories that were delivered:",
    "",
    ...input.issues.map((issue) => `- ${issue}`),
    "",
    "Answer again, with exactly one disposition per advisory below and each advisory's identity verbatim.",
    "",
    buildAdvisoryResponsePrompt({
      contextTitle: input.contextTitle,
      advisories: input.advisories,
    }),
  ].join("\n");
}

const IDENTITY_SCHEMA_PROPERTIES = {
  roundSeq: { type: "integer" },
  assignmentId: { type: "string" },
  ordinal: { type: "integer" },
} as const;

/**
 * The dispositions schema for one delivered batch.
 *
 * Every keyword here is one a provider-native backend will accept: no `oneOf`
 * over the three dispositions, no property left out of `required`, and no
 * `const` without a `type`. Codex dispatches this schema to OpenAI's strict
 * structured-output validator verbatim, which refuses all three and fails the
 * turn with HTTP 400 before it runs — a halt the engine cannot retry its way
 * out of. So the schema states the SHAPE, and the two rules it can no longer
 * carry — that a decline owes a reason, and that the entries name the delivered
 * set exactly once each — are checked in {@link parseAdvisoryDispositions},
 * which reports them as the same retryable issues.
 *
 * `reason` is nullable rather than absent for the same reason: a strict subset
 * has no optional properties, so "nothing to say" has to be a value.
 *
 * The item count is pinned to the batch size because that much of "exactly one
 * per delivered advisory" a portable schema can still say.
 */
export function buildAdvisoryDispositionsOutputSchema(
  advisories: readonly GraphWorkflowValidationAdvisory[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      dispositions: {
        type: "array",
        minItems: advisories.length,
        maxItems: advisories.length,
        items: {
          type: "object",
          properties: {
            identity: {
              type: "object",
              properties: IDENTITY_SCHEMA_PROPERTIES,
              required: ["roundSeq", "assignmentId", "ordinal"],
              additionalProperties: false,
            },
            disposition: {
              type: "string",
              enum: [...ADVISORY_DISPOSITION_VALUES],
            },
            reason: { type: ["string", "null"] },
          },
          required: ["identity", "disposition", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["dispositions"],
    additionalProperties: false,
  };
}

/** A disposition as the engine records it: the union's optional reason resolved. */
export interface RecordedAdvisoryDisposition {
  identity: WorkflowAdvisoryIdentity;
  disposition: WorkflowAdvisoryDispositionEntry["disposition"];
  reason: string | null;
}

export type ParsedAdvisoryDispositions =
  | { ok: true; dispositions: RecordedAdvisoryDisposition[] }
  | { ok: false; issues: string[] };

/**
 * Read the response turn's payload as one disposition per delivered advisory.
 *
 * Coverage is checked as a SET, not as a sequence: an implementer answering in
 * its own order is answering correctly, so only three things are wrong about a
 * set — an advisory left unanswered, an identity nobody delivered, and one
 * answered twice. A bare decline is the fourth, and it lives here rather than in
 * the dispatched schema because the shape a provider-native backend accepts
 * cannot make one field's presence depend on another's value. Each is reported
 * by identity so the retry prompt can name it, and each is the same kind of
 * failure as a schema rejection, because a disposition set that does not cover
 * the batch is not a partial answer the engine may keep.
 */
export function parseAdvisoryDispositions(input: {
  structuredOutput: unknown;
  delivered: readonly GraphWorkflowValidationAdvisory[];
}): ParsedAdvisoryDispositions {
  const parsed = workflowAdvisoryDispositionsResultSchema.safeParse(
    input.structuredOutput,
  );
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    };
  }

  const expected = new Map(
    input.delivered.map((advisory) => [
      advisoryIdentityKey(advisory.identity),
      advisory,
    ]),
  );
  const answered = new Map<string, RecordedAdvisoryDisposition>();
  const issues: string[] = [];

  for (const entry of parsed.data.dispositions) {
    const key = advisoryIdentityKey(entry.identity);
    if (!expected.has(key)) {
      issues.push(
        `Disposition ${key} names an advisory that was not delivered in this round.`,
      );
      continue;
    }
    if (answered.has(key)) {
      issues.push(`Advisory ${key} was given more than one disposition.`);
      continue;
    }
    const reason = entry.reason?.trim() ?? "";
    // Recorded before the decline check so a bare decline reads as one defect:
    // an entry left out of `answered` would also be reported as an advisory that
    // received no disposition, which is not what the turn did wrong.
    answered.set(key, {
      identity: entry.identity,
      disposition: entry.disposition,
      reason: reason.length > 0 ? reason : null,
    });
    if (entry.disposition === "declined" && reason.length === 0) {
      issues.push(
        `Advisory ${key} was declined without a reason. A decline owes a one-line reason.`,
      );
    }
  }

  for (const key of expected.keys()) {
    if (answered.has(key)) continue;
    issues.push(`Advisory ${key} was delivered but received no disposition.`);
  }

  if (issues.length > 0) return { ok: false, issues };

  // Emitted in DELIVERED order, not in the order the turn answered: the record
  // this writes onto is ordered by identity, and a caller zipping the two lists
  // must not depend on how the implementer chose to sort its reply.
  const ordered: RecordedAdvisoryDisposition[] = [];
  for (const key of expected.keys()) {
    const entry = answered.get(key);
    if (entry !== undefined) ordered.push(entry);
  }
  return { ok: true, dispositions: ordered };
}
