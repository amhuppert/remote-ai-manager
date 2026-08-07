/**
 * Plan-repair verdict + restricted operation validation (docs/design/cc-cli/08).
 *
 * The repair agent's output is UNTRUSTED input. Its `operations` are re-parsed
 * against the full live-edit union (no shape drift) and then filtered through
 * the plan/controls split: the agent may change the plan (charter, context
 * prose/AC, budgets, tasks) but never the controls (validators, gates,
 * mutability, its own policy). Violations reject the batch — fail closed.
 *
 * One controls-side exception, narrowing only (R10/D10): a repair may rewrite
 * what a validator assignment is told to judge, and may take a seat's blocking
 * authority away. It may never grant blocking authority, and it never writes a
 * cohort — see `update-validator-assignment` below.
 *
 * Admission and expansion are deliberately two calls. Admission judges the
 * agent's output when it arrives; expansion builds the cohort write from
 * whatever state the apply is about to be guarded against, minutes later.
 */

import { z } from "zod";
import {
  workflowLiveEditOperationSchema,
  type WorkflowLiveEditOperation,
} from "@/lib/workflows/edit-schemas";
import {
  validatorAuthoritySchema,
  type SeededValidatorCohort,
  type ValidatorCohort,
} from "../config-schemas";

// The verdict the repair agent must return (structured-output enforced).
export const planRepairVerdictSchema = z.object({
  planningDefect: z.boolean(),
  diagnosis: z.string().min(1),
  // `type` is required HERE (not just at the allowlist) so the backend's
  // native structured output forces well-shaped ops out of the model —
  // the first live proof produced typeless operations under a fully loose
  // schema. Each entry is still re-parsed by `validatePlanRepairOperations`
  // against the real op union.
  operations: z.array(z.looseObject({ type: z.string().min(1) })).default([]),
});
export type PlanRepairVerdict = z.infer<typeof planRepairVerdictSchema>;

export const PLAN_REPAIR_VERDICT_JSON_SCHEMA: Record<string, unknown> =
  z.toJSONSchema(planRepairVerdictSchema, { io: "input" }) as Record<
    string,
    unknown
  >;

/**
 * The one op that reaches a validator assignment (R10/D10).
 *
 * Repair-only vocabulary: it names ONE assignment and the at-most-two fields a
 * repair may narrow, and the engine expands it into the live-edit `update-
 * context` the apply core already understands. The agent never writes the
 * cohort itself, so no repair can reorder the roster, swap a profile, or drop
 * the reviewer that keeps objecting — the shapes that would let it do so are
 * not expressible here.
 */
export const PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE =
  "update-validator-assignment";

const planRepairValidatorAssignmentOpSchema = z
  .object({
    type: z.literal(PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE),
    contextId: z.string().trim().min(1),
    assignmentId: z.string().trim().min(1),
    /** Replaces the assignment's authored instructions (its `focus`). */
    instructions: z.string().trim().min(1).optional(),
    // Both values parse so a promotion is REFUSED with a reason the round
    // records, rather than bouncing off a schema as a malformed op: "you may
    // not do this" and "that is not a thing" are different diagnoses, and the
    // repair agent only learns from the first.
    authority: validatorAuthoritySchema.optional(),
  })
  .strict();

/** One admitted narrowing, still in repair vocabulary — not yet a cohort write. */
export type ValidatorAssignmentNarrowing = z.infer<
  typeof planRepairValidatorAssignmentOpSchema
>;

/** Op types the repair agent may emit — plan artifacts, plus D10 narrowing. */
const ALLOWED_PLAN_REPAIR_OP_TYPES = new Set([
  "amend-charter",
  "update-context",
  "add-task",
  "update-task",
  "remove-task",
  "reorder-tasks",
  PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE,
]);

/**
 * The three loop repairs R12 admits, at their three grains. Kept OUT of the
 * general allowlist because they are admitted only on a `loop_limit_reached`
 * halt, for the loop that halted — see {@link PlanRepairLoopContext}.
 *
 * Nothing else about a started loop is reachable from here: membership,
 * structural graph edits and the per-execution pass backstop have no operation
 * that names them (the template vocabulary carries content ops only), so those
 * repairs are refused by the vocabulary rather than by a check this list would
 * have to remember.
 */
const LOOP_CONTROL_OP_TYPES = new Set([
  "raise-loop-max-passes",
  "amend-loop-predicate",
  "edit-loop-template",
]);

