import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { buildChildEnv } from "@/lib/shared/child-env";
import { validatePathArgs, type PathArgsViolationKind } from "./path-args";
import type { ValidationScope } from "./schemas";

const logger = createLogger("validation");

/**
 * Detached process-group runner for registered validation commands (design:
 * validation-concurrency §2, §4).
 *
 * The script path is resolved from the canonical project root while the
 * caller worktree is only `cwd` — a candidate branch cannot validate itself
 * with a script it modified. The group is spawned detached so it leads its
 * own process group, which is what lets timeout/cancel kill the whole tree
 * (vitest forks one worker per configured slot) and lets `wait()` promise
 * that the group is confirmed dead before capacity is released.
 *
 * The group leader is the per-run supervisor (design §4: "a per-run
 * supervisor/nonce, not a bare PID"): a fixed executable script invoked with
 * an argv array — never a shell -c string — that carries the nonce marker in
 * its ps-visible argv and exec's the registered command with its arguments
 * passed through verbatim. macOS forbids reading another process's
 * environment even same-user, so argv is the only durable identity channel
 * crash recovery can read back.
 */

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
// After SIGKILL the kernel guarantees group death; a group still alive past
// this cap (EPERM'd member, kernel-stuck state) makes killProcessGroup THROW
// rather than return, because callers release capacity on its resolution.
const DEFAULT_MAX_GROUP_DEATH_WAIT_MS = 30_000;

export interface SpawnValidationParams {
  runId: string;
  /** Per-run process identity, exported to the child env for crash recovery. */
  nonce: string;
  /** Registered command name (env correlation), not the script path. */
  commandName: string;
  /** Script path from the registry, resolved against the project root. */
  command: string;
  cost: number;
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  targetBranch?: string;
  /** Lane-worktree context id; omitted for session/project targets. */
  contextId?: string;
  requestedScope: ValidationScope;
  effectiveScope: ValidationScope;
  pathArgs: "forbid" | "paths";
  scopePaths: string[];
  /** Measured from spawn — queue time never consumes it. */
  timeoutMs: number;
  killGraceMs?: number;
  pollMs?: number;
  maxOutputBytes?: number;
}

export type ValidationRunOutcome =
  | { kind: "exited"; exitCode: number | null; output: string }
  | { kind: "timed_out"; timeoutMs: number; output: string }
  | { kind: "cancelled"; output: string };

export interface ValidationProcessHandle {
  processGroupPid: number;
  /**
   * Release the start barrier: the supervisor holds the workload unstarted
   * until this is called, so the caller can persist pid + nonce ownership to
   * the ledger first. If the server dies before confirming, the supervisor
   * sees EOF on the closed pipe and exits without ever running the workload —
   * a detached group can never outrun its durable identity. Idempotent.
   */
  confirmStart(): void;
  /** Resolves only after the whole process group is confirmed dead. */
  wait(): Promise<ValidationRunOutcome>;
  /**
   * Group-kill the run and resolve its outcome. When the child already
   * exited naturally, returns that settled outcome instead of `cancelled`.
   */
  cancel(): Promise<ValidationRunOutcome>;
}

export type SpawnValidationResult =
  | { kind: "spawned"; handle: ValidationProcessHandle }
  | { kind: "path_args_require_changed"; tokens: string[] }
  | { kind: "path_args_forbidden"; tokens: string[] }
  | {
      kind: "path_args_rejected";
      violation: PathArgsViolationKind;
      token: string;
    }
  | { kind: "script_not_found"; scriptPath: string }
  | { kind: "spawn_error"; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: group already gone — the goal state. Any other failure (EPERM)
    // leaves the group alive, which the probe loop observes and killProcess-
    // Group ultimately reports by throwing rather than swallowing.
  }
}

export function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM means a member exists but is no longer signalable by us.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process group that outlived SIGKILL plus the confirmation window. */
export class ProcessGroupUndeadError extends Error {
  readonly pgid: number;
  constructor(pgid: number, waitedMs: number) {
    super(
      `process group ${pgid} is still alive ${waitedMs}ms after SIGKILL; ` +
        "capacity must not be released while any member survives",
    );
    this.name = "ProcessGroupUndeadError";
    this.pgid = pgid;
  }
}

