import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  createDefaultSessionArtifactRegistry,
  type ReferenceDocumentRegistrarFn,
} from "./default-session-artifact-registry";

describe("createDefaultSessionArtifactRegistry", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "default-artifact-registry-"),
    );
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it("writes a focus_memory artifact to the canonical path AND registers it as a reference document via the project state hook", async () => {
    const registerCalls: Array<{
      projectPath: string;
      sessionName: string;
      filePath: string;
      description: string;
    }> = [];
    const registerReferenceDocument: ReferenceDocumentRegistrarFn = async (
      input,
    ) => {
      registerCalls.push(input);
    };

    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument,
    });

    const record = await registry.write({
      kind: "focus_memory",
      worktreePath: workingDir,
      relativePath: "memory-bank/focus.md",
      contents: "# Focus\nHello.\n",
      audience: "user_facing",
      source: { workflowId: "wf-1", laneId: "lane-1" },
      description: "Current focus",
    });

    expect(record.kind).toBe("focus_memory");
    expect(record.relativePath).toBe("memory-bank/focus.md");

    const written = await fs.readFile(
      path.join(workingDir, "memory-bank/focus.md"),
      "utf-8",
    );
    expect(written).toBe("# Focus\nHello.\n");

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]).toEqual({
      projectPath: "/proj/p",
      sessionName: "s",
      filePath: "memory-bank/focus.md",
      description: "Current focus",
    });
  });

  it("writes a codex_output artifact under memory-bank/codex without invoking the reference-document registrar", async () => {
    const registerReferenceDocument = vi.fn<ReferenceDocumentRegistrarFn>();
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument,
    });

    const record = await registry.write({
      kind: "codex_output",
      worktreePath: workingDir,
      relativePath: "memory-bank/codex/run-001/notes.md",
      contents: "notes",
      audience: "internal_log",
      source: { workflowId: "wf-2" },
    });

    expect(record.relativePath).toBe(
      path.normalize("memory-bank/codex/run-001/notes.md"),
    );
    const written = await fs.readFile(
      path.join(workingDir, "memory-bank/codex/run-001/notes.md"),
      "utf-8",
    );
    expect(written).toBe("notes");
    expect(registerReferenceDocument).not.toHaveBeenCalled();
  });

  it("rejects path traversal attempts even when the rest of the call would be valid", async () => {
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument: async () => {},
    });

    await expect(
      registry.write({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: "../escape.log",
        contents: "x",
        audience: "internal_log",
        source: {},
      }),
    ).rejects.toThrow(/outside the session worktree/);
  });

  it("returns a skipped_warning when an optional reference-document write fails registration", async () => {
    const registerReferenceDocument: ReferenceDocumentRegistrarFn =
      async () => {
        throw new Error("state lock contention");
      };
    const registry = createDefaultSessionArtifactRegistry({
      projectPath: "/proj/p",
      sessionName: "s",
      registerReferenceDocument,
    });

    const outcome = await registry.writeOptional({
      kind: "focus_memory",
      worktreePath: workingDir,
      relativePath: "memory-bank/focus.md",
      contents: "x",
      audience: "user_facing",
      source: {},
      description: "f",
    });

    expect(outcome.status).toBe("skipped_warning");
  });
});
