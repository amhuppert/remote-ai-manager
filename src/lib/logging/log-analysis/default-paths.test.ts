import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverScopedLogPaths } from "./default-paths";

/**
 * A project conversation logs to `logs/projects/<project>/…` rather than
 * `logs/sessions/<project>__<sentinel>/…` (project-conversation-parity R1.3).
 * Discovery has to walk that tree too, or moving the destination would make
 * project logs invisible to every reader built on this resolver.
 */

let configDir: string;

function writeLog(...segments: string[]): string {
  const full = path.join(configDir, "logs", ...segments);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, '{"message":"x"}\n', "utf-8");
  return full;
}

describe("discoverScopedLogPaths", () => {
  beforeEach(() => {
    configDir = mkdtempSync(path.join(os.tmpdir(), "cc-log-discovery-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("discovers session logs and their conversation logs", async () => {
    const sessionLog = writeLog("sessions", "demo__feature-x", "session.log");
    const conversationLog = writeLog(
      "sessions",
      "demo__feature-x",
      "conversations",
      "conv-1.log",
    );

    await expect(discoverScopedLogPaths(configDir)).resolves.toEqual(
      expect.arrayContaining([sessionLog, conversationLog]),
    );
  });

  it("discovers project-scope logs and their conversation logs", async () => {
    const projectLog = writeLog("projects", "demo", "project.log");
    const conversationLog = writeLog(
      "projects",
      "demo",
      "conversations",
      "conv-2.log",
    );

    await expect(discoverScopedLogPaths(configDir)).resolves.toEqual(
      expect.arrayContaining([projectLog, conversationLog]),
    );
  });

  it("returns nothing when neither tree exists", async () => {
    await expect(discoverScopedLogPaths(configDir)).resolves.toEqual([]);
  });

  it("ignores non-log files in a scope directory", async () => {
    writeLog("projects", "demo", "notes.txt");
    const projectLog = writeLog("projects", "demo", "project.log");

    await expect(discoverScopedLogPaths(configDir)).resolves.toEqual([
      projectLog,
    ]);
  });
});