/**
 * SIGTERM-then-SIGKILL the process group and resolve only once every member
 * is confirmed dead (kill(-pgid, 0) probe loop). Shared by the runner's
 * timeout/cancel paths and crash recovery. NEVER resolves with a live group:
 * if members survive SIGKILL past the confirmation window it throws
 * ProcessGroupUndeadError so no caller can release capacity on a lie.
 */
export async function killProcessGroup(
  pgid: number,
  opts: {
    killGraceMs?: number;
    pollMs?: number;
    maxGroupDeathWaitMs?: number;
    onEscalate?(): void;
    /** OS-probe seam for tests; production always uses kill(-pgid, 0). */
    probe?(pgid: number): boolean;
  } = {},
): Promise<void> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxGroupDeathWaitMs ?? DEFAULT_MAX_GROUP_DEATH_WAIT_MS;
  const alive = opts.probe ?? isProcessGroupAlive;
  if (!alive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  const termDeadline = Date.now() + killGraceMs;
  while (alive(pgid) && Date.now() < termDeadline) {
    await sleep(pollMs);
  }
  if (!alive(pgid)) return;
  opts.onEscalate?.();
  const hardDeadline = Date.now() + maxWaitMs;
  while (Date.now() < hardDeadline) {
    signalGroup(pgid, "SIGKILL");
    await sleep(pollMs);
    if (!alive(pgid)) return;
  }
  throw new ProcessGroupUndeadError(pgid, maxWaitMs);
}

/**
 * Argv marker carried by the supervisor (the group leader) so crash recovery
 * can verify process identity via `ps -o command=`. macOS forbids reading
 * another process's environment even same-user, so the env var alone cannot
 * prove a ledger row's pid was not recycled — argv can.
 */
export function validationNonceMarker(nonce: string): string {
  return `cc-validation-nonce=${nonce}`;
}

/**
 * The per-run supervisor: group leader for every validation run. Its argv
 * carries the nonce marker (durable, ps-readable identity), it launches the
 * registered command with execFile semantics — argv passed through verbatim,
 * no shell-string interpretation of anything configurable — and it exits
 * LAST: after the command finishes it reaps every surviving group member, so
 * a live group always implies a live, verifiable leader. Without that
 * ordering a server crash between command exit and group-death confirmation
 * would leave orphan descendants no recovery pass could safely identify.
 */
/** Supervisor exit code for a start barrier that closed without a release. */
export const SUPERVISOR_START_ABORTED_EXIT_CODE = 97;

const SUPERVISOR_SOURCE = `#!/bin/sh
# Command Center validation supervisor (generated; do not edit).
# argv: <nonce-marker> <command-path> [path args...]
shift
cmd="$1"
shift

# Start barrier: the parent persists this group's pid + nonce to the ledger,
# then releases the workload with one line on stdin. A server crash before
# the release closes the pipe; read sees EOF and the workload never starts,
# so a running ledger row with no persisted pid provably has no workload.
IFS= read -r _release || exit 97

# Launch before ignoring TERM: a signal ignored at shell entry cannot be
# re-enabled in the child, and the registered command must stay killable.
"$cmd" "$@" &
child=$!
# The supervisor ignores group-wide SIGTERM (timeout/cancel) so it survives
# its descendants and can reap them; SIGKILL escalation still removes it.
trap '' TERM
wait "$child"
code=$?

# Snapshot the group with a plain redirect, never a command substitution: a
# substitution forks a subshell into this same group, so the scan would count
# its own helpers as stragglers, never observe an empty group, and spend the
# full retry budget on every run — turning short-timeout commands into false
# timeouts. A redirect forks only pgrep, which never lists itself.
strays="\${TMPDIR:-/tmp}/cc-validation-strays.$$"
scan_strays() { pgrep -g "$$" >"$strays" 2>/dev/null; return 0; }
# read and kill are builtins, so walking the snapshot forks nothing.
have_strays() {
  while IFS= read -r stray; do
    if [ -n "$stray" ] && [ "$stray" != "$$" ]; then return 0; fi
  done <"$strays"
  return 1
}
signal_strays() {
  while IFS= read -r stray; do
    if [ -n "$stray" ] && [ "$stray" != "$$" ]; then
      kill -"$1" "$stray" 2>/dev/null
    fi
  done <"$strays"
}

scan_strays
if have_strays; then
  signal_strays TERM
  tries=0
  while [ "$tries" -lt 50 ]; do
    sleep 0.1
    tries=$((tries + 1))
    scan_strays
    have_strays || break
  done
  scan_strays
  if have_strays; then signal_strays KILL; fi
fi
rm -f "$strays"
exit "$code"
`;

