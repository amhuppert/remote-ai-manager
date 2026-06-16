import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSharedDocumentStore } from "./shared-document-store";

describe("shared document store", () => {
  let configDir: string;
  let worktree: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "cc-doc-store-config-"));
    worktree = await mkdtemp(path.join(tmpdir(), "cc-doc-store-worktree-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  });

  function makeStore() {
    return createSharedDocumentStore({ resolveConfigDir: () => configDir });
  }

  async function writeWorktreeFile(
    relativePath: string,
    contents: string,
  ): Promise<void> {
    const absolute = path.join(worktree, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf-8");
  }

  it("captures a worktree document into the per-execution store and reads it back", async () => {
    const store = makeStore();
    const relativePath = ".cc/graph-workflow-docs/api-contract.md";
    await writeWorktreeFile(relativePath, "# API contract\nendpoints…");

    await store.captureFromWorktree({
      executionId: "execution-1",
      worktreePath: worktree,
      relativePath,
    });

    const stored = path.join(
      configDir,
      "workflow-docs",
      "execution-1",
      relativePath,
    );
    expect(existsSync(stored)).toBe(true);
    await expect(readFile(stored, "utf-8")).resolves.toBe(
      "# API contract\nendpoints…",
    );

    await expect(
      store.read({ executionId: "execution-1", relativePath }),
    ).resolves.toBe("# API contract\nendpoints…");
  });

  it("returns null when reading a document that was never captured", async () => {
    const store = makeStore();
    await expect(
      store.read({
        executionId: "execution-1",
        relativePath: ".cc/graph-workflow-docs/missing.md",
      }),
    ).resolves.toBeNull();
  });

  it("keeps documents isolated per execution id", async () => {
    const store = makeStore();
    const relativePath = ".cc/graph-workflow-docs/plan.md";
    await writeWorktreeFile(relativePath, "plan-A");

    await store.captureFromWorktree({
      executionId: "execution-A",
      worktreePath: worktree,
      relativePath,
    });

    await expect(
      store.read({ executionId: "execution-A", relativePath }),
    ).resolves.toBe("plan-A");
    await expect(
      store.read({ executionId: "execution-B", relativePath }),
    ).resolves.toBeNull();
  });

  it("rejects relative paths that escape the store root", async () => {
    const store = makeStore();
    await expect(
      store.read({
        executionId: "execution-1",
        relativePath: "../../../etc/passwd",
      }),
    ).rejects.toThrow(/escapes the store/);
  });

  it("throws when the source document is absent so the caller can degrade", async () => {
    const store = makeStore();
    await expect(
      store.captureFromWorktree({
        executionId: "execution-1",
        worktreePath: worktree,
        relativePath: ".cc/graph-workflow-docs/never-written.md",
      }),
    ).rejects.toThrow();
  });
});