/**
 * The halted loop a repair round is running for. Absent (the default) means the
 * halt is not a loop halt, and every loop-control op is refused — fail closed,
 * so a caller that forgets to thread the trigger's loop through cannot
 * accidentally admit them.
 */
export interface PlanRepairLoopContext {
  loopGroupId: string;
  /** Which budget refused — a backstop halt admits no cap raise. */
  scope: "loop" | "execution";
}

/**
 * `update-context` fields the repair agent may NOT touch. These parse fine on
 * the shared op schema (they are legitimate live-edit fields for humans), so
 * presence is checked explicitly after the parse.
 */
const UPDATE_CONTEXT_CONTROL_BLOCKS = [
  "implementer",
  "contextValidator",
  "scriptValidator",
  "humanApprovalGate",
  "askUserQuestions",
  "mutability",
  "collaboration",
  "planRepair",
] as const;

export interface PlanRepairOperationIssue {
  index: number;
  message: string;
}

/**
 * What admission produces: live-edit ops the apply core already understands,
 * plus narrowings still awaiting the cohort they will be written against.
 * Discriminated by `type` — the live-edit union has no
 * `update-validator-assignment` member.
 */
export type PlanRepairAdmittedOperation =
  | WorkflowLiveEditOperation
  | ValidatorAssignmentNarrowing;

/**
 * The two rules a loop-control op answers to beyond its own schema. Returns the
 * refusal message, or null when the op is admissible.
 */
function checkLoopControlOperation(
  operation: WorkflowLiveEditOperation,
  loop: PlanRepairLoopContext,
): string | null {
  const addressed =
    "loopGroupId" in operation ? operation.loopGroupId : undefined;
  if (addressed !== loop.loopGroupId) {
    return `loop-control operation addresses loop group "${String(addressed)}", but this repair was triggered by a halt on "${loop.loopGroupId}" — a round may only repair the loop that halted`;
  }
  // The per-execution pass backstop is unraisable (R10.3). When it is the
  // budget that refused, a bigger per-loop cap buys nothing: the remedy is a
  // predicate or template amendment that lets the running loops conclude.
  if (
    operation.type === "raise-loop-max-passes" &&
    loop.scope === "execution"
  ) {
    return `raise-loop-max-passes cannot repair a backstop halt: the per-execution pass backstop is unraisable, so amend the exit predicate or the body template instead`;
  }
  return null;
}

export type ValidatePlanRepairOperationsResult =
  | { ok: true; operations: PlanRepairAdmittedOperation[] }
  | { ok: false; issues: PlanRepairOperationIssue[] };

export type ExpandPlanRepairOperationsResult =
  | { ok: true; operations: WorkflowLiveEditOperation[] }
  | { ok: false; issues: PlanRepairOperationIssue[] };

/**
 * A context as this validation reads it: its id and the cohort a narrowing op
 * is judged against. Structural rather than the resolved context type, because
 * nothing else about a context decides whether a narrowing is legal.
 */
export interface PlanRepairCohortSite {
  id: string;
  contextValidator: SeededValidatorCohort;
}

/**
 * The cohort as a live edit writes it: authored assignments, no resolved bytes.
 *
 * Dropping `profileSnapshot` is what makes an expansion an EDIT rather than a
 * replay — the edit pipeline recomposes the narrowed seat's block (a demoted
 * seat's instructions move from mandate to focus, which changes the bytes) and
 * re-pins every seat's snapshot before the mutation opens.
 */
function toAuthoredCohort(cohort: SeededValidatorCohort): ValidatorCohort {
  return {
    enabled: cohort.enabled,
    assignments: cohort.assignments.map(
      ({ profileSnapshot, ...authored }) => authored,
    ),
  };
}