let cachedSupervisorPath: string | null = null;

/**
 * Materialize the supervisor as an executable file under the OS temp dir,
 * content-addressed so upgrades write a fresh file and concurrent writers
 * race benignly (write-then-rename is atomic on one filesystem).
 */
export function ensureValidationSupervisorScript(): string {
  const hash = createHash("sha256")
    .update(SUPERVISOR_SOURCE)
    .digest("hex")
    .slice(0, 12);
  const target = path.join(
    os.tmpdir(),
    "cc-validation",
    `supervisor-${hash}.sh`,
  );
  if (cachedSupervisorPath === target && existsSync(target)) return target;
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) {
    const staging = `${target}.${process.pid}.tmp`;
    writeFileSync(staging, SUPERVISOR_SOURCE, { mode: 0o755 });
    renameSync(staging, target);
  }
  cachedSupervisorPath = target;
  return target;
}

export async function spawnValidation(
  params: SpawnValidationParams,
): Promise<SpawnValidationResult> {
  const killGraceMs = params.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  if (params.scopePaths.length > 0) {
    if (params.effectiveScope !== "changed") {
      return {
        kind: "path_args_require_changed",
        tokens: [...params.scopePaths],
      };
    }
    if (params.pathArgs === "forbid") {
      return { kind: "path_args_forbidden", tokens: [...params.scopePaths] };
    }
    const checked = validatePathArgs(params.scopePaths, params.worktreePath);
    if (!checked.ok) {
      return {
        kind: "path_args_rejected",
        violation: checked.kind,
        token: checked.token,
      };
    }
  }

  const scriptPath = path.isAbsolute(params.command)
    ? params.command
    : path.join(params.projectPath, params.command);
  if (!existsSync(scriptPath)) {
    return { kind: "script_not_found", scriptPath };
  }
  try {
    // The supervisor would turn a non-executable script into exit 126 long
    // after spawn; preflighting keeps it a spawn_error like direct exec.
    accessSync(scriptPath, fsConstants.X_OK);
  } catch {
    return {
      kind: "spawn_error",
      message: `validation script is not executable: ${scriptPath}`,
    };
  }

  const env: NodeJS.ProcessEnv = {
    ...buildChildEnv(),
    PROJECT_ROOT: params.worktreePath,
    CLAUDE_PROJECT_DIR: params.projectPath,
    WORKTREE_PATH: params.worktreePath,
    SESSION_NAME: params.sessionName,
    BRANCH_NAME: params.branchName,
    ...(params.targetBranch ? { TARGET_BRANCH: params.targetBranch } : {}),
    ...(params.contextId ? { CONTEXT_ID: params.contextId } : {}),
    CC_VALIDATION_RUN_ID: params.runId,
    CC_VALIDATION_COMMAND: params.commandName,
    CC_VALIDATION_COST: String(params.cost),
    CC_VALIDATION_NONCE: params.nonce,
  };

  // The supervisor file is the group leader, invoked with a pure argv array
  // (execFile semantics — no shell -c string anywhere): its argv carries the
  // nonce marker for recovery, the registered script path, and the validated
  // validated paths passed through verbatim.
  let supervisorPath: string;
  try {
    supervisorPath = ensureValidationSupervisorScript();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "spawn_error",
      message: `could not materialize the validation supervisor: ${message}`,
    };
  }
  const child = spawn(
    supervisorPath,
    [validationNonceMarker(params.nonce), scriptPath, ...params.scopePaths],
    {
      cwd: params.worktreePath,
      env,
      detached: true,
      // stdin is the start barrier: the supervisor blocks the workload until
      // a release line arrives (or aborts on EOF if this process dies first).
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // Writing the release to an already-dead group raises EPIPE; the wait()
  // path reports the real outcome, so the stream error itself is noise.
  child.stdin?.on("error", () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("validation.runner.spawn_error", {
      runId: params.runId,
      name: params.commandName,
      scriptPath,
      message,
    });
    return { kind: "spawn_error", message };
  }
  // Post-spawn errors (e.g. from signaling) must not crash the server.
  child.on("error", () => {});

  const pgid = child.pid;
  if (pgid === undefined) {
    return { kind: "spawn_error", message: "spawned child has no pid" };
  }

  logger.info("validation.runner.spawned", {
    runId: params.runId,
    name: params.commandName,
    cost: params.cost,
    pid: pgid,
    worktreePath: params.worktreePath,
    timeoutMs: params.timeoutMs,
    requestedScope: params.requestedScope,
    effectiveScope: params.effectiveScope,
    scopedPathCount: params.scopePaths.length,
  });

  // Combined bounded capture in arrival order; wrappers keep output
  // AI-optimized, this bound only guards against a runaway command.
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const append = (chunk: Buffer): void => {
    if (truncated) return;
    const remaining = maxOutputBytes - capturedBytes;
    if (chunk.length >= remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      capturedBytes = maxOutputBytes;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    capturedBytes += chunk.length;
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const streamsClosed = Promise.all([
    new Promise<void>(
      (resolve) => child.stdout?.once("close", resolve) ?? resolve(),
    ),
    new Promise<void>(
      (resolve) => child.stderr?.once("close", resolve) ?? resolve(),
    ),
  ]);

  const buildOutput = (): string => {
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    return truncated ? `${text}\n[output truncated]` : text;
  };

  let timedOut = false;
  let cancelled = false;
  const childExited = (): boolean =>
    child.exitCode !== null || child.signalCode !== null;

  const ensureGroupDead = (): Promise<void> =>
    killProcessGroup(pgid, {
      killGraceMs,
      pollMs,
      onEscalate: () => {
        logger.warn("validation.runner.group_kill_escalated", {
          runId: params.runId,
          name: params.commandName,
          pid: pgid,
        });
      },
    });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  const timer = setTimeout(() => {
    if (childExited()) return;
    timedOut = true;
    logger.warn("validation.runner.timeout", {
      runId: params.runId,
      name: params.commandName,
      pid: pgid,
      timeoutMs: params.timeoutMs,
    });
    void ensureGroupDead();
  }, params.timeoutMs);

  const outcomePromise: Promise<ValidationRunOutcome> = (async () => {
    const exitCode = await exited;
    clearTimeout(timer);
    // Capacity is released on this resolution, so the whole group — not just
    // the direct child — must be confirmed dead first (waitpid + probe).
    await ensureGroupDead();
    // With every group member dead the pipes close promptly; the race is a
    // backstop against exotic stdio inheritance keeping a descriptor open.
    await Promise.race([streamsClosed, sleep(1_000)]);
    const output = buildOutput();
    const outcome: ValidationRunOutcome = cancelled
      ? { kind: "cancelled", output }
      : timedOut
        ? { kind: "timed_out", timeoutMs: params.timeoutMs, output }
        : { kind: "exited", exitCode, output };
    logger.info("validation.runner.group_dead", {
      runId: params.runId,
      name: params.commandName,
      pid: pgid,
      outcome: outcome.kind,
      exitCode,
    });
    return outcome;
  })();

  let startConfirmed = false;
  const confirmStart = (): void => {
    if (startConfirmed) return;
    startConfirmed = true;
    logger.info("validation.runner.start_confirmed", {
      runId: params.runId,
      name: params.commandName,
      pid: pgid,
    });
    child.stdin?.write("go\n");
    child.stdin?.end();
  };

  return {
    kind: "spawned",
    handle: {
      processGroupPid: pgid,
      confirmStart,
      wait: () => outcomePromise,
      cancel: () => {
        if (!childExited() && !timedOut) {
          cancelled = true;
          clearTimeout(timer);
          logger.info("validation.runner.cancel_requested", {
            runId: params.runId,
            name: params.commandName,
            pid: pgid,
          });
          void ensureGroupDead();
        }
        return outcomePromise;
      },
    },
  };
}
