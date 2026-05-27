/**
 * Timed shell-command execution wrappers.
 *
 * `execFile(command, args, options)` — one-shot exec wrapped with `timed()`.
 * `spawn(command, args, options)` — long-running spawn returning a ChildProcess
 *   that emits start/exit lifecycle logs.
 *
 * Both pick up trace context from AsyncLocalStorage automatically.
 *
 * The `eventPrefix` option swaps the logged event base (e.g., `"git"` causes
 * events to be emitted as `git.complete`/`git.error`). Default `"exec"` for
 * one-shot, `"spawn"` for spawn.
 */

import {
  execFile as execFileCb,
  spawn as nodeSpawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logging";
import { timed } from "../logging";

const execFileAsync = promisify(execFileCb);

const logger = createLogger("exec");

const ARGS_PREVIEW_LIMIT = 200;

function previewArgs(args: string[]): string {
  const joined = args.join(" ");
  if (joined.length <= ARGS_PREVIEW_LIMIT) return joined;
  return joined.slice(0, ARGS_PREVIEW_LIMIT - 1) + "\u2026";
}

export interface ExecFileOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  /** Override the logged event prefix (default "exec") */
  eventPrefix?: string;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Execute a command with arguments, timing the operation and logging the result.
 *
 * On non-zero exit, the underlying execFile rejection is re-thrown unchanged
 * (preserving stdout/stderr/code on the Error). The error log is emitted by
 * `timed()`'s `.error` handler; this function adds exec-specific fields via
 * an extra log line at warn level on failure.
 */
export async function execFile(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  const eventPrefix = options.eventPrefix ?? "exec";
  const argsPreview = previewArgs(args);
  const baseFields: Record<string, unknown> = {
    command,
    argsPreview,
    cwd: options.cwd,
    timeoutMs: options.timeout,
  };

  return timed(logger, eventPrefix, baseFields, async () => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      });
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      logger.debug(`${eventPrefix}.result`, {
        ...baseFields,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        exitCode: 0,
      });
      return { stdout, stderr };
    } catch (err) {
      const execErr = err as ExecError;
      logger.warn(`${eventPrefix}.exit_error`, {
        ...baseFields,
        exitCode: typeof execErr.code === "number" ? execErr.code : null,
        signal: execErr.signal ?? null,
        killed: execErr.killed === true,
        timedOut: execErr.killed === true && (options.timeout ?? 0) > 0,
        stdoutBytes:
          typeof execErr.stdout === "string"
            ? Buffer.byteLength(execErr.stdout)
            : 0,
        stderrBytes:
          typeof execErr.stderr === "string"
            ? Buffer.byteLength(execErr.stderr)
            : 0,
      });
      throw err;
    }
  });
}

export interface ExecFileGroupOptions extends ExecFileOptions {
  /** Time (ms) to wait after SIGTERM before escalating to SIGKILL. Default 2000. */
  killGraceMs?: number;
}

const DEFAULT_GROUP_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;

function spawnCollectGroup(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer: number;
    killGraceMs: number;
  },
): Promise<ExecFileResult> {
  return new Promise<ExecFileResult>((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      // New process group: lets us signal the whole tree via process.kill(-pid).
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | undefined;

    function killGroup(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      }
    }

    const timeoutTimer =
      opts.timeout && opts.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            sigkillTimer = setTimeout(
              () => killGroup("SIGKILL"),
              opts.killGraceMs,
            );
          }, opts.timeout)
        : undefined;

    function append(chunk: Buffer, which: "out" | "err"): void {
      if (truncated) return;
      const remaining = opts.maxBuffer - stdoutBytes - stderrBytes;
      if (chunk.length > remaining) {
        const slice = chunk
          .subarray(0, Math.max(0, remaining))
          .toString("utf-8");
        if (which === "out") stdout += slice;
        else stderr += slice;
        truncated = true;
        return;
      }
      if (which === "out") {
        stdout += chunk.toString("utf-8");
        stdoutBytes += chunk.length;
      } else {
        stderr += chunk.toString("utf-8");
        stderrBytes += chunk.length;
      }
    }

    child.stdout?.on("data", (c: Buffer) => append(c, "out"));
    child.stderr?.on("data", (c: Buffer) => append(c, "err"));

    function cleanup(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    }

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }
      const message = timedOut
        ? "Command timed out"
        : `Command failed with exit code ${code ?? "null"}`;
      const err: ExecError = Object.assign(new Error(message), {
        code: code ?? undefined,
        signal: signal ?? null,
        killed: timedOut,
        stdout,
        stderr,
      });
      reject(err);
    });
  });
}

