import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { defaultGitClient } from "./client";
import {
  containsConflictMarkers,
  inspectInProgressMerge,
  parseCheckOutputMarkerFiles,
  scanConflictArtifacts,
  scanStagingConflictArtifacts,
} from "./conflict-markers";

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
  const repo = await mkdtemp(path.join(tmpdir(), "cc-conflict-markers-"));
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

describe("containsConflictMarkers", () => {
  it("detects begin/end conflict markers at line start", () => {
    expect(
      containsConflictMarkers("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b"),
    ).toBe(true);
    expect(containsConflictMarkers("a\n>>>>>>> csm/branch\n")).toBe(true);
    expect(
      containsConflictMarkers("a\n||||||| merged common ancestors\n"),
    ).toBe(true);
  });

  it("does not flag a bare separator line (markdown setext heading)", () => {
    expect(containsConflictMarkers("Title\n=======\nbody text")).toBe(false);
  });

  it("does not flag marker-like text mid-line", () => {
    expect(containsConflictMarkers("const s = 'a <<<<<<< b';")).toBe(false);
  });
});

describe("parseCheckOutputMarkerFiles", () => {
  it("returns the files git flagged as carrying leftover conflict markers", () => {
    const output = [
      "src/lib/a.ts:1: leftover conflict marker",
      "src/lib/a.ts:3: leftover conflict marker",
      "docs/notes.md:2: leftover conflict marker",
      "",
    ].join("\n");

    expect(parseCheckOutputMarkerFiles(output)).toEqual([
      "src/lib/a.ts",
      "docs/notes.md",
    ]);
  });

  it("ignores whitespace findings, which are not conflict artifacts", () => {
    const output = [
      "src/lib/a.ts:12: trailing whitespace.",
      "src/lib/b.ts:4: space before tab in indent.",
    ].join("\n");

    expect(parseCheckOutputMarkerFiles(output)).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(parseCheckOutputMarkerFiles("")).toEqual([]);
  });
});

describe("inspectInProgressMerge", () => {
  it("reports no merge for a repo that is not mid-merge", async () => {
    const repo = await createConflictedRepo();

    expect(await inspectInProgressMerge(repo)).toEqual({ kind: "none" });
  });

  it("reports an unresolved merge while unmerged entries remain", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();

    const state = await inspectInProgressMerge(repo);

    expect(state.kind).toBe("unresolved");
    expect(
      state.kind === "unresolved" ? state.artifacts.unmergedFiles : [],
    ).toEqual(["shared.txt"]);
  });

  it("still reports unresolved when a staged resolution kept the markers", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    // Staged, so git no longer calls it unmerged — but the markers are still
    // in the file, and committing that would poison the branch.
    await git(repo, ["add", "shared.txt"]);

    const state = await inspectInProgressMerge(repo);

    expect(state.kind).toBe("unresolved");
    expect(
      state.kind === "unresolved" ? state.artifacts.markerFiles : [],
    ).toEqual(["shared.txt"]);
  });

  it("reports a resolved merge awaiting commit", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    await writeFile(path.join(repo, "shared.txt"), "both sides\n", "utf-8");
    await git(repo, ["add", "shared.txt"]);

    expect(await inspectInProgressMerge(repo)).toEqual({ kind: "resolved" });
  });
});

describe("scanConflictArtifacts", () => {
  it("finds markers left in the tree after the merge state itself is gone", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    // The resync that erased MERGE_HEAD and the unmerged entries while leaving
    // the marker-bearing file dirty (incident 3edd5fd7).
    await git(repo, ["reset", "--mixed", "--quiet", "HEAD"]);

    expect(await scanConflictArtifacts(repo)).toEqual({
      unmergedFiles: [],
      markerFiles: ["shared.txt"],
    });
    expect(await inspectInProgressMerge(repo)).toEqual({ kind: "none" });
  });

  it("finds markers in a changed file git reads as binary", async () => {
    const repo = await createConflictedRepo();
    // A NUL byte makes git's own scan skip the file entirely, so `--check`
    // reports nothing while the markers sit in the tree `git add -A` stages.
    await writeFile(
      path.join(repo, "shared.txt"),
      "<<<<<<< HEAD\nfeature side\n=======\nsibling side\n>>>>>>> sibling\n\0\n",
      "utf-8",
    );
    expect(
      (await git(repo, ["diff", "HEAD", "--numstat"])).split("\t")[0],
    ).toBe("-");

    expect(await scanConflictArtifacts(repo)).toEqual({
      unmergedFiles: [],
      markerFiles: ["shared.txt"],
    });
  });

  it("does not flag a dirty tree whose changes are marker-free", async () => {
    const repo = await createConflictedRepo();
    await writeFile(path.join(repo, "notes.md"), "Title\n=======\nbody\n");

    expect(await scanConflictArtifacts(repo)).toEqual({
      unmergedFiles: [],
      markerFiles: [],
    });
  });

  it("leaves an untracked marker-bearing file out of the merge's own reading", async () => {
    const repo = await createConflictedRepo();
    await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();
    await writeFile(path.join(repo, "shared.txt"), "both sides\n", "utf-8");
    await git(repo, ["add", "shared.txt"]);
    // A merge-tool backup: full of markers, but the merge itself is resolved,
    // and a caller that read this as unresolved would abort the resolution.
    await writeFile(
      path.join(repo, "shared.txt.orig"),
      "<<<<<<< HEAD\nfeature side\n=======\nsibling side\n>>>>>>> sibling\n",
      "utf-8",
    );

    expect(await scanConflictArtifacts(repo)).toEqual({
      unmergedFiles: [],
      markerFiles: [],
    });
    expect(await inspectInProgressMerge(repo)).toEqual({ kind: "resolved" });
  });
});

describe("scanStagingConflictArtifacts", () => {
  it("finds markers in an untracked file, which `git add -A` would stage", async () => {
    const repo = await createConflictedRepo();
    await writeFile(
      path.join(repo, "new-file.ts"),
      "<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> sibling\n",
      "utf-8",
    );

    expect(await scanStagingConflictArtifacts(repo)).toEqual({
      unmergedFiles: [],
      markerFiles: ["new-file.ts"],
    });
  });

  it("does not flag untracked files that carry no markers", async () => {
    const repo = await createConflictedRepo();
    await writeFile(path.join(repo, "notes.md"), "Title\n=======\nbody\n");

    expect(await scanStagingConflictArtifacts(repo)).toEqual({
      unmergedFiles: [],
      markerFiles: [],
    });
  });
});
