/**
 * The lane Git port against real repositories: a project with a session
 * worktree and a lane worktree beside it, as provisioning leaves them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import { createLaneGit, publicationMarker, landingMarker, type LaneGit } from "./lane-git";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await defaultGitClient.git(args, cwd)).stdout.trim();
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

let project: string;
let session: string;
let lane: string;
let lanes: LaneGit;
const laneBranch = "session-1-api";
const sessionBranch = "session";

beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), "cc-lane-git-")));
  await git(project, ["init", "--initial-branch=main", "."]);
  await git(project, ["config", "user.email", "engine@command-center.test"]);
  await git(project, ["config", "user.name", "Command Center"]);
  await write(project, ".gitignore", "*.log\n");
  await write(project, "src/api/route.ts", "export const route = 1;\n");
  await write(project, "src/shared.ts", "export const shared = 1;\n");
  await git(project, ["add", "-A"]);
  await git(project, ["commit", "-m", "base"]);
  session = path.join(project, ".worktrees", "session");
  lane = path.join(project, ".worktrees", "session.1-api");
  await git(project, ["worktree", "add", "-b", sessionBranch, session, "main"]);
  lanes = createLaneGit({
    git: defaultGitClient,
    exists: existsSync,
    writeFile: (filePath, content) => writeFile(filePath, content, "utf-8"),
    worktrees: {
      async provisionLaneAt(input, { worktreePath, branchName }) {
        // Like the real provisioning: a worktree already on its branch is adopted.
        if (!existsSync(worktreePath))
          await git(input.projectPath, ["worktree", "add", "-b", branchName, worktreePath, input.sessionBranch]);
        return { worktreePath, branchName };
      },
      async disposeLane(input) {
        await git(input.projectPath, ["worktree", "remove", "--force", input.worktreePath]);
        await git(input.projectPath, ["branch", "-D", input.branchName]);
        return { status: "removed" };
      },
    },
    acquireSessionLock: () => () => {},
    isSessionBusy: () => false,
  });
  await lanes.provision({
    projectPath: project,
    sessionName: "session",
    sessionWorktreePath: session,
    laneId: "1-api",
    worktreePath: lane,
    branch: laneBranch,
    base: await lanes.head(project, sessionBranch),
  });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

/** What integration leaves before publication: the lane merged with the session head. */
async function mergeLaneHead(head: string): Promise<void> {
  await lanes.mergeInto({ worktreePath: lane, commit: head, message: "merge head" });
}

