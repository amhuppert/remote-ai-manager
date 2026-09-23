import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphWorkflowUpstreamInput } from "./context-outputs";
import { writeUpstreamInputFiles } from "./upstream-input-files";

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-upstream-inputs-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const delivered: GraphWorkflowUpstreamInput = {
  contextId: "song-a",
  title: "Song A",
  declared: true,
  schemaFields: null,
  output: { title: "Write What You See", lyrics: "[Verse 1]\nOn Patmos" },
  skipped: false,
};
const skipped: GraphWorkflowUpstreamInput = {
  ...delivered,
  contextId: "song-b",
  title: "Song B",
  output: null,
  skipped: true,
};
const pending: GraphWorkflowUpstreamInput = {
  ...delivered,
  contextId: "song-c",
  title: "Song C",
  output: null,
};

describe("writeUpstreamInputFiles", () => {
  it("saves each delivered payload verbatim in a read-only context's private scratch", () => {
    const scratchRootDir = tempDir();
    const worktree = tempDir();

    const directory = writeUpstreamInputFiles(
      {
        executionId: "exec-1",
        contextId: "judge",
        placementMode: "readOnly",
        worktreePath: worktree,
        inputs: [delivered, skipped, pending],
      },
      { scratchRootDir },
    );

    expect(directory).not.toBeNull();
    // Never the shared worktree: sibling contexts read that one too.
    expect(
      directory?.startsWith(scratchRootDir) ||
        directory?.includes(path.basename(scratchRootDir)),
    ).toBe(true);
    expect(readdirSync(directory ?? "")).toEqual(["song-a.json"]);
    expect(
      JSON.parse(
        readFileSync(path.join(directory ?? "", "song-a.json"), "utf8"),
      ),
    ).toEqual(delivered.output);
    expect(readdirSync(worktree)).toEqual([]);
  });

  it("saves a write-capable context's inputs under the worktree's git-ignored .cc/temp", () => {
    const worktree = tempDir();

    const directory = writeUpstreamInputFiles(
      {
        executionId: "exec-1",
        contextId: "consolidated-report",
        placementMode: "full",
        worktreePath: worktree,
        inputs: [delivered],
      },
      { scratchRootDir: tempDir() },
    );

    expect(directory).toBe(
      path.join(worktree, ".cc", "temp", "consolidated-report", "inputs"),
    );
    expect(readdirSync(directory ?? "")).toEqual(["song-a.json"]);
  });

  it("writes nothing when no predecessor delivered a payload", () => {
    const worktree = tempDir();

    const directory = writeUpstreamInputFiles(
      {
        executionId: "exec-1",
        contextId: "report",
        placementMode: "full",
        worktreePath: worktree,
        inputs: [skipped, pending],
      },
      { scratchRootDir: tempDir() },
    );

    expect(directory).toBeNull();
    expect(readdirSync(worktree)).toEqual([]);
  });
});
