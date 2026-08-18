import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "./client";
import {
  commitOwnedPaths,
  createOwnedLandingOperations,
  worktreeMatchesHead,
} from "./owned-landing";

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await defaultGitClient.git(args, repo);
  return stdout.trim();
}

async function write(
  repo: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = path.join(repo, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

/** Repo with two disjoint ownership islands already committed. */
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "cc-owned-landing-"));
  await git(repo, ["init", "--initial-branch=lane", "."]);
  await git(repo, ["config", "user.email", "engine@command-center.test"]);
  await git(repo, ["config", "user.name", "Command Center"]);
  await write(repo, "src/api/handler.ts", "export const a = 1;\n");
  await write(repo, "src/api/legacy.ts", "export const legacy = true;\n");
  await write(repo, "src/ui/panel.tsx", "export const Panel = null;\n");
  await write(repo, "README.md", "root\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base"]);
  return repo;
}

describe("commitOwnedPaths", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("commits exactly the owned paths — modifications, deletions, and new files — while a sibling's uncommitted changes stay uncommitted and unmodified", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 2;\n");
    await write(repo, "src/api/added.ts", "export const added = true;\n");
    await rm(path.join(repo, "src/api/legacy.ts"));
    // The sibling's in-progress work, in the paths it owns.
    await write(repo, "src/ui/panel.tsx", "export const Panel = 'wip';\n");
    await write(repo, "src/ui/scratch.tsx", "// sibling scratch\n");

    const result = await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api\n\nLanding-Intent: token-1",
      ownedPaths: ["src/api"],
    });

    expect(result.status).toBe("committed");

    const committed = (
      await git(repo, ["show", "--name-status", "--format=", "HEAD"])
    ).split("\n");
    expect(committed.sort()).toEqual(
      ["A\tsrc/api/added.ts", "D\tsrc/api/legacy.ts", "M\tsrc/api/handler.ts"]
        .slice()
        .sort(),
    );

    // The sibling's files are untouched on disk and still uncommitted.
    expect(await readFile(path.join(repo, "src/ui/panel.tsx"), "utf-8")).toBe(
      "export const Panel = 'wip';\n",
    );
    const dirty = await git(repo, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(dirty).toContain("src/ui/panel.tsx");
    expect(dirty).toContain("src/ui/scratch.tsx");
    expect(await git(repo, ["show", "HEAD:src/ui/panel.tsx"])).toBe(
      "export const Panel = null;",
    );
  });

  it("cannot let pre-staged sibling paths in the shared index ride into an owned commit, and leaves that staged state intact", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 3;\n");
    await write(repo, "src/ui/panel.tsx", "export const Panel = 'staged';\n");
    await write(repo, "README.md", "staged root\n");
    await git(repo, ["add", "src/ui/panel.tsx", "README.md"]);

    const result = await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    expect(result.status).toBe("committed");
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "src/api/handler.ts",
    );
    // The commit was built without reading the shared index, so the sibling's
    // staged blobs are byte-identical to what it staged and still staged. The
    // landed path is absent from the list: the only entries the landing wrote
    // back are its own, and those now match the commit it published.
    const staged = await git(repo, ["diff", "--cached", "--name-only", "HEAD"]);
    expect(staged.split("\n").sort()).toEqual([
      "README.md",
      "src/ui/panel.tsx",
    ]);
    expect(await git(repo, ["show", ":src/ui/panel.tsx"])).toBe(
      "export const Panel = 'staged';",
    );
    expect(await git(repo, ["show", ":README.md"])).toBe("staged root");
  });

  it("points the shared index at the new HEAD for the paths it landed, and at nothing else", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 8;\n");
    await write(repo, "src/api/added.ts", "export const added = true;\n");
    await rm(path.join(repo, "src/api/legacy.ts"));
    await write(repo, "src/ui/panel.tsx", "export const Panel = 'wip';\n");
    const siblingEntryBefore = await git(repo, ["ls-files", "-s", "src/ui"]);

    await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    // All three staleness shapes are gone: the modified path's entry holds the
    // landed blob, the added path has an entry at all, the deleted path has
    // none. Left as they were, git would describe committed work as pending
    // and produce no diff to go with it.
    expect(await git(repo, ["diff", "--cached", "--name-only", "HEAD"])).toBe(
      "",
    );
    // Outside the landing's own prefixes not one entry moved — those belong to
    // a sibling using the same index.
    expect(await git(repo, ["ls-files", "-s", "src/ui"])).toBe(
      siblingEntryBefore,
    );
    expect(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"]))
        .split("\n")
        .sort(),
    ).toEqual(["src/api/added.ts", "src/api/handler.ts", "src/api/legacy.ts"]);
  });

  it("leaves the tree reading as HEAD's once the landing is the only thing that happened, added and deleted paths included", async () => {
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await write(repo, "src/api/handler.ts", "export const a = 8;\n");
    await write(repo, "src/api/added.ts", "export const added = true;\n");
    await rm(path.join(repo, "src/api/legacy.ts"));

    await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    // A whole-tree committer running next has nothing to do.
    expect(await worktreeMatchesHead(repo)).toBe(true);

    // Same answer with the index rewound behind HEAD the way a failed resync
    // would leave it, in all three shapes at once — a modified path whose old
    // blob it holds, an added path it has no entry for, a deleted path it
    // still lists. The reader compares the worktree against HEAD instead of
    // trusting the index, which is what makes the resync safe to be
    // best-effort.
    await git(repo, ["reset", "--quiet", base, "--", "src/api"]);
    expect(await worktreeMatchesHead(repo)).toBe(true);
  });

  it("keeps the landing published when the index resync fails", async () => {
    const landing = createOwnedLandingOperations({
      git: (args, cwd, options) =>
        args.includes("reset")
          ? Promise.reject(
              new Error("Unable to create index.lock: File exists"),
            )
          : defaultGitClient.git(args, cwd, options),
    });
    await write(repo, "src/api/handler.ts", "export const a = 10;\n");

    const result = await landing.commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    // The resync runs after the ref update, so its failure can only leave an
    // index to repair later — never a landing the caller has to treat as
    // failed and halt on, over work that is already on the branch.
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(result.hash);
    expect(await worktreeMatchesHead(repo)).toBe(true);
  });

  it("reports the tree as differing while a sibling still holds uncommitted work of its own", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 8;\n");
    await write(repo, "src/ui/panel.tsx", "export const Panel = 'wip';\n");

    await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    expect(await worktreeMatchesHead(repo)).toBe(false);
  });

  it("carries the landing message verbatim, including its trailer", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 4;\n");

    const result = await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api\n\nLanding-Intent: token-abc",
      ownedPaths: ["src/api"],
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(await git(repo, ["log", "-1", "--format=%B"])).toBe(
      "Graph workflow context ctx-api\n\nLanding-Intent: token-abc",
    );
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(result.hash);
  });

  it("reports no-changes without creating a commit when nothing under ownership changed, even while siblings are dirty", async () => {
    const before = await git(repo, ["rev-parse", "HEAD"]);
    await write(repo, "src/ui/panel.tsx", "export const Panel = 'wip';\n");
    await write(repo, "README.md", "root changed\n");

    const result = await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    expect(result).toEqual({ status: "no-changes" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("lands when an owned prefix names a path that exists in neither the tree nor the worktree", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 5;\n");

    const result = await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api", "docs/not-created-yet.md"],
    });

    expect(result.status).toBe("committed");
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "src/api/handler.ts",
    );
  });

  it("treats owned paths as literal bytes, so pathspec magic and glob metacharacters in a name land the named path only", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 6;\n");
    await write(repo, ":(top)/magic.txt", "magic\n");
    await write(repo, "star*dir/globbed.txt", "globbed\n");
    await write(repo, "stardir/decoy.txt", "decoy\n");

    const result = await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-magic",
      ownedPaths: [":(top)", "star*dir"],
    });

    expect(result.status).toBe("committed");
    expect(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"]))
        .split("\n")
        .sort(),
    ).toEqual([":(top)/magic.txt", "star*dir/globbed.txt"]);
    // Neither the sibling island nor the glob-shaped decoy was swept in.
    const dirty = await git(repo, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(dirty).toContain("stardir/decoy.txt");
    expect(dirty).toContain("src/api/handler.ts");
  });

  it("leaves no private index file behind in the git directory", async () => {
    await write(repo, "src/api/handler.ts", "export const a = 7;\n");

    await commitOwnedPaths({
      worktreePath: repo,
      message: "Graph workflow context ctx-api",
      ownedPaths: ["src/api"],
    });

    const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"]);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(gitDir);
    expect(entries.filter((name) => name.includes("cc-landing"))).toEqual([]);
  });
});