describe("lane git", () => {
  it("lands only a scope's paths as one marked commit, and finds it by its marker", async () => {
    await write(lane, "src/api/route.ts", "export const route = 2;\n");
    await write(lane, "src/api/new.ts", "export const added = 1;\n");
    await write(lane, "src/shared.ts", "export const shared = 2;\n");
    const marker = landingMarker("ctx-a:accept:1");

    const landed = await lanes.land({ worktreePath: lane, paths: ["src/api"], message: `Accept ctx-a\n\n${marker}` });
    expect(landed.kind).toBe("committed");
    expect(await git(lane, ["show", "--name-only", "--format=", "HEAD"])).toBe("src/api/new.ts\nsrc/api/route.ts");
    expect(await lanes.dirtyPaths(lane)).toEqual(["src/shared.ts"]);
    expect(await lanes.findMarked({ projectPath: project, branch: laneBranch, marker })).toBe(
      landed.kind === "committed" ? landed.commit : null,
    );
    expect(await lanes.findMarked({ projectPath: project, branch: laneBranch, marker: landingMarker("other") })).toBeNull();

    expect(await lanes.land({ worktreePath: lane, paths: ["src/api"], message: "again" })).toEqual({
      kind: "unchanged",
      head: await git(lane, ["rev-parse", "HEAD"]),
    });
  });

  it("lands everything for a full scope, new files included and ignored files left out", async () => {
    await write(lane, "docs/notes.md", "notes\n");
    await write(lane, "debug.log", "noise\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "Accept full" });
    expect(await git(lane, ["show", "--name-only", "--format=", "HEAD"])).toBe("docs/notes.md");
    expect(await lanes.dirtyPaths(lane)).toEqual([]);
  });

  it("names conflicting files and leaves no merge behind; merges cleanly otherwise", async () => {
    await write(lane, "src/shared.ts", "export const shared = 'lane';\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane edit" });
    await write(session, "src/shared.ts", "export const shared = 'session';\n");
    await git(session, ["commit", "-am", "session edit"]);
    const head = await lanes.head(project, sessionBranch);

    expect(await lanes.mergeInto({ worktreePath: lane, commit: head, message: "merge" })).toEqual({
      kind: "conflicts",
      files: ["src/shared.ts"],
    });
    expect(await lanes.dirtyPaths(lane)).toEqual([]);

    await write(session, "src/shared.ts", "export const shared = 'lane';\n");
    await git(session, ["commit", "-am", "agree"]);
    expect(
      await lanes.mergeInto({ worktreePath: lane, commit: await lanes.head(project, sessionBranch), message: "merge" }),
    ).toEqual({ kind: "merged" });
  });

  it("publishes nothing for a lane with no work", async () => {
    const head = await lanes.head(project, sessionBranch);
    expect(
      await lanes.publish({
        projectPath: project,
        sessionName: "session",
        laneBranch,
        targetBranch: sessionBranch,
        targetWorktreePath: session,
        expectedHead: head,
        message: "Publish",
        jobId: "run-1-publish-api-0",
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("publishes the lane onto the checked session head as one marked commit and refreshes the session worktree", async () => {
    await write(lane, "src/api/route.ts", "export const route = 3;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const head = await lanes.head(project, sessionBranch);
    const marker = publicationMarker("run-1:publish:api:1");

    const published = await lanes.publish({
      projectPath: project,
      sessionName: "session",
      laneBranch,
      targetBranch: sessionBranch,
      targetWorktreePath: session,
      expectedHead: head,
      message: `Publish lane 1-api\n\n${marker}`,
      jobId: "run-1-publish-api-1",
    });
    expect(published.kind).toBe("published");
    const commit = published.kind === "published" ? published.commit : "";
    expect(await lanes.head(project, sessionBranch)).toBe(commit);
    expect(await git(project, ["rev-parse", `${commit}^`])).toBe(head);
    expect(await readFile(path.join(session, "src/api/route.ts"), "utf-8")).toBe("export const route = 3;\n");
    expect(await lanes.dirtyPaths(session)).toEqual([]);
    expect(await lanes.findMarked({ projectPath: project, branch: sessionBranch, marker })).toBe(commit);

    // The squash is not in the lane's history, so the lane cannot publish onto it again.
    expect(
      await lanes.publish({
        projectPath: project,
        sessionName: "session",
        laneBranch,
        targetBranch: sessionBranch,
        targetWorktreePath: session,
        expectedHead: commit,
        message: "again",
        jobId: "run-1-publish-api-2",
      }),
    ).toMatchObject({ kind: "failed" });
  });

  it("does not publish onto a session head that moved, and sees untracked session files as dirt", async () => {
    await write(lane, "src/api/route.ts", "export const route = 4;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const checked = await lanes.head(project, sessionBranch);
    await write(session, "README.md", "owner\n");
    expect(await lanes.dirtyPaths(session)).toEqual(["README.md"]);
    await git(session, ["add", "README.md"]);
    await git(session, ["commit", "-m", "owner commit"]);

    const result = await lanes.publish({
      projectPath: project,
      sessionName: "session",
      laneBranch,
      targetBranch: sessionBranch,
      targetWorktreePath: session,
      expectedHead: checked,
      message: "Publish",
      jobId: "run-1-publish-api-3",
    });
    expect(result).toEqual({ kind: "stale", head: await lanes.head(project, sessionBranch) });
  });

  it("removes a published lane, but keeps one holding work beyond its publication", async () => {
    await write(lane, "src/api/route.ts", "export const route = 5;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const published = await lanes.publish(publishInput(await lanes.head(project, sessionBranch), "run-1-publish-api-5"));
    const commit = published.kind === "published" ? published.commit : "";
    const removal = { projectPath: project, worktreePath: lane, branch: laneBranch, published: commit };

    await write(lane, "notes.md", "written after the publication\n");
    expect(await lanes.remove(removal)).toEqual({ kind: "kept", detail: expect.stringContaining("notes.md") });
    await rm(path.join(lane, "notes.md"));
    await write(lane, "src/api/route.ts", "export const route = 6;\n");
    await git(lane, ["commit", "-qam", "follow-up"]);
    expect(await lanes.remove(removal)).toEqual({ kind: "kept", detail: expect.stringContaining(commit) });
    expect(await readFile(path.join(lane, "src/api/route.ts"), "utf-8")).toBe("export const route = 6;\n");

    await git(lane, ["reset", "-q", "--hard", "HEAD~1"]);
    expect(await lanes.remove(removal)).toEqual({ kind: "removed" });
    await expect(lanes.head(project, laneBranch)).rejects.toThrow();
  });

  const publishInput = (expectedHead: string, jobId: string) => ({
    projectPath: project,
    sessionName: "session",
    laneBranch,
    targetBranch: sessionBranch,
    targetWorktreePath: session,
    expectedHead,
    message: "Publish",
    jobId,
  });

  it("refuses to publish into a session worktree that has another branch checked out", async () => {
    await write(lane, "src/api/route.ts", "export const route = 5;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const head = await lanes.head(project, sessionBranch);
    await mergeLaneHead(head);
    await git(session, ["checkout", "-q", "-b", "experiment"]);
    await write(session, "notes.md", "experiment\n");
    await git(session, ["add", "notes.md"]);
    await git(session, ["commit", "-q", "-m", "experiment work"]);
    const experiment = await git(session, ["rev-parse", "HEAD"]);

    const result = await lanes.publish(publishInput(head, "job-branch"));
    expect(result).toEqual({ kind: "blocked", detail: expect.stringContaining("experiment") });
    expect(await git(session, ["rev-parse", "HEAD"])).toBe(experiment);
    expect(await lanes.head(project, sessionBranch)).toBe(head);
  });

  it("refuses a session holding a merge in progress, and a lane that no longer contains the checked head", async () => {
    const head = await lanes.head(project, sessionBranch);
    await write(lane, "src/api/route.ts", "export const route = 6;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    // The lane was never merged with the head it is publishing onto, once that head moved.
    await write(session, "src/shared.ts", "export const shared = 'owner';\n");
    await git(session, ["commit", "-q", "-am", "owner"]);
    const moved = await lanes.head(project, sessionBranch);
    expect(await lanes.publish(publishInput(moved, "job-ancestry"))).toEqual({
      kind: "failed",
      detail: expect.stringContaining(moved),
    });
    expect(head).not.toBe(moved);
  });

  it("finishes a publication whose branch moved but whose worktree was never refreshed, and refuses one that changed since", async () => {
    await write(lane, "src/api/route.ts", "export const route = 7;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const head = await lanes.head(project, sessionBranch);
    await mergeLaneHead(head);
    const published = await lanes.publish(publishInput(head, "job-crash"));
    const commit = published.kind === "published" ? published.commit : "";
    // As a crash between the branch move and the refresh leaves it: the worktree still at the old head.
    await git(session, ["reset", "-q", "--hard", head]);
    await git(session, ["update-ref", `refs/heads/${sessionBranch}`, commit]);

    expect(await lanes.completePublication({ targetWorktreePath: session, from: head, to: commit })).toBe("refreshed");
    expect(await readFile(path.join(session, "src/api/route.ts"), "utf-8")).toBe("export const route = 7;\n");
    expect(await lanes.completePublication({ targetWorktreePath: session, from: head, to: commit })).toBe("complete");

    await git(session, ["reset", "-q", "--hard", head]);
    await git(session, ["update-ref", `refs/heads/${sessionBranch}`, commit]);
    await write(session, "after-crash.md", "new work\n");
    expect(await lanes.completePublication({ targetWorktreePath: session, from: head, to: commit })).toBe("diverged");
    expect(await readFile(path.join(session, "after-crash.md"), "utf-8")).toBe("new work\n");
  });

  it("refuses to publish over an ignored session file at a path the lane starts tracking, in publication and in recovery", async () => {
    await write(session, "local.log", "the owner's own settings\n");
    await write(lane, ".gitignore", "");
    await write(lane, "local.log", "defaults\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "track local.log" });
    const head = await lanes.head(project, sessionBranch);

    expect(await lanes.publish(publishInput(head, "job-ignored"))).toEqual({
      kind: "blocked",
      detail: expect.stringContaining("local.log"),
    });
    expect(await lanes.head(project, sessionBranch)).toBe(head);
    expect(await readFile(path.join(session, "local.log"), "utf-8")).toBe("the owner's own settings\n");

    // As a crash between the branch move and the refresh would leave it, had the file appeared meanwhile.
    await rm(path.join(session, "local.log"));
    const published = await lanes.publish(publishInput(head, "job-ignored-2"));
    const commit = published.kind === "published" ? published.commit : "";
    await git(session, ["reset", "-q", "--hard", head]);
    await git(session, ["update-ref", `refs/heads/${sessionBranch}`, commit]);
    await write(session, "local.log", "the owner's own settings\n");
    expect(await lanes.completePublication({ targetWorktreePath: session, from: head, to: commit })).toBe("diverged");
    expect(await readFile(path.join(session, "local.log"), "utf-8")).toBe("the owner's own settings\n");
  });

  it("reads a lane's unlanded changes without its index, and resyncs a stale index for landed paths", async () => {
    await write(lane, "src/api/route.ts", "export const route = 8;\n");
    await lanes.land({ worktreePath: lane, paths: ["src/api"], message: "landed" });
    // As a crash between the branch move and the index resync leaves it.
    await git(lane, ["update-index", "--cacheinfo", `100644,${await git(lane, ["rev-parse", "HEAD~1:src/api/route.ts"])},src/api/route.ts`]);
    expect(await lanes.dirtyPaths(lane)).toEqual(["src/api/route.ts"]);
    expect(await lanes.unlandedPaths(lane)).toEqual([]);
    await lanes.resyncIndex({ worktreePath: lane, paths: ["src/api"] });
    expect(await lanes.dirtyPaths(lane)).toEqual([]);

    // A landed new file the index never learned of is landed all the same; a stray one is not.
    await write(lane, "src/api/new.ts", "export const added = 2;\n");
    await lanes.land({ worktreePath: lane, paths: ["src/api"], message: "landed new" });
    await git(lane, ["rm", "-q", "--cached", "src/api/new.ts"]);
    await write(lane, "stray.md", "not landed\n");
    expect(await lanes.unlandedPaths(lane)).toEqual(["stray.md"]);
  });

  it("tells whether a session's Git lock is free", () => {
    expect(lanes.trySessionLock(project, "session")).not.toBeNull();
  });

  it("undoes an unresolved merge but keeps one whose resolution is staged", async () => {
    await write(lane, "src/shared.ts", "export const shared = 'lane';\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane edit" });
    await write(session, "src/shared.ts", "export const shared = 'session';\n");
    await git(session, ["commit", "-q", "-am", "session edit"]);
    const head = await lanes.head(project, sessionBranch);
    const open = async () => {
      await git(lane, ["merge", "--no-edit", head]).catch(() => "");
    };

    await open();
    expect(await lanes.abortUnresolvedMerge(lane)).toBe("aborted");
    expect(await lanes.mergeInProgress(lane)).toBe(false);

    await open();
    await write(lane, "src/shared.ts", "export const shared = 'both';\n");
    await git(lane, ["add", "src/shared.ts"]);
    expect(await lanes.abortUnresolvedMerge(lane)).toBe("kept");
    expect(await lanes.mergeInProgress(lane)).toBe(true);
    expect(await readFile(path.join(lane, "src/shared.ts"), "utf-8")).toBe("export const shared = 'both';\n");
  });

  it("adopts a provisioned lane again, and refuses one whose setup never finished", async () => {
    const again = await lanes.provision({
      projectPath: project,
      sessionName: "session",
      sessionWorktreePath: session,
      laneId: "1-api",
      worktreePath: lane,
      branch: laneBranch,
      base: await lanes.head(project, sessionBranch),
    });
    expect(again).toEqual({ baseline: await git(lane, ["rev-parse", "HEAD"]) });

    // As a server stopping during the init script leaves it: the worktree exists, its setup does not.
    const half = path.join(project, ".worktrees", "session.1-ui");
    await git(project, ["worktree", "add", "-q", "-b", "session-1-ui", half, sessionBranch]);
    await expect(
      lanes.provision({
        projectPath: project,
        sessionName: "session",
        sessionWorktreePath: session,
        laneId: "1-ui",
        worktreePath: half,
        branch: "session-1-ui",
        base: await lanes.head(project, sessionBranch),
      }),
    ).rejects.toThrow(/never finished/);
    expect(await git(project, ["worktree", "list"])).toContain(half);
  });
});
