import type { StatusChipTone } from "@/components/ui/StatusChip";
import type {
  ContextHaltKind,
  ContextState,
  ContextStep,
  LaneState,
  Remedy,
  RunHaltKind,
  RunLoop,
  RunStatus,
} from "./model";

/**
 * How the run page names engine states: one label, one tone and, where a
 * person acts, one sentence on what the action does. Every surface reads
 * these, so a state reads the same in the list, the diagram and the inspector.
 */

export interface Presented {
  label: string;
  tone: StatusChipTone;
}

export function runStatus(status: RunStatus): Presented {
  switch (status.kind) {
    case "running":
      return { label: "Running", tone: "cyan" };
    case "needs_input":
      return { label: "Needs input", tone: "amber" };
    case "paused":
      return { label: status.draining ? "Pausing" : "Paused", tone: "neutral" };
    case "stopping":
      return { label: "Stopping", tone: "neutral" };
    case "succeeded":
      return { label: "Succeeded", tone: "green" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
  }
}

export function stepLabel(step: ContextStep): string {
  switch (step.kind) {
    case "workspace":
      return "Preparing workspace";
    case "work":
      return {
        initial: "Working",
        retry: "Working · tasks left open",
        steer: "Working · owner instruction",
        remediate: "Fixing review findings",
        rework: "Reworking · approval declined",
        continue: "Working · question answered",
      }[step.reason];
    case "output":
      return "Reporting result";
    case "review":
      return `Reviewing · round ${step.round} · ${step.reviewersDone} of ${step.reviewersTotal}`;
    case "advice":
      return "Answering review advice";
    case "verify":
      return "Running checks";
    case "accept":
      return "Accepting result";
  }
}

/** A step by name alone, where its detail would crowd the line. */
function stepName(step: ContextStep): string {
  return {
    workspace: "workspace",
    work: "work",
    output: "result",
    review: "review",
    advice: "advice",
    verify: "checks",
    accept: "accept",
  }[step.kind];
}

/** A context's state as one short line, for rows and diagram nodes. */
export function contextState(state: ContextState): Presented {
  switch (state.kind) {
    case "waiting": {
      const blockers = [
        ...state.dependencies,
        ...state.provisionLanes.map(lane => `lane ${lane} setup`),
        ...state.publicationLanes.map(lane => `lane ${lane} publication`),
      ];
      return { label: blockers.length > 0 ? `Waits on ${blockers.join(", ")}` : "Ready to start", tone: "neutral" };
    }
    case "skipped":
      return { label: "Skipped", tone: "neutral" };
    case "running":
      return { label: stepLabel(state.step), tone: "cyan" };
    case "awaiting_answer":
      return { label: "Question for the owner", tone: "amber" };
    case "awaiting_approval":
      return { label: "Awaiting your approval", tone: "amber" };
    case "halted":
      return { label: haltTitle(state.halt.kind), tone: "red" };
    case "paused":
      return {
        label: state.draining
          ? "Pausing · finishing its turn"
          : state.next === null
            ? "Paused"
            : `Paused · next: ${stepName(state.next)}`,
        tone: "neutral",
      };
    case "stopping":
      return { label: "Stopping", tone: "neutral" };
    case "succeeded":
      return { label: "Done", tone: "green" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
  }
}

export function haltTitle(kind: ContextHaltKind): string {
  return {
    retries_exhausted: "Out of retries",
    output_invalid: "Result doesn't fit its schema",
    candidate_unstable: "Files changed during review",
    plan_defect: "Contract can't be met",
    advice_invalid: "Advice response unreadable",
    unavailable: "Backend unavailable",
    turn_failed: "Turn failed",
    interrupted: "Turn interrupted",
    effect_uncertain: "Unsure a step finished",
    reconcile_failed: "Couldn't recover after restart",
    workspace_refused: "Workspace refused a step",
  }[kind];
}

/** Why the halt stops the work, in one sentence. */
export function haltExplanation(kind: ContextHaltKind): string {
  return {
    retries_exhausted: "The context used every retry its policy allows and stopped instead of trying again.",
    output_invalid: "The implementer's structured result failed validation, so nothing downstream can consume it yet.",
    candidate_unstable: "Files in the reviewed scope kept changing while reviewers read them, so the review would not hold.",
    plan_defect: "A blocking reviewer judged that the contract itself cannot be met as written.",
    advice_invalid: "The implementer's answer to review advice could not be read.",
    unavailable: "The agent's backend refused the turn before it started.",
    turn_failed: "The agent's turn ended with an error before it finished its work.",
    interrupted: "The agent's turn stopped before it finished, usually a restart or a cancelled process.",
    effect_uncertain: "A step that changes files or Git may or may not have completed; running it blindly could repeat it.",
    reconcile_failed: "After a restart the engine could not match a recorded step with its outcome.",
    workspace_refused: "The workspace refused a step, for example because its files were held by other work.",
  }[kind];
}

export interface PresentedRemedy {
  label: string;
  consequence: string;
  /** The remedy asks for a reason or evidence before it applies. */
  needsNote: "reason" | "evidence" | null;
  emphasis: "primary" | "default";
}

export function remedy(r: Remedy, haltKind: ContextHaltKind, seat = "implementer"): PresentedRemedy {
  switch (r.kind) {
    case "continue":
      if (haltKind === "effect_uncertain") return {
        label: "Try again without evidence",
        consequence: "May repeat a change that already landed. Inspect files and Git before another attempt.",
        needsNote: null, emphasis: "default",
      };
      if (haltKind === "candidate_unstable") return {
        label: "Review again once files settle",
        consequence: "Resets the instability limit, freezes a new candidate and reviews it again.",
        needsNote: null, emphasis: "default",
      };
      if (haltKind === "workspace_refused" || haltKind === "reconcile_failed") return {
        label: "Ask again", consequence: "Asks the engine to reconcile the stopped step and try to continue.",
        needsNote: null, emphasis: "primary",
      };
      return {
        label: "Retry",
        consequence: "Runs the stopped step again with the same agent and its conversation.",
        needsNote: null,
        emphasis: "primary",
      };
    case "retry":
      return {
        label: "Retry",
        consequence: "Asks the backend again; nothing else changes.",
        needsNote: null,
        emphasis: "primary",
      };
    case "replace_seat":
      return {
        label: `Replace ${seat}`,
        consequence: `Retires the ${seat} conversation and starts a new one that reads the work order from the start.`,
        needsNote: null,
        emphasis: "default",
      };
    case "retry_capture":
      return {
        label: "Ask for the result again",
        consequence: "The implementer reports its result again; its work is kept.",
        needsNote: null,
        emphasis: "primary",
      };
    case "retry_advice":
      return {
        label: "Ask again",
        consequence: "The implementer answers the review advice again.",
        needsNote: null,
        emphasis: "primary",
      };
    case "rereview":
      return {
        label: "Review again",
        consequence: "Retires this review round and starts a new one; your reason goes to the reviewers.",
        needsNote: "reason",
        emphasis: "default",
      };
    case "confirm_effect":
      return {
        label: "Authorize another attempt",
        consequence: "Records your evidence and authorizes another attempt. Inspect the work first: the earlier attempt may already have changed files or Git.",
        needsNote: "evidence",
        emphasis: "default",
      };
    case "grant":
      return {
        label: `Allow more ${r.allowance === "validationRetries" ? "review" : "task"} retries`,
        consequence: `Used ${r.used} of ${r.limit}. Granting more lets the context try again; your reason is kept with the run.`,
        needsNote: "reason",
        emphasis: "primary",
      };
  }
}

export function runHaltTitle(kind: RunHaltKind): string {
  return {
    route_unevaluable: "Route can't be decided",
    route_cardinality: "Wrong number of routes taken",
    loop_exhausted: "Loop used every pass",
    loop_unevaluable: "Loop exit can't be read",
    lane_provision: "Lane couldn't be set up",
    lane_publication: "Lane couldn't publish",
    reconcile_failed: "Run needs recovery",
  }[kind];
}

export function laneState(state: LaneState): Presented {
  const presented: Record<LaneState, Presented> = {
    waiting: { label: "Waiting", tone: "neutral" },
    skipped: { label: "Skipped", tone: "neutral" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    provisioning: { label: "Setting up", tone: "cyan" },
    provision_failed: { label: "Setup failed", tone: "red" },
    working: { label: "Working", tone: "cyan" },
    publishing: { label: "Publishing", tone: "cyan" },
    published: { label: "Published", tone: "green" },
    blocked: { label: "Blocked", tone: "amber" },
    stale: { label: "Session moved", tone: "amber" },
    failed: { label: "Publish failed", tone: "red" },
    uncertain: { label: "Uncertain", tone: "amber" },
  };
  return presented[state];
}

export function loopState(loop: RunLoop): Presented {
  const presented: Record<RunLoop["state"], Presented> = {
    unstarted: { label: "Not started", tone: "neutral" },
    skipped: { label: "Skipped", tone: "neutral" },
    running: { label: `Pass ${loop.pass} of ${loop.maxPasses}`, tone: "cyan" },
    next: { label: `Pass ${loop.pass + 1} next`, tone: "cyan" },
    succeeded: { label: `Done after ${loop.pass}`, tone: "green" },
    exhausted: { label: "Out of passes", tone: "red" },
    unevaluable: { label: "Exit unreadable", tone: "red" },
  };
  return presented[loop.state];
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return value < 10 ? `$${value.toFixed(2)}` : `$${value.toFixed(1)}`;
}

/** Whole seconds and minutes, as `1m 12s` or `48s`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Middle-truncated id, as the design system writes ids. */
export function shortId(id: string, keep = 6): string {
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

/** Whether the context is finished one way or another. */
export function isSettled(state: ContextState): boolean {
  return state.kind === "succeeded" || state.kind === "cancelled" || state.kind === "skipped";
}