/**
 * Like {@link execFile}, but runs the command as the leader of its own process
 * group (`detached: true`) so a timeout signals the *entire* tree via
 * `process.kill(-pid, ...)`, not just the leader.
 *
 * Required for commands that fan out into deep process trees — e.g. a shell
 * script that runs `vitest`, which forks one worker per CPU core. Node's
 * built-in `execFile`/`spawn` timeout only signals the direct child, so
 * killing the shell orphans the workers; they keep running and accumulate
 * across retries until the machine runs out of memory.
 *
 * Output is buffered up to `maxBuffer` bytes (default 10 MB) and truncated
 * beyond that rather than killing the child, so a noisy command degrades to
 * truncated logs instead of a spurious failure. The timeout is the backstop
 * for a runaway that never stops emitting.
 */
export async function execFileGroup(
  command: string,
  args: string[],
  options: ExecFileGroupOptions = {},
): Promise<ExecFileResult> {
  const eventPrefix = options.eventPrefix ?? "exec";
  const argsPreview = previewArgs(args);
  const maxBuffer = options.maxBuffer ?? DEFAULT_GROUP_MAX_BUFFER;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const baseFields: Record<string, unknown> = {
    command,
    argsPreview,
    cwd: options.cwd,
    timeoutMs: options.timeout,
  };

  return timed(logger, eventPrefix, baseFields, async () => {
    try {
      const { stdout, stderr } = await spawnCollectGroup(command, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer,
        killGraceMs,
      });
      logger.debug(`${eventPrefix}.result`, {
        ...baseFields,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        exitCode: 0,
      });
      return { stdout, stderr };
    } catch (err) {
      const execErr = err as ExecError;
      logger.warn(`${eventPrefix}.exit_error`, {
        ...baseFields,
        exitCode: typeof execErr.code === "number" ? execErr.code : null,
        signal: execErr.signal ?? null,
        killed: execErr.killed === true,
        timedOut: execErr.killed === true && (options.timeout ?? 0) > 0,
        stdoutBytes:
          typeof execErr.stdout === "string"
            ? Buffer.byteLength(execErr.stdout)
            : 0,
        stderrBytes:
          typeof execErr.stderr === "string"
            ? Buffer.byteLength(execErr.stderr)
            : 0,
      });
      throw err;
    }
  });
}

export interface SpawnTimedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  shell?: boolean | string;
  detached?: boolean;
  /** Override the logged event prefix (default "spawn") */
  eventPrefix?: string;
}

/**
 * Spawn a long-running child process. Emits a `start` log immediately and an
 * `exit` log when the process terminates. The returned ChildProcess is the raw
 * node handle; callers wire stdout/stderr themselves.
 *
 * Unlike `execFile`, this does not use `timed()` because the lifetime is
 * open-ended — we want one log when the process appears and one when it goes
 * away, with no `.complete` semantics in between.
 *
 * Pass an empty `args` array and `shell: true` to invoke a shell-string command.
 */
export function spawn(
  command: string,
  args: string[],
  options: SpawnTimedOptions = {},
): ChildProcess {
  const eventPrefix = options.eventPrefix ?? "spawn";
  const argsPreview = previewArgs(args);
  const start = Date.now();

  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
    shell: options.shell,
    detached: options.detached,
  });

  logger.info(`${eventPrefix}.start`, {
    command,
    argsPreview,
    cwd: options.cwd,
    pid: child.pid ?? null,
  });

  child.once("error", (err) => {
    logger.error(`${eventPrefix}.spawn_error`, {
      command,
      argsPreview,
      cwd: options.cwd,
      error: err instanceof Error ? err : String(err),
    });
  });

  child.once("exit", (exitCode, signal) => {
    const durationMs = Date.now() - start;
    const isError = exitCode !== null && exitCode !== 0 && signal === null;
    const fields = {
      command,
      argsPreview,
      cwd: options.cwd,
      pid: child.pid ?? null,
      exitCode,
      signal,
      durationMs,
    };
    if (isError) {
      logger.warn(`${eventPrefix}.exit`, fields);
    } else if (signal !== null) {
      logger.debug(`${eventPrefix}.exit`, fields);
    } else {
      logger.info(`${eventPrefix}.exit`, fields);
    }
  });

  return child;
}
