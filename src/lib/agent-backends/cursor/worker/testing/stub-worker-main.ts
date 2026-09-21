import { spawn } from "node:child_process";
import {
  startCursorWorker,
  type CursorWorkerAgent,
  type CursorWorkerChannel,
  type CursorWorkerProcessControl,
  type CursorWorkerRun,
  type CursorWorkerSdk,
} from "../entry";
import type { CursorWorkerFrame } from "../ipc";
import {
  errnoCode,
  readProcessGroupIdSync,
} from "@/lib/shared/process-identity";

/**
 * A spawnable Cursor worker with the SDK scripted instead of loaded.
 *
 * This is the REAL worker runtime — the same handshake, watchdog, and teardown
 * code `main.ts` runs — bound to real process effects in a real process group.
 * Only `@cursor/sdk` is replaced, because the process-lifetime behaviors under
 * test (self-termination on disconnect or parent death, idle reaping, the
 * supervisor's group escalation) have nothing to do with the provider and
 * everything to do with the operating system.
 *
 * Behavior is selected through `CURSOR_STUB_*` variables. The `CC_` prefix is
 * unavailable on purpose: the session env contract neutralizes every inherited
 * `CC_*` key, so a flag spelled that way would never arrive.
 */

const mode = process.env.CURSOR_STUB_MODE ?? "ok";
const ignoreSigterm = process.env.CURSOR_STUB_IGNORE_SIGTERM === "1";
const childMarker = process.env.CURSOR_STUB_CHILD_MARKER;

if (ignoreSigterm) {
  // A worker wedged past a polite signal, which is what forces the ladder to
  // escalate rather than stopping at SIGTERM.
  process.on("SIGTERM", () => {});
}

if (childMarker !== undefined && childMarker.length > 0) {
  // A descendant inside this worker's process group: the only way an outside
  // observer can tell a group-scoped teardown from a process-scoped one. It
  // carries its marker in argv so the test can find it by `pgrep -f`.
  spawn(
    process.execPath,
    [
      "-e",
      `/* ${childMarker} */ ${ignoreSigterm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore" },
  );
}

const run: CursorWorkerRun = {
  async *stream() {
    yield { type: "assistant", agent_id: "stub-agent", text: "stub" };
  },
  wait: async () => ({ status: "finished" }),
  cancel: async () => {},
};

const agent: CursorWorkerAgent = {
  agentId: "stub-agent",
  send: async () => run,
  getUsage: async () => ({
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    runs: [],
  }),
  dispose: async () => {},
};

const sdk: CursorWorkerSdk = {
  async verifyCredential(apiKey: string) {
    if (apiKey.length === 0) throw new Error("empty credential");
    if (mode === "invalid_credential") {
      throw Object.assign(new Error("stub rejects this credential"), {
        name: "AuthenticationError",
        status: 401,
      });
    }
  },
  create: async () => agent,
  resume: async () => agent,
};

const channel: CursorWorkerChannel = {
  send(frame: CursorWorkerFrame): void {
    process.send?.(frame);
  },
  onMessage(listener) {
    process.on("message", (value: unknown) => {
      // A wedged worker: frames still arrive, but the shutdown request is never
      // acted on, so only the supervisor's escalation can end this process.
      if (
        mode === "hang" &&
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "type") === "shutdown"
      ) {
        return;
      }
      listener(value);
    });
  },
  onDisconnect(listener) {
    process.on("disconnect", listener);
  },
};

const control: CursorWorkerProcessControl = {
  pid: process.pid,
  processGroupId: () => readProcessGroupIdSync("self") ?? process.pid,
  setUmask: (mask) => {
    process.umask(mask);
  },
  parentPid: () => process.ppid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errnoCode(error) === "EPERM";
    }
  },
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      // ESRCH: already gone.
    }
  },
  ignoreTermination: () => {
    process.on("SIGTERM", () => {});
  },
  exit: (code) => {
    process.exit(code);
  },
};

startCursorWorker({
  channel,
  process: control,
  loadSdk: async () => sdk,
  nodeVersion: process.version,
  sdkVersion: "1.0.28",
});
