import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { PLAN_REPAIR_TURN_TIMEOUT_MS } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  PlanRepairRound,
} from "@/lib/workflow-graph/schemas";

/**
 * Whether an agent is working on the standing halt right now.
 *
 * A halted run says nothing about liveness on its own: the plan-repair
 * supervisor appends its round BEFORE the repair agent's turn opens and settles
 * it after, so for as long as that turn runs the execution reads `halted` while
 * an agent is actively rewriting the plan that will resume it. The unsettled
 * round is the only durable marker of that turn, and this is the one place that
 * reads it — every halt surface asks here rather than re-deciding what "halted"
 * means.
 */

export interface PlanRepairActivity {
  /** `working` = a repair agent's turn is open. `stopped` = nobody is on it. */
  readonly kind: "working" | "stopped";
  /**
   * The unsettled round whose agent can still be running — null both when no
   * round is open and when one is open but past the turn budget below.
   */
  readonly openRound: PlanRepairRound | null;
  /**
   * The rounds that answer the STANDING halt, oldest first — an earlier halt's
   * rounds are not this halt's answer, and reporting them would credit a
   * verdict to a failure it never looked at. Empty when repair never ran for
   * this halt, which is most halts: only the retry-exhaustion kinds and the
   * plan-shaped refusals are repairable at all.
   */
  readonly rounds: readonly PlanRepairRound[];
}

/**
 * What a round is accounted against, mirroring the supervisor's own subject
 * resolution: a loop halt keys on the loop GROUP (every pass is a fresh
 * context, so the pass instance in the halt is not stable across rounds), a
 * context halt keys on the context.
 */
interface HaltRepairSubject {
  readonly haltType: PlanRepairRound["haltType"];
  readonly contextId: string;
  readonly loopGroupId: string | null;
}

function haltRepairSubject(
  reason: GraphWorkflowHaltReason | null,
): HaltRepairSubject | null {
  if (reason === null) return null;
  switch (reason.type) {
    case "loop_limit_reached":
      return {
        haltType: reason.type,
        contextId: reason.contextId,
        loopGroupId: reason.loopGroupId,
      };
    case "circuit_breaker":
    case "max_iterations":
    case "ownership_violation":
    case "plan_defect":
    case "candidate_unstable":
      return {
        haltType: reason.type,
        contextId: reason.contextId,
        loopGroupId: null,
      };
    default:
      return null;
  }
}

function answersSubject(
  round: PlanRepairRound,
  subject: HaltRepairSubject,
): boolean {
  if (round.haltType !== subject.haltType) return false;
  return subject.loopGroupId === null
    ? round.loopGroupId === null && round.contextId === subject.contextId
    : round.loopGroupId === subject.loopGroupId;
}

/**
 * How long an unsettled round is believed to still have an agent behind it.
 *
 * The supervisor bounds the repair turn and settles the round on its way out,
 * so a round still open past that budget was orphaned — a server restart
 * mid-turn leaves `settledAt` null forever, and claiming an agent is on it is
 * the same lie as reporting an inert halt, only in the other direction. Derived
 * from the budget itself so the two cannot drift; the slack covers the settle
 * write and clock skew between the server and the browser reading this.
 */
const OPEN_ROUND_TRUST_WINDOW_MS = PLAN_REPAIR_TURN_TIMEOUT_MS + 5 * 60_000;

function isBelievablyOpen(round: PlanRepairRound, now: number): boolean {
  if (round.settledAt !== null) return false;
  const startedAt = new Date(round.startedAt).getTime();
  // An unparseable timestamp is not evidence of a dead agent; the round log is
  // server-written, so trust it and let the elapsed time speak in the sentence.
  return Number.isNaN(startedAt)
    ? true
    : now - startedAt <= OPEN_ROUND_TRUST_WINDOW_MS;
}

export interface PlanRepairActivityOptions {
  /** Injectable clock for the open-round trust window. */
  now?: number;
}

/**
 * The live open round filed against one context, or null. The per-node
 * question: the canvas asks it card by card, where the run-level activity would
 * light every halted node for a repair working exactly one of them.
 */
export function openPlanRepairRoundFor(
  execution: GraphWorkflowExecution,
  contextId: string,
  options: PlanRepairActivityOptions = {},
): PlanRepairRound | null {
  const now = options.now ?? Date.now();
  return (
    execution.planRepairRounds.findLast(
      (round) => round.contextId === contextId && isBelievablyOpen(round, now),
    ) ?? null
  );
}

export function derivePlanRepairActivity(
  execution: GraphWorkflowExecution,
  options: PlanRepairActivityOptions = {},
): PlanRepairActivity {
  const now = options.now ?? Date.now();
  const subject = haltRepairSubject(execution.haltReason);
  // At most one round is ever open — the supervisor holds a per-session
  // in-flight guard — but the log is append-only, so the latest wins.
  const openRound =
    execution.planRepairRounds.findLast((round) =>
      isBelievablyOpen(round, now),
    ) ?? null;
  const rounds = execution.planRepairRounds.filter(
    (round) =>
      round.settledAt === null ||
      (subject !== null && answersSubject(round, subject)),
  );
  return {
    kind: openRound === null ? "stopped" : "working",
    openRound,
    rounds,
  };
}

export interface PlanRepairStatement {
  /** Whether an agent is working on the halt right now. */
  readonly working: boolean;
  /** Chip text — the binary the operator reads first. */
  readonly label: string;
  /** One sentence: who is on it, or that nobody is and it waits on a human. */
  readonly sentence: string;
}

/** How a settled round's outcome reads in a sentence about the halt. */
const OUTCOME_VERB: Record<NonNullable<PlanRepairRound["outcome"]>, string> = {
  repaired: "applied a repair",
  declined: "declined",
  failed: "failed",
  superseded: "was superseded",
};

/** The same outcomes as a bare label, for a round-log row rather than a clause. */
export const PLAN_REPAIR_OUTCOME_LABEL: Record<
  NonNullable<PlanRepairRound["outcome"]>,
  string
> = {
  repaired: "repaired",
  declined: "declined",
  failed: "failed",
  superseded: "superseded",
};

export function planRepairStatement(
  activity: PlanRepairActivity,
  options: { now?: number } = {},
): PlanRepairStatement {
  const relative = (isoDate: string): string =>
    formatRelativeTime(
      isoDate,
      options.now === undefined ? {} : { now: options.now },
    );

  const open = activity.openRound;
  if (open !== null) {
    return {
      working: true,
      label: "repair agent working",
      sentence: `A repair agent is working on "${open.contextId}" — repair round ${
        open.seq
      }, started ${relative(
        open.startedAt,
      )}. The run resumes on its own if the repair lands.`,
    };
  }

  const last = activity.rounds.at(-1);
  if (last === undefined) {
    return {
      working: false,
      label: "no agent working",
      sentence: "No agent is working on this halt — it is waiting on you.",
    };
  }
  // An unsettled round this far past its turn budget lost its agent without
  // writing a verdict. Said plainly: the operator is owed the reason the round
  // log looks unfinished, not left to read it as work still in progress.
  if (last.settledAt === null) {
    return {
      working: false,
      label: "no agent working",
      sentence: `No agent is working on this halt — repair round ${
        last.seq
      } opened ${relative(
        last.startedAt,
      )} and never settled, so its turn is over. It is waiting on you.`,
    };
  }
  return {
    working: false,
    label: "no agent working",
    sentence: `No agent is working on this halt — repair round ${last.seq} ${
      last.outcome === null ? "ended" : OUTCOME_VERB[last.outcome]
    } ${relative(last.settledAt)}. It is waiting on you.`,
  };
}