export function validatePlanRepairOperations(
  raw: unknown,
  contexts: readonly PlanRepairCohortSite[] = [],
  loop: PlanRepairLoopContext | null = null,
): ValidatePlanRepairOperationsResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      issues: [{ index: 0, message: "operations must be an array" }],
    };
  }

  const issues: PlanRepairOperationIssue[] = [];
  const operations: PlanRepairAdmittedOperation[] = [];
  const permitted = [
    ...ALLOWED_PLAN_REPAIR_OP_TYPES,
    ...(loop ? LOOP_CONTROL_OP_TYPES : []),
  ];

  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index];
    const type =
      typeof candidate === "object" && candidate !== null
        ? (candidate as Record<string, unknown>)["type"]
        : undefined;
    const isLoopControl =
      typeof type === "string" && LOOP_CONTROL_OP_TYPES.has(type);

    if (
      typeof type !== "string" ||
      (!isLoopControl && !ALLOWED_PLAN_REPAIR_OP_TYPES.has(type))
    ) {
      issues.push({
        index,
        message: `operation type "${String(type)}" is not permitted for plan repair (allowed: ${permitted.join(", ")})`,
      });
      continue;
    }

    if (isLoopControl && loop === null) {
      issues.push({
        index,
        message: `operation type "${type}" is admitted only on a loop_limit_reached halt`,
      });
      continue;
    }

    if (type === PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE) {
      const admitted = admitValidatorAssignmentNarrowing(candidate, contexts);
      if (admitted.ok) {
        operations.push(admitted.narrowing);
      } else {
        issues.push({ index, message: admitted.message });
      }
      continue;
    }

    const parsed = workflowLiveEditOperationSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push({
        index,
        message: `invalid ${type} operation: ${parsed.error.issues[0]?.message ?? "schema violation"}`,
      });
      continue;
    }

    if (isLoopControl && loop !== null) {
      const rejection = checkLoopControlOperation(parsed.data, loop);
      if (rejection) {
        issues.push({ index, message: rejection });
        continue;
      }
    }

    if (parsed.data.type === "update-context") {
      const touched = UPDATE_CONTEXT_CONTROL_BLOCKS.filter(
        (block) =>
          (parsed.data as unknown as Record<string, unknown>)[block] !==
          undefined,
      );
      if (touched.length > 0) {
        issues.push({
          index,
          message: `update-context may not touch control block(s) ${touched.join(", ")} — plan repair edits plan artifacts only`,
        });
        continue;
      }
    }

    operations.push(parsed.data);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  if (operations.length === 0) {
    return {
      ok: false,
      issues: [{ index: 0, message: "operations must not be empty" }],
    };
  }
  return { ok: true, operations };
}

function isValidatorAssignmentNarrowing(
  operation: PlanRepairAdmittedOperation,
): operation is ValidatorAssignmentNarrowing {
  return operation.type === PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE;
}

/**
 * Resolve the admitted operations into the live edits that perform them,
 * against the cohorts `contexts` holds RIGHT NOW.
 *
 * The caller passes the same snapshot its apply is revision-guarded against,
 * never the one the agent was shown: a narrowing names one seat, but it is
 * carried out as a whole-cohort write, so expanding it from a stale roster
 * would silently revert whatever an operator changed while the repair agent
 * was thinking. A named seat that has since disappeared refuses the batch
 * rather than resurrecting it.
 */
export function expandPlanRepairOperations(
  operations: readonly PlanRepairAdmittedOperation[],
  contexts: readonly PlanRepairCohortSite[],
): ExpandPlanRepairOperationsResult {
  const issues: PlanRepairOperationIssue[] = [];
  const expanded: WorkflowLiveEditOperation[] = [];
  // Each expansion replaces a whole cohort, so a second narrowing on the same
  // context has to build on the first — expanding both from the stored cohort
  // would make the last op silently discard the earlier one.
  const narrowedCohorts = new Map<string, ValidatorCohort>();

  for (const [index, operation] of operations.entries()) {
    if (!isValidatorAssignmentNarrowing(operation)) {
      expanded.push(operation);
      continue;
    }
    const expansion = expandValidatorAssignmentNarrowing({
      narrowing: operation,
      contexts,
      narrowedCohorts,
    });
    if (expansion.ok) {
      expanded.push(expansion.operation);
    } else {
      issues.push({ index, message: expansion.message });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, operations: expanded };
}

type ValidatorAssignmentAdmission =
  | { ok: true; narrowing: ValidatorAssignmentNarrowing }
  | { ok: false; message: string };

/**
 * One narrowing op as the agent wrote it, judged and kept in its own vocabulary.
 *
 * The refusals are the whole point of the op existing: every way a repair could
 * widen its own mandate is a message here rather than an unreachable state, so
 * the round record says which line the agent tried to cross. The cohort lookup
 * is a diagnosis, not the write — naming a seat that does not exist is the
 * agent's own error, and it should read that way in the round record even
 * though expansion checks membership again against the state it lands on.
 */
function admitValidatorAssignmentNarrowing(
  candidate: unknown,
  contexts: readonly PlanRepairCohortSite[],
): ValidatorAssignmentAdmission {
  const parsed = planRepairValidatorAssignmentOpSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      message: `invalid ${PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE} operation: ${parsed.error.issues[0]?.message ?? "schema violation"}`,
    };
  }
  const narrowing = parsed.data;

  if (
    narrowing.instructions === undefined &&
    narrowing.authority === undefined
  ) {
    return {
      ok: false,
      message: `${PLAN_REPAIR_VALIDATOR_ASSIGNMENT_OP_TYPE} requires instructions, authority, or both`,
    };
  }

  if (narrowing.authority === "blocking") {
    return {
      ok: false,
      message: `plan repair may not set authority "blocking" on validator assignment "${narrowing.assignmentId}" — a repair may demote blocking to advisory, never grant blocking authority (granting it is the workflow author's decision)`,
    };
  }

  const seat = findNarrowingSeat(narrowing, contexts);
  if (!seat.ok) {
    return { ok: false, message: seat.message };
  }
  return { ok: true, narrowing };
}

