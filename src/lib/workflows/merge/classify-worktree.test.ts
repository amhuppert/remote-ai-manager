import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { defaultGitClient } from "@/lib/git/client";
import { classifyWorktreeEntry } from "./actors";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await defaultGitClient.git(args, repo);
  return stdout.trim();
}

/** A repo whose checked-out branch conflicts with `sibling` on `shared.txt`. */
async function createConflictedRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "cc-classify-worktree-"));
  cleanupPaths.push(repo);
  await git(repo, ["init", "--initial-branch=feature", "."]);
  await git(repo, ["config", "user.email", "engine@command-center.test"]);
  await git(repo, ["config", "user.name", "Command Center"]);
  await writeFile(path.join(repo, "shared.txt"), "base\n", "utf-8");
  await git(repo, ["add", "shared.txt"]);
  await git(repo, ["commit", "-m", "base"]);

  await git(repo, ["checkout", "-b", "sibling"]);
  await writeFile(path.join(repo, "shared.txt"), "sibling side\n", "utf-8");
  await git(repo, ["commit", "-am", "sibling change"]);

  await git(repo, ["checkout", "feature"]);
  await writeFile(path.join(repo, "shared.txt"), "feature side\n", "utf-8");
  await git(repo, ["commit", "-am", "feature change"]);
  return repo;
}

describe("classifyWorktreeEntry", () => {
  it("reads a committed tree as clean", async () => {
    const repo = await createConflictedRepo();

    expect(await classifyWorktreeEntry(repo)).toEqual({ kind: "clean" });
  });

  it("reads ordinary uncommitted work as dirty", async () => {
    const repo = await createConflictedRepo();
    await writeFile(path.join(repo, "shared.txt"), "edited\n", "utf-8");

    expect(await classifyWorktreeEntry(repo)).toEqual({ kind: "dirty" });
  });

  it("reads an untracked file as dirty (git add -A would commit it)", async () => {
    const repo = await createConflictedRepo();
    await writeFile(path.join(repo, "notes.md"), "Title\n=======\nbody\n");

    expect(await classifyWorktreeEntry(repo)).toEqual({ kind: "dirty" });
  });

  it("reads a conflicted merge as mid-merge with unresolved work", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();

    expect(await classifyWorktreeEntry(repo)).toEqual({
      kind: "mid-merge",
      unresolved: true,
    });
  });

  it("reads a staged resolution that kept its markers as unresolved", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    await git(repo, ["add", "shared.txt"]);

    expect(await classifyWorktreeEntry(repo)).toEqual({
      kind: "mid-merge",
      unresolved: true,
    });
  });

  it("reads a finished hand-resolution awaiting commit as mid-merge, resolved", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    await writeFile(path.join(repo, "shared.txt"), "both sides\n", "utf-8");
    await git(repo, ["add", "shared.txt"]);

    expect(await classifyWorktreeEntry(repo)).toEqual({
      kind: "mid-merge",
      unresolved: false,
    });
  });

  it("reads the post-resync tree whose markers outlived MERGE_HEAD as poisoned", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    await git(repo, ["reset", "--mixed", "--quiet", "HEAD"]);

    expect(await classifyWorktreeEntry(repo)).toEqual({
      kind: "poisoned",
      artifacts: { unmergedFiles: [], markerFiles: ["shared.txt"] },
    });
  });
});
