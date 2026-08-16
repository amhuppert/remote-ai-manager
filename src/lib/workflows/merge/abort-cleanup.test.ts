import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { createActor, toPromise } from "xstate";
import { defaultGitClient } from "@/lib/git/client";
import { abortMergeCleanupActor } from "./actors";

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
  const repo = await mkdtemp(path.join(tmpdir(), "cc-abort-cleanup-"));
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

async function hasMergeHead(repo: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function runCleanup(worktreePath: string, openedMerge = true) {
  const actor = createActor(abortMergeCleanupActor, {
    input: { worktreePath, openedMerge },
  });
  actor.start();
  return toPromise(actor);
}

describe("abortMergeCleanupActor", () => {
  it("discards the conflicted merge the stopped run left open", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    expect(await hasMergeHead(repo)).toBe(true);

    expect(await runCleanup(repo)).toEqual({
      abortedMerge: true,
      preservedMerge: false,
    });

    expect(await hasMergeHead(repo)).toBe(false);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("leaves a tree with no merge of its own untouched", async () => {
    const repo = await createConflictedRepo();
    await writeFile(path.join(repo, "shared.txt"), "operator edit\n", "utf-8");

    expect(await runCleanup(repo)).toEqual({
      abortedMerge: false,
      preservedMerge: false,
    });

    expect(await git(repo, ["status", "--porcelain"])).toContain("shared.txt");
  });

  it("keeps a finished hand-resolution the run was about to commit", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    await writeFile(path.join(repo, "shared.txt"), "both sides\n", "utf-8");
    await git(repo, ["add", "shared.txt"]);

    expect(await runCleanup(repo)).toEqual({
      abortedMerge: false,
      preservedMerge: true,
    });

    expect(await hasMergeHead(repo)).toBe(true);
    expect(await git(repo, ["show", ":shared.txt"])).toBe("both sides");
  });

  it("keeps a conflicted merge the stopped run never opened", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();

    expect(await runCleanup(repo, false)).toEqual({
      abortedMerge: false,
      preservedMerge: true,
    });

    expect(await hasMergeHead(repo)).toBe(true);
    expect(await git(repo, ["diff", "--name-only", "--diff-filter=U"])).toBe(
      "shared.txt",
    );
  });

  it("reports no cleanup instead of failing when git cannot run", async () => {
    const missing = path.join(tmpdir(), "cc-abort-cleanup-missing-repo");

    expect(await runCleanup(missing)).toEqual({
      abortedMerge: false,
      preservedMerge: false,
    });
  });
});
