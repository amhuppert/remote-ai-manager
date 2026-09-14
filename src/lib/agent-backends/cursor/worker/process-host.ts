import { fork } from "node:child_process";
import type { CursorParentFrame } from "./ipc";
import {
  errnoCode,
  readProcessGroupIdSync,
  readProcessStartTicks,
} from "./process-identity";

/**
 * The operating-system surface the Cursor supervisor uses, as one injectable
 * seam (spec D9, D19).
 *
 * Spawning, signalling, and liveness probing are the supervisor's whole
 * teardown mechanism, so they are the one thing its tests must be able to
 * script: a fake host lets every rung of the ladder — orderly exit, SIGTERM
 * escalation, SIGKILL, a surviving group, a recycled pid — be exercised without
 * a real process in a state that is hard to produce on demand.
 */

export interface CursorSpawnRequest {
  scriptPath: string;
  execArgv: readonly string[];
  cwd: string;
  /** Complete replacement environment — never merged with the parent's. */
  env: Record<string, string>;
}

export interface CursorSpawnedProcess {
  readonly pid: number;
  send(frame: CursorParentFrame): void;
  onMessage(listener: (value: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  disconnect(): void;
}

export interface CursorProcessHost {
  /** Throws when the process cannot be started at all. */
  spawn(request: CursorSpawnRequest): CursorSpawnedProcess;
  /** Null when the group cannot be read; callers treat that as unverifiable. */
  processGroupId(pid: number): number | null;
  startTicks(pid: number): Promise<string | null>;
  isGroupAlive(pgid: number): boolean;
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
}

/**
 * `NODE_ENV` is typed as a closed union on this project's `ProcessEnv`, so the
 * spawn environment restates it rather than passing a bare string through.
 * Development is the same default `buildChildEnv()` forces on every Command
 * Center child: the server itself runs as a production Next build, and children
 * that inherit that value misbehave.
 */
function nodeEnvOf(env: Record<string, string>): NodeJS.ProcessEnv["NODE_ENV"] {
  const value = env.NODE_ENV;
  return value === "production" || value === "test" ? value : "development";
}

export function createCursorProcessHost(): CursorProcessHost {
  return {
    spawn(request) {
      const child = fork(request.scriptPath, [], {
        cwd: request.cwd,
        env: { ...request.env, NODE_ENV: nodeEnvOf(request.env) },
        // `detached` makes the worker its own process-group leader, which is
        // what lets teardown signal children that remain in that group. SDK
        // shell children can lead separate groups and require native cancellation.
        detached: true,
        // Explicit rather than inherited: the server's own execArgv (heap caps,
        // loaders) has nothing to do with what the worker needs.
        execArgv: [...request.execArgv],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error("the Cursor worker process was not assigned a pid");
      }
      return {
        pid,
        send(frame) {
          child.send(frame);
        },
        onMessage(listener) {
          child.on("message", listener);
        },
        onExit(listener) {
          child.on("exit", listener);
        },
        onError(listener) {
          child.on("error", listener);
        },
        disconnect() {
          if (child.connected) child.disconnect();
        },
      };
    },
    processGroupId: (pid) => readProcessGroupIdSync(pid),
    startTicks: (pid) => readProcessStartTicks(pid),
    isGroupAlive(pgid) {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        // EPERM means a member exists that this process may no longer signal —
        // still alive, and still a reason not to report cleanup verified.
        return errnoCode(error) === "EPERM";
      }
    },
    signalGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // ESRCH: the group is already gone, which is the goal state.
      }
    },
  };
}
