import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore } from "./store";

let root: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cc-artifacts-"));
  worktree = await mkdtemp(path.join(tmpdir(), "cc-artifacts-worktree-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

/** Every stored object file, wherever the store keeps them. */
function objectFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("artifacts", () => {
  it("snapshots bytes once by their content and reads them back", async () => {
    const store = createArtifactStore({ root });
    const first = await store.snapshot(Buffer.from("# Plan\n"));
    const again = await store.snapshot(Buffer.from("# Plan\n"));
    const other = await store.snapshot(Buffer.from("# Other\n"));

    expect(first.artifactId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).toEqual({ artifactId: again.artifactId, bytes: 7 });
    expect(other.artifactId).not.toBe(first.artifactId);
    expect((await store.read(first.artifactId)).toString()).toBe("# Plan\n");
    expect(objectFiles(root)).toHaveLength(2);
  });

  it("refuses to read bytes that are missing or no longer match their identity", async () => {
    const store = createArtifactStore({ root });
    const ref = await store.snapshot(Buffer.from("# Plan\n"));
    const [stored] = objectFiles(root);
    if (stored === undefined) throw new Error("nothing stored");
    await chmod(stored, 0o644);
    await writeFile(stored, "tampered");

    await expect(store.read(ref.artifactId)).rejects.toThrow(/do not match/);
    await expect(store.read(`sha256:${"0".repeat(64)}`)).rejects.toThrow(
      /missing/,
    );
    await expect(store.read("../escape")).rejects.toThrow(/not an artifact/);
  });

  it("writes editable worktree copies without changing stored artifacts and restores frozen bytes on redelivery", async () => {
    const store = createArtifactStore({ root });
    const plan = await store.snapshot(Buffer.from("# Plan\n"));
    const notes = await store.snapshot(Buffer.from("notes\n"));
    const entries = [
      { artifactId: plan.artifactId, path: ".cc/run-docs/run-1/plan.md" },
      {
        artifactId: notes.artifactId,
        path: ".cc/run-docs/run-1/notes/today.md",
      },
    ];

    await store.materialize(worktree, entries);
    const copy = path.join(worktree, ".cc/run-docs/run-1/plan.md");
    expect(await readFile(copy, "utf8")).toBe("# Plan\n");
    expect(
      await readFile(
        path.join(worktree, ".cc/run-docs/run-1/notes/today.md"),
        "utf8",
      ),
    ).toBe("notes\n");
    expect((await stat(copy)).mode & 0o777).toBe(0o644);

    await writeFile(copy, "edited by an agent");
    expect(await readFile(copy, "utf8")).toBe("edited by an agent");
    expect((await store.read(plan.artifactId)).toString()).toBe("# Plan\n");
    for (const stored of objectFiles(root))
      expect((await stat(stored)).mode & 0o222).toBe(0);

    await store.materialize(worktree, entries);
    expect(await readFile(copy, "utf8")).toBe("# Plan\n");
    expect((await stat(copy)).mode & 0o777).toBe(0o644);
  });

  it("refuses a copy whose path is absolute or leaves the root", async () => {
    const store = createArtifactStore({ root });
    const plan = await store.snapshot(Buffer.from("# Plan\n"));

    await expect(
      store.materialize(worktree, [
        { artifactId: plan.artifactId, path: "../outside.md" },
      ]),
    ).rejects.toThrow(/inside/);
    await expect(
      store.materialize(worktree, [
        { artifactId: plan.artifactId, path: "/tmp/outside.md" },
      ]),
    ).rejects.toThrow(/inside/);
  });

  it("refuses to write through a linked directory, wherever it is on the way, and writes nothing there", async () => {
    const store = createArtifactStore({ root });
    const plan = await store.snapshot(Buffer.from("# Plan\n"));
    const elsewhere = await mkdtemp(
      path.join(tmpdir(), "cc-artifacts-elsewhere-"),
    );
    try {
      await mkdir(path.join(worktree, ".cc"), { recursive: true });
      await symlink(elsewhere, path.join(worktree, ".cc/run-docs"));
      await expect(
        store.materialize(worktree, [
          { artifactId: plan.artifactId, path: ".cc/run-docs/ctx/plan.md" },
        ]),
      ).rejects.toThrow(/link/);

      await rm(path.join(worktree, ".cc/run-docs"));
      await mkdir(path.join(worktree, ".cc/run-docs/ctx"), { recursive: true });
      await symlink(elsewhere, path.join(worktree, ".cc/run-docs/ctx/notes"));
      await expect(
        store.materialize(worktree, [
          {
            artifactId: plan.artifactId,
            path: ".cc/run-docs/ctx/notes/plan.md",
          },
        ]),
      ).rejects.toThrow(/link/);

      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("writes a copy whose name is near the filesystem's limit, whatever its temporary sibling is called", async () => {
    const store = createArtifactStore({ root });
    const plan = await store.snapshot(Buffer.from("# Plan\n"));
    const name = `${"x".repeat(237)}.md`;

    await store.materialize(worktree, [
      { artifactId: plan.artifactId, path: `.cc/run-docs/ctx/${name}` },
    ]);

    expect(existsSync(path.join(worktree, ".cc/run-docs/ctx", name))).toBe(
      true,
    );
  });
});
