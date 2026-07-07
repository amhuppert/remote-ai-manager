/**
 * Lane-reminder rule engine (doc 04 §6.3, §6.4).
 *
 * Graph-workflow lane verbs carry tier-2 `reminders` — invariants the agent
 * must keep true while it keeps working (distinct from an ignorable `hint` and a
 * do-now `instruction`; see doc 04 §1.2). Reminders are server-authored and
 * state-conditional: a rule ships only when it clears the admission rule (§6.2):
 * earned by an observed failure class (the required `evidence` field), fired by
 * a runtime-state predicate, a true tier-2, and capped at 2 per response.
 *
 * This module is PURE — no I/O, no imports from route handlers. It is unit
 * tested directly at each predicate boundary (engineering-principles: extract
 * pure functions, test without mocks). The route handlers
 * (`lane-route-handlers.ts`) build the `LaneReminderInput` from execution state
 * and render whatever this returns.
 */

export type LaneVerb =
  | "task-complete"
  | "task-add"
  | "shared-doc-upsert"
  | "collab-request";

export interface LaneReminderInput {
  verb: LaneVerb;
  /** `contextState.iterationCount` — iterations this context has consumed. */
  iterationCount: number;
  /** `contextDef.circuitBreaker.consecutiveFailureThreshold` — the halt ceiling. */
  circuitBreakerThreshold: number;
  remainingTaskCount: number;
  /** Halt reason when the verb hit the 409 halt path; `null` on the success path. */
  halted: string | null;
}

export interface LaneReminderRule {
  id: string;
  verbs: LaneVerb[];
  /**
   * REQUIRED pointer to the observed failure class that earned this rule. This
   * field IS the enforcement of admission-rule clause 1 (doc 04 §6.2): no
   * speculated risks, only real incidents/failure classes.
   */
  evidence: string;
  when(input: LaneReminderInput): boolean;
  text(input: LaneReminderInput): string;
}

const iterationBudget: LaneReminderRule = {
  id: "iteration-budget",
  verbs: ["task-complete"],
  evidence:
    "Circuit-breaker halts in real executions (graph-workflow-audit findings): the breaker exists because retry loops happened.",
  when: (input) => input.circuitBreakerThreshold - input.iterationCount <= 2,
  text: (input) =>
    `This context has used ${input.iterationCount} of ${input.circuitBreakerThreshold} iterations — the circuit breaker halts the workflow at ${input.circuitBreakerThreshold}. Fix root causes before re-completing; script validators run before agent validators, so make the build/tests pass first.`,
};

const haltedStop: LaneReminderRule = {
  id: "halted-stop",
  verbs: ["task-complete", "task-add", "shared-doc-upsert", "collab-request"],
  evidence:
    "Join-conflict halt→repair→resume flow (memory: join-conflict-recovery) showed lanes need explicit stop guidance the moment a halt is pending.",
  when: (input) => input.halted !== null,
  text: (input) =>
    `This workflow is halted: ${input.halted ?? ""}. Do not continue task work; end your turn — the workflow resumes via repair or user action.`,
};

const laneAutonomy: LaneReminderRule = {
  id: "lane-autonomy",
  verbs: ["task-complete"],
  evidence:
    "Lanes stalling instead of collaborating (collab memories, 2026-06); the collab machinery exists precisely for a blocked lane.",
  when: (input) => input.iterationCount >= 2,
  text: () =>
    'This lane is autonomous — `cctl ask` is unavailable here. If genuinely blocked, send `cctl workflow collab request --brief "<specific question>"` and stop.',
};

/**
 * The v1 rule set, in priority order. `computeLaneReminders` evaluates rules in
 * this order and caps at the first two eligible texts, so array position is the
 * priority (admission-rule clause 4).
 */
export const LANE_REMINDER_RULES: LaneReminderRule[] = [
  iterationBudget,
  haltedStop,
  laneAutonomy,
];

const MAX_REMINDERS = 2;

export interface LaneReminderResult {
  /** Rendered reminder texts, in priority order (≤ 2). */
  reminders: string[];
  /** Ids of the rules that fired, parallel to `reminders` — for the log event. */
  ruleIds: string[];
}

/**
 * Filter the rule set by verb, evaluate each rule's `when` predicate, and return
 * the first ≤ 2 fired rules' texts + ids in rule-array order (admission-rule
 * cap, doc 04 §6.2). Route handlers need the ids for the
 * `graph-workflow-lane.reminders_emitted` log event.
 */
export function evaluateLaneReminders(
  input: LaneReminderInput,
): LaneReminderResult {
  const reminders: string[] = [];
  const ruleIds: string[] = [];
  for (const rule of LANE_REMINDER_RULES) {
    if (!rule.verbs.includes(input.verb)) continue;
    if (!rule.when(input)) continue;
    reminders.push(rule.text(input));
    ruleIds.push(rule.id);
    if (reminders.length === MAX_REMINDERS) break;
  }
  return { reminders, ruleIds };
}

/**
 * The reminder texts only (≤ 2, priority-ordered). Thin wrapper over
 * {@link evaluateLaneReminders} for callers that don't need the rule ids.
 */
export function computeLaneReminders(input: LaneReminderInput): string[] {
  return evaluateLaneReminders(input).reminders;
}
