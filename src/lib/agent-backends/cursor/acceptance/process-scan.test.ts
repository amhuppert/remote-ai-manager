import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  isProcessAlive,
  measureUntil,
  readMarkedProcess,
  readProcessCwd,
} from "./process-scan";

/**
 * These helpers are what the cancellation and isolation acceptance cases trust
 * to say "this process is gone" and "this worker runs here", so they are pinned
 * against real child processes on whatever host runs the suite — the same
 * evidence-per-host rule the preflight enforces.
 */

async function withFixtureChild(
  run: (pid: number) => Promise<void>,
): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd: tmpdir(),
    // A worker leads its own process group, which is what the scans read back.
    detached: true,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("the fixture child did not start");
  child.unref();
  try {
    await run(pid);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone: the case itself killed it.
    }
  }
  return pid;
}

describe("process-scan host readers", () => {
  it("reads a live process's identity and reports null once it is gone", async () => {
    const pid = await withFixtureChild(async (live) => {
      expect(readMarkedProcess(live)).toStrictEqual({
        pid: live,
        ppid: process.pid,
        pgid: live,
      });

      process.kill(live, "SIGKILL");
      const settled = await measureUntil(() => !isProcessAlive(live), 5000);
      expect(settled).not.toBeNull();
    });

    expect(readMarkedProcess(pid)).toBeNull();
  });

  it("reads a live process's working directory and reports null once it is gone", async () => {
    const pid = await withFixtureChild(async (live) => {
      // The OS reports the resolved directory (macOS tmpdir is a symlink).
      expect(readProcessCwd(live)).toBe(realpathSync(tmpdir()));

      process.kill(live, "SIGKILL");
      const settled = await measureUntil(() => !isProcessAlive(live), 5000);
      expect(settled).not.toBeNull();
    });

    expect(readProcessCwd(pid)).toBeNull();
  });
});
