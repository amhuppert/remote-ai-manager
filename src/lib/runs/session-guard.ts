import type { RunsRepo } from "@/lib/state-store/runs-repo";
import type { RunProgress } from "./schemas";

/** A run that has not finished: running, waiting on its owner, paused or stopping. */
export interface CurrentRun {
  runId: string;
  /** The session the run works in. */
  sessionName: string;
  progress: RunProgress["kind"];
}

/**
 * The runs working in a project, or in one of its sessions, that have not
 * finished, read from their stored progress: so it answers before supervision
 * is composed, and for runs a restart left paused.
 */
export function currentRunsIn(
  runs: Pick<RunsRepo, "listActive">,
  projectPath: string,
  sessionName?: string,
): CurrentRun[] {
  return runs
    .listActive()
    .filter(
      (run) =>
        run.projectPath === projectPath &&
        (sessionName === undefined || run.sessionName === sessionName),
    )
    .map((run) => ({
      runId: run.runId,
      sessionName: run.sessionName,
      progress: run.progress.kind,
    }));
}

/** What a current run blocks: a session's merge or deletion, or its project's deletion. */
export type RunGuardedAct =
  | "merging this session"
  | "marking this session merged"
  | "deleting this session"
  | "deleting this project";

export interface CurrentRunRefusal {
  code: "RUN_CURRENT";
  runId: string;
  progress: RunProgress["kind"];
  message: string;
}

const PROGRESS_TEXT: Record<RunProgress["kind"], string> = {
  running: "running",
  needs_owner: "waiting on its owner",
  paused: "paused",
  stopping: "stopping",
  succeeded: "finished",
  cancelled: "cancelled",
};

const CANCEL = "or cancel it from its run page and wait until it has stopped,";
const REMEDY: Record<RunProgress["kind"], string> = {
  running: `Let it finish, ${CANCEL}`,
  needs_owner: `Give it what it is waiting for, ${CANCEL}`,
  paused: `Resume it and let it finish, ${CANCEL}`,
  stopping: "Wait until it has stopped",
  succeeded: "",
  cancelled: "",
};

/**
 * A run works in its session until it has finished, so the session cannot be
 * merged (finished) or deleted under it: the run's work would land nowhere and
 * the run would be left current with no session to steer it from.
 */
export function currentRunRefusal(
  runs: readonly CurrentRun[],
  act: RunGuardedAct,
): CurrentRunRefusal | null {
  const run = runs[0];
  if (run === undefined) return null;
  const others =
    runs.length > 1
      ? ` (and ${runs.length - 1} other run${runs.length > 2 ? "s" : ""})`
      : "";
  const remedy = REMEDY[run.progress];
  return {
    code: "RUN_CURRENT",
    runId: run.runId,
    progress: run.progress,
    message: `Run ${run.runId} is ${PROGRESS_TEXT[run.progress]} in session "${run.sessionName}"${others}. ${remedy} before ${act}.`,
  };
}

/** A refused session or project act, for callers that report refusals as errors. */
export class CurrentRunError extends Error {
  readonly code = "RUN_CURRENT" as const;
  readonly statusCode = 409;
  /** The run that blocks the act, as every surface reports it beside the sentence. */
  readonly details: { runId: string; progress: RunProgress["kind"] };

  constructor(refusal: CurrentRunRefusal) {
    super(refusal.message);
    this.name = "CurrentRunError";
    this.details = { runId: refusal.runId, progress: refusal.progress };
  }
}

/** Throws when a run has not finished; the caller's act would strand it. */
export function assertNoCurrentRun(
  runs: readonly CurrentRun[],
  act: RunGuardedAct,
): void {
  const refusal = currentRunRefusal(runs, act);
  if (refusal !== null) throw new CurrentRunError(refusal);
}

export interface ClosedSessionRefusal {
  code: "session_deleted" | "session_finalizing" | "session_finished";
  message: string;
  hint: string;
}

/**
 * The other half of the merge's refusal: a session that is gone, being
 * delivered by a merge, or finished takes no new run. Every launch entry asks
 * it last, under the session's lifecycle, immediately before the run is
 * recorded.
 */
export function closedSessionRefusal(input: {
  session: { finished: boolean } | null;
  finalizingMerge: { jobId: string } | null;
}): ClosedSessionRefusal | null {
  if (input.session === null)
    return {
      code: "session_deleted",
      message: "This session was deleted, so it takes no new run",
      hint: "Launch the run from a conversation in another session.",
    };
  if (input.finalizingMerge !== null)
    return {
      code: "session_finalizing",
      message: `A merge (job ${input.finalizingMerge.jobId}) is delivering this session's branch, so it takes no new run`,
      hint: "Wait for the merge to finish; a session it marks merged takes no new run.",
    };
  if (input.session.finished)
    return {
      code: "session_finished",
      message: "This session is finished, so it takes no new run",
      hint: "Launch the run from a conversation in an unfinished session.",
    };
  return null;
}
