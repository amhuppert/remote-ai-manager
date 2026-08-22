import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  readProcessGroupIdSync,
  readProcessStartTicks,
} from "./process-identity";

/**
 * Reads the real `/proc` entries these functions exist to read. A fake
 * filesystem would prove only that the parser matches the fake's idea of the
 * format, and the format is exactly what is at stake.
 */

describe("process identity", () => {
  it("reads this process's own group", () => {
    const pgid = readProcessGroupIdSync("self");
    expect(pgid).not.toBeNull();
    expect(pgid).toBeGreaterThan(0);
    expect(readProcessGroupIdSync(process.pid)).toBe(pgid);
  });

  it("reads a stable start time that differs between processes", async () => {
    const mine = await readProcessStartTicks(process.pid);
    expect(mine).not.toBeNull();
    expect(await readProcessStartTicks(process.pid)).toBe(mine);

    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        stdio: "ignore",
      },
    );
    try {
      expect(child.pid).toBeDefined();
      const theirs = await readProcessStartTicks(child.pid ?? 0);
      expect(theirs).not.toBeNull();
      expect(theirs).not.toBe(mine);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reports identity as unreadable rather than guessing", async () => {
    // Pid 0 is not addressable through /proc, so both reads must refuse.
    expect(readProcessGroupIdSync(0)).toBeNull();
    expect(await readProcessStartTicks(0)).toBeNull();
  });

  it("reads a process group the spawner deliberately detached", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    try {
      // A detached child leads its own group, so its pgid is its own pid — the
      // property the supervisor's ownership guard depends on.
      expect(readProcessGroupIdSync(child.pid ?? 0)).toBe(child.pid);
    } finally {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }
  });
});