type NarrowingSeat =
  | { ok: true; cohort: ValidatorCohort; seatIndex: number }
  | { ok: false; message: string };

function findNarrowingSeat(
  narrowing: ValidatorAssignmentNarrowing,
  contexts: readonly PlanRepairCohortSite[],
  /** Cohorts an earlier narrowing in the same batch has already rewritten. */
  narrowedCohorts?: ReadonlyMap<string, ValidatorCohort>,
): NarrowingSeat {
  const site = contexts.find((entry) => entry.id === narrowing.contextId);
  const cohort =
    narrowedCohorts?.get(narrowing.contextId) ??
    (site === undefined ? undefined : toAuthoredCohort(site.contextValidator));
  if (cohort === undefined) {
    return {
      ok: false,
      message: `context "${narrowing.contextId}" is not in the working definition`,
    };
  }

  const seatIndex = cohort.assignments.findIndex(
    (assignment) => assignment.id === narrowing.assignmentId,
  );
  if (seatIndex === -1) {
    return {
      ok: false,
      message: `validator assignment "${narrowing.assignmentId}" is not in context "${narrowing.contextId}"'s cohort`,
    };
  }
  return { ok: true, cohort, seatIndex };
}

type ValidatorAssignmentExpansion =
  | { ok: true; operation: WorkflowLiveEditOperation }
  | { ok: false; message: string };

/** One admitted narrowing, written onto the cohort it is being applied to. */
function expandValidatorAssignmentNarrowing(input: {
  narrowing: ValidatorAssignmentNarrowing;
  contexts: readonly PlanRepairCohortSite[];
  narrowedCohorts: Map<string, ValidatorCohort>;
}): ValidatorAssignmentExpansion {
  const { narrowing } = input;
  const seat = findNarrowingSeat(
    narrowing,
    input.contexts,
    input.narrowedCohorts,
  );
  if (!seat.ok) {
    return { ok: false, message: seat.message };
  }

  const nextCohort: ValidatorCohort = {
    enabled: seat.cohort.enabled,
    assignments: seat.cohort.assignments.map((assignment, index) =>
      index === seat.seatIndex
        ? {
            ...assignment,
            ...(narrowing.instructions === undefined
              ? {}
              : { focus: narrowing.instructions }),
            ...(narrowing.authority === undefined
              ? {}
              : { authority: narrowing.authority }),
          }
        : assignment,
    ),
  };

  // Re-parsed through the live-edit union like every other admitted op: the
  // expansion is engine-authored, but it is not exempt from the shape the apply
  // core will see. The control-block ban above deliberately does not apply —
  // that rule is about what the AGENT may write, and this cohort is not its
  // writing.
  const reparsed = workflowLiveEditOperationSchema.safeParse({
    type: "update-context",
    contextId: narrowing.contextId,
    contextValidator: nextCohort,
  });
  if (!reparsed.success) {
    return {
      ok: false,
      message: `narrowing validator assignment "${narrowing.assignmentId}" produced an invalid cohort: ${reparsed.error.issues[0]?.message ?? "schema violation"}`,
    };
  }

  input.narrowedCohorts.set(narrowing.contextId, nextCohort);
  return { ok: true, operation: reparsed.data };
}
