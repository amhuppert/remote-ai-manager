import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSharedDocumentStore,
  hashSharedDocumentContent,
} from "./shared-document-store";

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

    const reference = await store.captureFromWorktree({
      executionId: "execution-1",
      worktreePath: worktree,
      relativePath,
    });

    const stored = path.join(
      configDir,
      "workflow-docs",
      "execution-1",
      "objects",
      reference.contentHash,
    );
    expect(existsSync(stored)).toBe(true);
    await expect(readFile(stored, "utf-8")).resolves.toBe(
      "# API contract\nendpoints…",
    );

    await expect(
      store.read({ executionId: "execution-1", relativePath, ...reference }),
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

  it("preserves an open reader's complete document when a producer registers a replacement", async () => {
    const store = makeStore();
    const relativePath = "inventory.json";
    const capture = {
      executionId: "execution-1",
      worktreePath: worktree,
      relativePath,
    };
    await writeWorktreeFile(relativePath, "Complete revision 1");
    const initialReference = await store.captureFromWorktree(capture);
    const reader = await open(
      path.join(
        configDir,
        "workflow-docs",
        "execution-1",
        "objects",
        initialReference.contentHash,
      ),
      "r",
    );
    try {
      await writeWorktreeFile(relativePath, "Complete revision 2");
      const nextReference = await store.captureFromWorktree(capture);
      expect(await reader.readFile("utf-8")).toBe("Complete revision 1");
      expect(await store.read({ ...capture, ...nextReference })).toBe(
        "Complete revision 2",
      );
      expect(await store.read({ ...capture, ...initialReference })).toBe(
        "Complete revision 1",
      );
    } finally {
      await reader.close();
    }
  });

  it("keeps documents isolated per execution id", async () => {
    const store = makeStore();
    const relativePath = ".cc/graph-workflow-docs/plan.md";
    await writeWorktreeFile(relativePath, "plan-A");

    const reference = await store.captureFromWorktree({
      executionId: "execution-A",
      worktreePath: worktree,
      relativePath,
    });

    await expect(
      store.read({ executionId: "execution-A", relativePath, ...reference }),
    ).resolves.toBe("plan-A");
    await expect(
      store.read({ executionId: "execution-B", relativePath, ...reference }),
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

  it("refuses capture when the source document is absent", async () => {
    const store = makeStore();
    await expect(
      store.captureFromWorktree({
        executionId: "execution-1",
        worktreePath: worktree,
        relativePath: ".cc/graph-workflow-docs/never-written.md",
      }),
    ).rejects.toThrow();
  });
  it("refuses corrupted objects instead of delivering different bytes", async () => {
    const store = makeStore();
    const contentHash = hashSharedDocumentContent("original");
    const objectPath = path.join(
      configDir,
      "workflow-docs",
      "execution-1",
      "objects",
      contentHash,
    );
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "corrupted");
    await expect(
      store.read({
        executionId: "execution-1",
        relativePath: "plan.md",
        contentHash,
      }),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("converts legacy content idempotently without a runtime path fallback", async () => {
    const store = makeStore();
    const input = {
      executionId: "execution-1",
      relativePath: ".cc/graph-workflow-docs/plan.md",
    };
    const oldPath = path.join(
      configDir,
      "workflow-docs",
      input.executionId,
      input.relativePath,
    );
    await mkdir(path.dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "retained publication");
    expect(await store.read(input)).toBeNull();
    const reference = await store.migrateLegacyDocument(input);
    expect(reference).toEqual(await store.migrateLegacyDocument(input));
    await rm(oldPath);
    expect(await makeStore().read({ ...input, ...reference })).toBe(
      "retained publication",
    );
    expect(await store.migrateLegacyDocument(input)).toBeNull();
  });
});
