import { expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { defaultGitClient } from "./client";
import { createWorktreeOperations } from "./worktree";

it("merges successive edits to the same line without replaying delivered changes", async () => {
  const scratch = path.join(process.cwd(), ".cc/temp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "incremental-merge-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "session");
  const git = async (cwd: string, ...args: string[]) =>
    (await defaultGitClient.git(args, cwd)).stdout.trim();
  const ops = createWorktreeOperations(defaultGitClient);
  try {
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Merge Test");
    await git(repo, "config", "user.email", "merge@example.invalid");
    await writeFile(path.join(repo, "feature.txt"), "baseline\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "baseline");
    await git(repo, "worktree", "add", "-b", "feature", worktree);
    for (const version of ["first", "second"]) {
      await writeFile(path.join(worktree, "feature.txt"), `${version}\n`);
      await git(worktree, "add", ".");
      await git(worktree, "commit", "-m", version);
      expect(await ops.mergeTargetIntoFeature(worktree, "main")).toEqual({
        status: "clean",
      });
      const prepared = await ops.prepareSquashMerge({
        projectPath: repo,
        featureBranch: "feature",
        targetBranch: "main",
        featureSha: await git(worktree, "rev-parse", "HEAD"),
        targetSha: await git(repo, "rev-parse", "main"),
        message: `Deliver ${version}`,
        jobId: version,
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared")
        throw new Error("Expected prepared merge");
      const published = await ops.publishPreparedMerge({
        projectPath: repo,
        targetBranch: "main",
        ...prepared,
        cleanTargetWorktreePath: repo,
      });
      expect(published.kind).toBe("published");
      if (published.kind !== "published")
        throw new Error("Expected published merge");
      const before = await git(worktree, "rev-parse", "HEAD");
      await writeFile(path.join(worktree, "feature.txt"), "uncommitted work\n");
      await expect(
        ops.recordPublishedMerge(worktree, published.mergeHash),
      ).rejects.toThrow("uncommitted changes");
      expect(await git(worktree, "rev-parse", "HEAD")).toBe(before);
      expect(await readFile(path.join(worktree, "feature.txt"), "utf8")).toBe(
        "uncommitted work\n",
      );
      await writeFile(path.join(worktree, "feature.txt"), `${version}\n`);
      await ops.recordPublishedMerge(worktree, published.mergeHash);
      await git(
        worktree,
        "merge-base",
        "--is-ancestor",
        published.mergeHash,
        "HEAD",
      );
      expect(await readFile(path.join(repo, "feature.txt"), "utf8")).toBe(
        `${version}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
