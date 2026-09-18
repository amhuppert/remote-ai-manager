import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  observeOwnedClaudeSpawn,
  type OwnedClaudeProcess,
} from "./claude-owned-process";

describe("owned Claude process probe boundary", () => {
  it("records the actual child PID and interrupts only its owned process handle", async () => {
    mkdirSync(".cc/temp", { recursive: true });
    const directory = mkdtempSync(path.resolve(".cc/temp/owned-process-test-"));
    const spawned: ChildProcessWithoutNullStreams[] = [];
    const owned: OwnedClaudeProcess[] = [];
    try {
      const observedSpawn = observeOwnedClaudeSpawn(
        directory,
        "query",
        "capture",
        (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: { ...options.env, NODE_ENV: "test" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          spawned.push(child);
          return child;
        },
        (child) => owned.push(child),
      );
      observedSpawn({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: directory,
        env: {},
        signal: new AbortController().signal,
      });
      const child = owned[0];
      if (!child) throw new Error("observed child missing");
      expect(await child.signal("SIGSTOP")).toBe(true);
      await delay(20);
      expect(await child.signal("SIGCONT")).toBe(true);
      expect(await child.signal("SIGTERM")).toBe(true);
      expect(await child.waitForExit(2000)).toBe(true);
      expect(child.snapshot()).toMatchObject({
        pid: spawned[0]?.pid,
        parentPid: process.pid,
        sdkExitObserved: true,
        signals: [
          { signal: "SIGSTOP", sent: true },
          { signal: "SIGCONT", sent: true },
          { signal: "SIGTERM", sent: true },
        ],
      });
      expect(await child.signal("SIGTERM")).toBe(false);
    } finally {
      await Promise.all(
        spawned.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              child.once("close", () => resolve());
              child.kill("SIGKILL");
            }),
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
