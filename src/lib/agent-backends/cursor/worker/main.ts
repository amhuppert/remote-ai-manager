import { CURSOR_SDK_PINNED_VERSION } from "../sdk-pin";
import {
  startCursorWorker,
  type CursorWorkerChannel,
  type CursorWorkerProcessControl,
} from "./entry";
import type { CursorWorkerFrame } from "./ipc";
import {
  errnoCode,
  readProcessGroupIdSync,
} from "@/lib/shared/process-identity";
import { loadCursorWorkerSdk } from "./sdk-port";

/**
 * The Cursor worker's process bootstrap: binds Node's fork channel and process
 * effects to the worker runtime and starts it.
 *
 * Kept separate from `entry.ts` so the runtime module has no side effects at
 * import — a test can load it, and this file is the only thing that must be
 * spawnable.
 */

const channel: CursorWorkerChannel = {
  send(frame: CursorWorkerFrame): void {
    if (process.send === undefined) {
      throw new Error("the Cursor worker was started without an IPC channel");
    }
    process.send(frame);
  },
  onMessage(listener) {
    process.on("message", listener);
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
      // EPERM means the process exists but is no longer signalable by us, which
      // is still alive for the purpose of "did my parent die".
      return errnoCode(error) === "EPERM";
    }
  },
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      // ESRCH: the group is already gone, which is the goal state.
    }
  },
  ignoreTermination: () => {
    // A listener replaces the default disposition, so the group-wide SIGTERM
    // this worker sends during teardown does not kill it before it can escalate
    // to SIGKILL for descendants that ignored the first signal.
    process.on("SIGTERM", () => {});
  },
  exit: (code) => {
    process.exit(code);
  },
};

startCursorWorker({
  channel,
  process: control,
  loadSdk: loadCursorWorkerSdk,
  nodeVersion: process.version,
  sdkVersion: CURSOR_SDK_PINNED_VERSION,
});
