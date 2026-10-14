import type { ControlPermits } from "@/lib/control/permits";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { WorkspaceRepo } from "@/lib/state-store/workspace-repo";
import {
  bindingScopesOverlap,
  type Grant,
  type GrantRequest,
  type WorkspaceAdmission,
} from "./admission";
import type { ContentEvidence } from "./evidence";
import { landingMarker, publicationMarker, type LaneGit } from "./lane-git";
import type { LaneIntegrator } from "./lane-integrator";
import {
  laneJobId,
  workspaceOperationSchema,
  type LaneTarget,
  type PublicationWait,
  type WorkspaceBindingRecord,
  type WorkspaceBindingRequest,
  type WorkspaceOperation,
  type WorkspaceOperationRecord,
  type WorkspaceScope,
} from "./schemas";

export type CheckRunResult = {
  status: "passed" | "failed" | "unavailable";
  detail?: string;
};

export interface WorkspaceExecutorDeps {
  transaction<T>(fn: () => T): T;
  repo: WorkspaceRepo;
  permits: ControlPermits;
  admission: WorkspaceAdmission;
  evidence: ContentEvidence;
  /** The Git effects of isolated lanes: provisioning, landing and publication. */
  lanes: LaneGit;
  /** Merges the session head into a lane and gets its publication checks passing there. */
  integrator: LaneIntegrator;
  /** Runs one registered validation command against the binding's worktree. */
  runCheck(input: {
    binding: WorkspaceBindingRequest;
    bindingId: string;
    command: string;
    /** Aborts when the requester interrupts the operation, e.g. on cancel. */
    signal: AbortSignal;
  }): Promise<CheckRunResult>;
  touchRequester(owner: OwnerRef): void;
  now(): string;
  /** Overrides `RETRY_MS`; only tests shorten it. */
  retryMs?: number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Executes Workspace operations: binding admission, content capture,
 * acceptance checks as readers, acceptance (in place for the session, as a
 * marked commit in a lane), and lane provisioning and publication. Operations
 * on one binding or lane run one at a time, each under grants from the shared
 * admission, and only while the requester's permit admits them.
 */
export interface WorkspaceExecutor extends Executor {
  /** Stops an admitted operation's model work; its effects settle before it reports. */
  interrupt(cause: string): void;
  /**
   * What a publication waits for now: running, or queued behind another
   * lane's publication into its session. Null when it is not waiting.
   */
  waitingOn(cause: string): PublicationWait | null;
  releaseBinding(bindingId: string): void;
  /**
   * Boot: an operation interrupted mid-run runs again, except a landing or
   * publication whose marker shows it already moved its branch, which settles
   * with that commit.
   */
  recover(): Promise<void>;
  /** Runs every admissible queued operation; resolves when none is left to start. */
  drain(): Promise<void>;
}

function scopePaths(scope: WorkspaceScope): string[] | undefined {
  return scope.mode === "owned" ? scope.paths : undefined;
}

/** How long publication lets a CC job or a Git lock keep the session before looking again. */
const RETRY_MS = 500;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const STOPPED = {
  kind: "publication_failed",
  detail: "Stopped before publishing",
} as const;
/** A publication whose permit closed while it waited for the session: it goes back to the queue unrun. */
const UNADMITTED = Symbol("unadmitted");

/** Why an operation was refused: the error's message, or what failed when it carried none. */
function refusalDetail(operation: WorkspaceOperation, error: unknown): string {
  return (
    getErrorMessage(error) ||
    `The ${operation.kind} operation failed without a message`
  );
}

/** The grants an operation holds; each is released early when its step ends, and the rest when it settles. */
interface Held {
  grants: Grant[];
}

/** What a running operation waits for, as it stands: a grant wait keeps its request so its holders read current. */
type Wait =
  | { kind: "grants"; request: GrantRequest }
  | Extract<PublicationWait, { kind: "session_lock" | "git_lock" }>;

/** Publication's final step: its outcome, or a Git lock in the session's way. */
type FinalStep<T> = { done: T } | { gitLocked: string };

function sameWait(a: Wait, b: Wait): boolean {
  if (a.kind === "grants" || b.kind === "grants") return a.kind === b.kind;
  if (a.kind === "session_lock" && b.kind === "session_lock")
    return a.job?.jobId === b.job?.jobId;
  return a.kind === "git_lock" && b.kind === "git_lock" && a.lock === b.lock;
}

export function createWorkspaceExecutor(
  deps: WorkspaceExecutorDeps,
): WorkspaceExecutor {
  const runningBindings = new Set<string>();
  /**
   * Session worktrees a publication is running into, with that publication.
   * Publications into one session run one at a time, so each merges the
   * result of the one before instead of finding the head it checked has moved.
   */
  const publishingInto = new Map<string, { cause: string; laneId: string }>();
  const inFlight = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  /** Why each waiting operation waits, by cause, and since when (ms); in memory only. */
  const waits = new Map<
    string,
    { wait: Wait; since: number; laneId: string }
  >();

  /** The holders a wait names: the causes holding conflicting grants, the job, or the lock file. */
  function holdersOf(wait: Wait): string[] {
    switch (wait.kind) {
      case "grants":
        return deps.admission
          .blockers(wait.request)
          .map((grant) => grant.holder);
      case "session_lock":
        return wait.job === null
          ? []
          : [`${wait.job.jobType} job ${wait.job.jobId}`];
      case "git_lock":
        return [wait.lock];
    }
  }

  /** Records what an operation waits for; a new reason ends the wait before it. */
  function waitFor(cause: string, laneId: string, wait: Wait): void {
    const current = waits.get(cause);
    if (current !== undefined && sameWait(current.wait, wait)) {
      current.wait = wait;
      return;
    }
    waitEnded(cause);
    waits.set(cause, { wait, since: Date.now(), laneId });
    deps.log.info("workspace.publication_waiting", {
      cause,
      laneId,
      reason: wait.kind,
      holders: holdersOf(wait),
    });
  }

  function waitEnded(cause: string): void {
    const current = waits.get(cause);
    if (current === undefined) return;
    waits.delete(cause);
    deps.log.info("workspace.publication_wait_ended", {
      cause,
      laneId: current.laneId,
      reason: current.wait.kind,
      durationMs: Date.now() - current.since,
    });
  }

  function settle(record: WorkspaceOperationRecord, outcome: unknown): void {
    deps.transaction(() =>
      deps.repo.updateOperation(record.cause, {
        state: "settled",
        outcome,
        updatedAt: deps.now(),
      }),
    );
    deps.touchRequester(record.requester);
  }

  function bindingOf(bindingId: string): WorkspaceBindingRecord {
    const binding = deps.repo.getBinding(bindingId);
    if (binding === null)
      throw new Error(`Unknown workspace binding ${bindingId}`);
    return binding;
  }

  function bindAdmissible(
    operation: Extract<WorkspaceOperation, { kind: "bind" }>,
  ): boolean {
    const worktree = operation.binding.worktreePath;
    // A bind in progress is still recording its baseline but already holds its
    // place, so a second overlapping bind cannot slip in before it is recorded.
    const binding = deps.repo
      .listBindings(worktree, "waiting")
      .filter((b) => runningBindings.has(b.bindingId));
    const others = [
      ...deps.repo.listBindings(worktree, "bound"),
      ...binding,
    ].filter((b) => b.bindingId !== operation.bindingId);
    return !others.some((other) =>
      bindingScopesOverlap(other.request.scope, operation.binding.scope),
    );
  }

  /**
   * The grant an operation is admitted under; a bind and a provision need
   * none. A publication is admitted holding the lane worktree and takes the
   * session's grant for its final step.
   */
  function grantFor(
    record: WorkspaceOperationRecord,
    operation: WorkspaceOperation,
  ): GrantRequest | null {
    if (operation.kind === "bind" || operation.kind === "provision")
      return null;
    // Admitted holding the lane; it takes the session only for its final step.
    if (operation.kind === "publish")
      return {
        worktree: operation.lane.worktreePath,
        kind: "git",
        holder: record.cause,
      };
    const binding = bindingOf(operation.bindingId).request;
    // Landing moves the lane branch: nothing else may use the lane meanwhile.
    if (operation.kind === "accept" && binding.kind === "lane")
      return {
        worktree: binding.worktreePath,
        kind: "git",
        holder: record.cause,
      };
    // Checks read the whole tree, so they exclude every supervised writer.
    const paths =
      operation.kind === "check" ? undefined : scopePaths(binding.scope);
    return {
      worktree: binding.worktreePath,
      kind: "stable_read",
      ...(paths !== undefined ? { paths } : {}),
      holder: record.cause,
    };
  }

  async function perform(
    record: WorkspaceOperationRecord,
    operation: WorkspaceOperation,
    signal: AbortSignal,
    held: Held,
  ): Promise<unknown> {
    if (operation.kind === "provision") {
      const { lane } = operation;
      const base = await deps.lanes.head(lane.projectPath, lane.sessionBranch);
      const { baseline } = await deps.lanes.provision({
        projectPath: lane.projectPath,
        sessionName: lane.sessionName,
        sessionWorktreePath: lane.sessionWorktreePath,
        laneId: lane.laneId,
        worktreePath: lane.worktreePath,
        branch: lane.branch,
        base,
      });
      return { kind: "provisioned", baseline };
    }
    if (operation.kind === "publish")
      return publish(record, operation.lane, operation.checks, signal, held);
    if (operation.kind === "bind") {
      const baseline = await deps.evidence.capture(
        operation.binding.worktreePath,
        operation.binding.scope,
      );
      deps.transaction(() =>
        deps.repo.setBindingState(operation.bindingId, {
          state: "bound",
          baseline,
          updatedAt: deps.now(),
        }),
      );
      return { kind: "bound" };
    }
    const binding = bindingOf(operation.bindingId).request;
    const capture = () =>
      deps.evidence.capture(binding.worktreePath, binding.scope);
    switch (operation.kind) {
      case "freeze":
        return { kind: "frozen", evidence: await capture() };
      case "verify":
        return {
          kind: "verified",
          changed: !deps.evidence.sameContent(
            await capture(),
            operation.evidence,
          ),
        };
      case "accept": {
        const current = await capture();
        if (!deps.evidence.sameContent(current, operation.evidence))
          return { kind: "candidate_changed" };
        // Session placement accepts in place: the receipt names the exact content.
        if (binding.kind === "session" || binding.scope.mode === "readOnly")
          return { kind: "accepted", receipt: `snapshot:${current}` };
        const landed = await deps.lanes.land({
          worktreePath: binding.worktreePath,
          paths: binding.scope.mode === "owned" ? binding.scope.paths : null,
          message: `Accept ${record.requester.id}\n\n${landingMarker(record.cause)}`,
        });
        return {
          kind: "accepted",
          receipt:
            landed.kind === "committed"
              ? `commit:${landed.commit}`
              : `unchanged:${landed.head}`,
        };
      }
      case "check": {
        const before = await capture();
        const result = await deps.runCheck({
          binding,
          bindingId: operation.bindingId,
          command: operation.command,
          signal,
        });
        const after = await capture();
        const wrote = deps.evidence.sameContent(before, after)
          ? []
          : await deps.evidence.changedPaths(
              binding.worktreePath,
              binding.scope,
              before,
              after,
            );
        return {
          kind: "checked",
          status: result.status,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
          wroteReviewedScope: wrote,
        };
      }
    }
  }

  /**
   * Takes another grant during an operation; it is released with the rest.
   * Null once the operation is stopped: before, while, or as soon as it is granted.
   */
  async function take(
    request: GrantRequest,
    signal: AbortSignal,
    held: Held,
  ): Promise<Grant | null> {
    const grant = await deps.admission
      .acquire(request, signal)
      .catch(() => null);
    if (grant === null) return null;
    if (signal.aborted) {
      deps.admission.release(grant);
      return null;
    }
    held.grants.push(grant);
    return grant;
  }

  function letGo(grant: Grant, held: Held): void {
    const index = held.grants.indexOf(grant);
    if (index < 0) return;
    held.grants.splice(index, 1);
    deps.admission.release(grant);
  }

  /**
   * Design §6.5, amended 2026-10-14 §2.2. Admitted holding the lane: read the
   * session head (a ref read touches no worktree, so it takes no grant),
   * integrate it into the lane with the session free, then take the session
   * and the session's Git lock together, never waiting for one while holding
   * the other, for the final checks and the publication, which the lane Git
   * port makes as one step.
   */
  async function publish(
    record: WorkspaceOperationRecord,
    lane: LaneTarget,
    checks: readonly string[],
    signal: AbortSignal,
    held: Held,
  ): Promise<unknown> {
    // An interrupted attempt's merge and a person's unfinished resolution look
    // alike, and only the person's must not be discarded: neither is guessed at.
    if (await deps.lanes.mergeInProgress(lane.worktreePath))
      return {
        kind: "publication_failed",
        detail: `The lane has a merge in progress in ${lane.worktreePath}. Finish and commit it, or abort it (git merge --abort), then ask for a new attempt.`,
      };
    const stray = await deps.lanes.unlandedPaths(lane.worktreePath);
    if (stray.length > 0)
      return {
        kind: "publication_failed",
        detail: `The lane holds changes no context landed: ${stray.join(", ")}. Commit or remove them in ${lane.worktreePath}, then ask for a new attempt.`,
      };
    // A stop, pause or fault that landed while it inspected the lane stops it
    // here, before it reads or moves anything.
    if (signal.aborted) return STOPPED;
    if (!stillAdmitted(record)) return UNADMITTED;
    const head = await deps.lanes.head(lane.projectPath, lane.sessionBranch);
    // Kept with the running operation, so a restart can name what a found publication incorporated.
    deps.transaction(() =>
      deps.repo.updateOperation(record.cause, {
        outcome: { incorporated: head },
        updatedAt: deps.now(),
      }),
    );
    const integrated = await deps.integrator.integrate({
      lane,
      head,
      checks,
      cause: record.cause,
      signal,
    });
    if (integrated.kind === "failed")
      return { kind: "publication_failed", detail: integrated.detail };

    const final = await underSession(
      lane,
      record.cause,
      signal,
      held,
      async (): Promise<FinalStep<unknown>> => {
        // Each wait for the session is an admission point: a pause or fault
        // that landed while it waited stops it here, before it moves anything.
        if (!stillAdmitted(record)) return { done: UNADMITTED };
        const published = await deps.lanes.publish({
          projectPath: lane.projectPath,
          sessionName: lane.sessionName,
          laneBranch: lane.branch,
          targetBranch: lane.sessionBranch,
          targetWorktreePath: lane.sessionWorktreePath,
          expectedHead: head,
          message: `Publish lane ${lane.laneId}\n\n${publicationMarker(record.cause)}`,
          jobId: laneJobId(record.cause),
        });
        switch (published.kind) {
          case "published":
            return {
              done: {
                kind: "published",
                commit: published.commit,
                incorporated: head,
              },
            };
          case "unchanged":
            return {
              done: { kind: "published", commit: head, incorporated: head },
            };
          case "stale":
            return {
              done: { kind: "publication_stale", head: published.head },
            };
          case "blocked":
            return {
              done: { kind: "publish_blocked", detail: published.detail },
            };
          case "failed":
            return {
              done: { kind: "publication_failed", detail: published.detail },
            };
          case "git_locked":
            return { gitLocked: published.lock };
        }
      },
    );
    return final ?? STOPPED;
  }

  /**
   * Runs `step` holding the session worktree's Git grant and the session's Git
   * lock together, never waiting for one while holding the other. When the
   * step finds a Git lock in its way, it watches that lock file, holding
   * nothing and running no Git, and runs the step again once the file is gone.
   * Records what it waits for. Null when stopped before the step could finish.
   */
  async function underSession<T>(
    lane: LaneTarget,
    holder: string,
    signal: AbortSignal,
    held: Held,
    step: () => Promise<FinalStep<T>>,
  ): Promise<T | null> {
    const retryMs = deps.retryMs ?? RETRY_MS;
    try {
      for (;;) {
        const request: GrantRequest = {
          worktree: lane.sessionWorktreePath,
          kind: "git",
          holder,
        };
        if (deps.admission.blockers(request).length > 0)
          waitFor(holder, lane.laneId, { kind: "grants", request });
        const session = await take(request, signal, held);
        if (session === null) return null;
        const lock = deps.lanes.trySessionLock(
          lane.projectPath,
          lane.sessionName,
        );
        if (lock.kind === "busy") {
          // A CC job holds the session: let its turns use the worktree meanwhile.
          letGo(session, held);
          waitFor(holder, lane.laneId, { kind: "session_lock", job: lock.job });
          await pause(retryMs, signal);
          if (signal.aborted) return null;
          continue;
        }
        waitEnded(holder);
        let result: FinalStep<T>;
        try {
          result = await step();
        } finally {
          lock.release();
          letGo(session, held);
        }
        if ("done" in result) return result.done;
        waitFor(holder, lane.laneId, {
          kind: "git_lock",
          lock: result.gitLocked,
        });
        while (deps.lanes.lockHeld(result.gitLocked)) {
          await pause(retryMs, signal);
          if (signal.aborted) return null;
        }
        waitEnded(holder);
      }
    } finally {
      waitEnded(holder);
    }
  }

  /** After the receipt is stored: a published lane's worktree and branch go, best effort. */
  async function cleanUp(
    operation: WorkspaceOperation,
    outcome: unknown,
  ): Promise<void> {
    if (operation.kind !== "publish") return;
    const published =
      typeof outcome === "object" &&
      outcome !== null &&
      "kind" in outcome &&
      outcome.kind === "published" &&
      "commit" in outcome &&
      typeof outcome.commit === "string"
        ? outcome.commit
        : null;
    if (published === null) return;
    try {
      const removal = await deps.lanes.remove({
        projectPath: operation.lane.projectPath,
        worktreePath: operation.lane.worktreePath,
        branch: operation.lane.branch,
        published,
      });
      if (removal.kind === "kept")
        deps.log.warn("workspace.lane_kept", {
          laneId: operation.lane.laneId,
          worktreePath: operation.lane.worktreePath,
          detail: removal.detail,
        });
    } catch (error) {
      deps.log.warn("workspace.lane_cleanup_failed", {
        laneId: operation.lane.laneId,
        worktreePath: operation.lane.worktreePath,
        error: getErrorMessage(error),
      });
    }
  }

  /** A running operation's permit still admits it, at a later admission point such as publication's session grant. */
  function stillAdmitted(record: WorkspaceOperationRecord): boolean {
    const current = deps.repo.getOperation(record.cause);
    return current !== null && deps.permits.admits(current.permit);
  }

  /**
   * Admits the operation: under its permit as stored now (a resubmission
   * refreshes it), and only while it is still queued. Returns false, leaving
   * it queued, when the permit no longer admits it.
   */
  function admit(record: WorkspaceOperationRecord): boolean {
    return deps.transaction(() => {
      const current = deps.repo.getOperation(record.cause);
      if (current?.state !== "queued" || !deps.permits.admits(current.permit))
        return false;
      deps.repo.updateOperation(record.cause, {
        state: "running",
        updatedAt: deps.now(),
      });
      return true;
    });
  }

  /**
   * Waits for the operation's grant, then admits it: an operation is admitted
   * only once it holds what it runs under, so a pause or cancel that lands
   * during the wait leaves it queued and unrun. Admitted work drains.
   */
  async function execute(
    record: WorkspaceOperationRecord,
    operation: WorkspaceOperation,
  ): Promise<void> {
    const controller = new AbortController();
    controllers.set(record.cause, controller);
    const held: Held = { grants: [] };
    let requeued = false;
    try {
      let request: GrantRequest | null;
      try {
        request = grantFor(record, operation);
      } catch (error) {
        // Nothing it could run under: refused once, rather than failing again on every drain.
        deps.log.error("workspace.operation_failed", {
          cause: record.cause,
          kind: operation.kind,
          error: getErrorMessage(error),
        });
        settle(record, {
          kind: "refused",
          detail: refusalDetail(operation, error),
        });
        return;
      }
      if (request !== null) {
        try {
          held.grants.push(
            await deps.admission.acquire(request, controller.signal),
          );
        } catch {
          return;
        }
      }
      if (!admit(record)) return;
      let outcome: unknown;
      try {
        outcome = await perform(record, operation, controller.signal, held);
        if (outcome === UNADMITTED) {
          // What it did so far is safe to repeat: nothing reached the session.
          deps.transaction(() =>
            deps.repo.updateOperation(record.cause, {
              state: "queued",
              outcome: null,
              updatedAt: deps.now(),
            }),
          );
          requeued = true;
          return;
        }
      } catch (error) {
        deps.log.error("workspace.operation_failed", {
          cause: record.cause,
          kind: operation.kind,
          error: getErrorMessage(error),
        });
        outcome = { kind: "refused", detail: refusalDetail(operation, error) };
      }
      for (const grant of held.grants.splice(0)) deps.admission.release(grant);
      try {
        settle(record, outcome);
      } catch (error) {
        // The work is done but unrecorded: it stays running, and the next
        // start's recovery settles it from its marker or runs it again.
        deps.log.error("workspace.settle_failed", {
          cause: record.cause,
          kind: operation.kind,
          error: getErrorMessage(error),
        });
        return;
      }
      await cleanUp(operation, outcome);
    } finally {
      for (const grant of held.grants) deps.admission.release(grant);
      controllers.delete(record.cause);
      runningBindings.delete(record.bindingId);
      if (operation.kind === "publish")
        publishingInto.delete(operation.lane.sessionWorktreePath);
      // Its requester resubmits it under a permit that admits, or sees it drained, withdrawn or cancelled.
      if (requeued) deps.touchRequester(record.requester);
    }
  }

  /** Starts one queued operation whose permit, binding and scope allow it now. */
  function tryStart(record: WorkspaceOperationRecord): boolean {
    if (runningBindings.has(record.bindingId)) return false;
    if (!deps.permits.admits(record.permit)) return false;
    const operation = workspaceOperationSchema.parse(record.request);
    if (operation.kind === "bind" && !bindAdmissible(operation)) return false;
    if (operation.kind === "publish") {
      if (publishingInto.has(operation.lane.sessionWorktreePath)) return false;
      publishingInto.set(operation.lane.sessionWorktreePath, {
        cause: record.cause,
        laneId: operation.lane.laneId,
      });
    }
    runningBindings.add(record.bindingId);
    const run = execute(record, operation).finally(() => inFlight.delete(run));
    inFlight.add(run);
    return true;
  }

  /**
   * The settled outcome of an interrupted landing or publication whose marked
   * commit is on its branch; null when it must run again. Only the marker
   * counts: a matching tree is not proof of the effect.
   */
  async function alreadyDone(
    record: WorkspaceOperationRecord,
  ): Promise<unknown> {
    const operation = workspaceOperationSchema.parse(record.request);
    if (operation.kind === "publish") {
      const { lane } = operation;
      const commit = await deps.lanes.findMarked({
        projectPath: lane.projectPath,
        branch: lane.sessionBranch,
        marker: publicationMarker(record.cause),
      });
      if (commit === null) return null;
      const progress = record.outcome;
      const incorporated =
        typeof progress === "object" &&
        progress !== null &&
        "incorporated" in progress &&
        typeof progress.incorporated === "string"
          ? progress.incorporated
          : null;
      // Git moves the branch only after writing the index and files: the marker on it means done.
      if (incorporated === null)
        return {
          kind: "publication_uncertain",
          detail: `Branch ${lane.sessionBranch} holds the publication ${commit}, but which session head it was checked against was not recorded. Check what ${commit} brought into the session, then ask for a new attempt if the lane still needs publishing.`,
        };
      return { kind: "published", commit, incorporated };
    }
    if (operation.kind !== "accept") return null;
    const binding = deps.repo.getBinding(operation.bindingId)?.request;
    if (binding?.kind !== "lane") return null;
    const commit = await deps.lanes.findMarked({
      projectPath: binding.projectPath,
      branch: binding.branch,
      marker: landingMarker(record.cause),
    });
    if (commit === null) return null;
    // A landing interrupted after moving the branch may not have resynced the lane's index.
    await deps.lanes.resyncIndex({
      worktreePath: binding.worktreePath,
      paths: binding.scope.mode === "owned" ? binding.scope.paths : null,
    });
    return { kind: "accepted", receipt: `commit:${commit}` };
  }

  const executor: WorkspaceExecutor = {
    submit(intent: PendingIntent) {
      const operation = workspaceOperationSchema.parse(intent.request);
      deps.transaction(() => {
        const existing = deps.repo.getOperation(intent.cause);
        if (existing !== null) {
          // A resubmission refreshes the permit of an operation not yet admitted.
          if (existing.state === "queued") {
            deps.repo.updateOperation(intent.cause, {
              permit: intent.permit,
              updatedAt: deps.now(),
            });
          }
          return;
        }
        if (operation.kind === "bind") {
          deps.repo.insertBindingIfAbsent({
            bindingId: operation.bindingId,
            request: operation.binding,
            state: "waiting",
            baseline: null,
            createdAt: deps.now(),
            updatedAt: deps.now(),
          });
        }
        deps.repo.insertOperationIfAbsent({
          cause: intent.cause,
          bindingId: operation.bindingId,
          requester: intent.requester,
          request: intent.request,
          permit: intent.permit,
          state: "queued",
          outcome: null,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        });
      });
      void executor.drain();
    },
    outcome(cause): OperationState {
      const record = deps.repo.getOperation(cause);
      if (record === null) return { kind: "unknown" };
      switch (record.state) {
        case "queued":
          return { kind: "queued" };
        case "running":
          return { kind: "running" };
        case "settled":
          return { kind: "settled", outcome: record.outcome };
        case "uncertain":
          return {
            kind: "uncertain",
            evidence: JSON.stringify(record.outcome),
          };
      }
    },
    withdraw(cause) {
      const withdrawn = deps.transaction(() => {
        const record = deps.repo.getOperation(cause);
        if (record?.state !== "queued") return false;
        deps.repo.deleteOperation(cause);
        return true;
      });
      // One still waiting for its grant stops waiting.
      if (withdrawn) controllers.get(cause)?.abort();
    },
    interrupt(cause) {
      controllers.get(cause)?.abort();
    },
    waitingOn(cause) {
      const current = waits.get(cause);
      if (current !== undefined) {
        if (current.wait.kind !== "grants") return current.wait;
        const holders = holdersOf(current.wait);
        return holders.length === 0 ? null : { kind: "grants", holders };
      }
      // A queued publication whose session another lane's publication holds.
      const record = deps.repo.getOperation(cause);
      if (record?.state !== "queued") return null;
      const operation = workspaceOperationSchema.safeParse(record.request);
      if (!operation.success || operation.data.kind !== "publish") return null;
      const publishing = publishingInto.get(
        operation.data.lane.sessionWorktreePath,
      );
      return publishing === undefined || publishing.cause === cause
        ? null
        : { kind: "publication", laneId: publishing.laneId };
    },
    releaseBinding(bindingId) {
      deps.transaction(() => {
        const binding = deps.repo.getBinding(bindingId);
        if (binding === null || binding.state === "released") return;
        deps.repo.setBindingState(bindingId, {
          state: "released",
          baseline: binding.baseline,
          updatedAt: deps.now(),
        });
      });
      // Start waiting bindings only after a caller's enclosing transaction commits.
      setImmediate(() => void executor.drain());
    },
    async recover() {
      for (const record of deps.repo.listOperations("running")) {
        let found: unknown = null;
        try {
          found = await alreadyDone(record);
        } catch (error) {
          // The branch cannot be read: whether the effect happened stays open for the owner.
          deps.transaction(() =>
            deps.repo.updateOperation(record.cause, {
              state: "uncertain",
              outcome: { detail: getErrorMessage(error) },
              updatedAt: deps.now(),
            }),
          );
          deps.touchRequester(record.requester);
          continue;
        }
        if (found !== null) {
          settle(record, found);
          await cleanUp(workspaceOperationSchema.parse(record.request), found);
          continue;
        }
        deps.transaction(() =>
          deps.repo.updateOperation(record.cause, {
            state: "queued",
            outcome: null,
            updatedAt: deps.now(),
          }),
        );
      }
    },
    async drain() {
      for (;;) {
        for (const record of deps.repo.listOperations("queued"))
          tryStart(record);
        if (inFlight.size === 0) return;
        // Whatever finishes may free what a queued operation waits for: look again.
        await Promise.race(inFlight);
      }
    },
  };
  return executor;
}
