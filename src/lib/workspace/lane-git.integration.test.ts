/**
 * The lane Git port against real repositories: a project with a session
 * worktree and a lane worktree beside it, as provisioning leaves them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import {
  createLaneGit,
  publicationMarker,
  landingMarker,
  type LaneGit,
  type LaneGitDeps,
} from "./lane-git";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await defaultGitClient.git(args, cwd)).stdout.trim();
}

/** Tracked changes, staged or not, and untracked files that are not ignored. */
async function dirtyPaths(worktree: string): Promise<string[]> {
  const { stdout } = await defaultGitClient.git(
    ["status", "--porcelain", "--untracked-files=all"],
    worktree,
  );
  return stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3));
}

async function write(
  root: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

let project: string;
let session: string;
let lane: string;
let lanes: LaneGit;
let sessionJob: ReturnType<LaneGitDeps["sessionJob"]>;
const laneBranch = "session-1-api";
const sessionBranch = "session";

function laneGitDeps(): LaneGitDeps {
  return {
    git: defaultGitClient,
    exists: existsSync,
    writeFile: (filePath, content) => writeFile(filePath, content, "utf-8"),
    worktrees: {
      async provisionLaneAt(input, { worktreePath, branchName }) {
        // Like the real provisioning: a worktree already on its branch is adopted.
        if (!existsSync(worktreePath))
          await git(input.projectPath, [
            "worktree",
            "add",
            "-b",
            branchName,
            worktreePath,
            input.sessionBranch,
          ]);
        return { worktreePath, branchName };
      },
      async disposeLane(input) {
        await git(input.projectPath, [
          "worktree",
          "remove",
          "--force",
          input.worktreePath,
        ]);
        await git(input.projectPath, ["branch", "-D", input.branchName]);
        return { status: "removed" };
      },
    },
    acquireSessionLock: () => () => {},
    isSessionBusy: () => sessionJob !== null,
    sessionJob: () => sessionJob,
  };
}

beforeEach(async () => {
  // An apostrophe in every path: Git quotes paths in its messages with apostrophes.
  project = await realpath(
    await mkdtemp(path.join(tmpdir(), "cc-lane-git-owner's-")),
  );
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
  sessionJob = null;
  lanes = createLaneGit(laneGitDeps());
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
  await lanes.mergeInto({
    worktreePath: lane,
    commit: head,
    message: "merge head",
  });
}

describe("lane git", () => {
  it("lands only a scope's paths as one marked commit, and finds it by its marker", async () => {
    await write(lane, "src/api/route.ts", "export const route = 2;\n");
    await write(lane, "src/api/new.ts", "export const added = 1;\n");
    await write(lane, "src/shared.ts", "export const shared = 2;\n");
    const marker = landingMarker("ctx-a:accept:1");

    const landed = await lanes.land({
      worktreePath: lane,
      paths: ["src/api"],
      message: `Accept ctx-a\n\n${marker}`,
    });
    expect(landed.kind).toBe("committed");
    expect(await git(lane, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "src/api/new.ts\nsrc/api/route.ts",
    );
    expect(await dirtyPaths(lane)).toEqual(["src/shared.ts"]);
    expect(
      await lanes.findMarked({
        projectPath: project,
        branch: laneBranch,
        marker,
      }),
    ).toBe(landed.kind === "committed" ? landed.commit : null);
    expect(
      await lanes.findMarked({
        projectPath: project,
        branch: laneBranch,
        marker: landingMarker("other"),
      }),
    ).toBeNull();

    expect(
      await lanes.land({
        worktreePath: lane,
        paths: ["src/api"],
        message: "again",
      }),
    ).toEqual({
      kind: "unchanged",
      head: await git(lane, ["rev-parse", "HEAD"]),
    });
  });

  it("lands everything for a full scope, new files included and ignored files left out", async () => {
    await write(lane, "docs/notes.md", "notes\n");
    await write(lane, "debug.log", "noise\n");
    await lanes.land({
      worktreePath: lane,
      paths: null,
      message: "Accept full",
    });
    expect(await git(lane, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "docs/notes.md",
    );
    expect(await dirtyPaths(lane)).toEqual([]);
  });

  it("names conflicting files and leaves no merge behind; merges cleanly otherwise", async () => {
    await write(lane, "src/shared.ts", "export const shared = 'lane';\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane edit" });
    await write(session, "src/shared.ts", "export const shared = 'session';\n");
    await git(session, ["commit", "-am", "session edit"]);
    const head = await lanes.head(project, sessionBranch);

    expect(
      await lanes.mergeInto({
        worktreePath: lane,
        commit: head,
        message: "merge",
      }),
    ).toEqual({
      kind: "conflicts",
      files: ["src/shared.ts"],
    });
    expect(await dirtyPaths(lane)).toEqual([]);

    await write(session, "src/shared.ts", "export const shared = 'lane';\n");
    await git(session, ["commit", "-am", "agree"]);
    expect(
      await lanes.mergeInto({
        worktreePath: lane,
        commit: await lanes.head(project, sessionBranch),
        message: "merge",
      }),
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

  it("publishes the lane onto the checked session head as one marked commit and brings the session worktree to it", async () => {
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
    expect(
      await readFile(path.join(session, "src/api/route.ts"), "utf-8"),
    ).toBe("export const route = 3;\n");
    expect(await dirtyPaths(session)).toEqual([]);
    expect(
      await lanes.findMarked({
        projectPath: project,
        branch: sessionBranch,
        marker,
      }),
    ).toBe(commit);

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

  it("does not publish onto a session head that moved", async () => {
    await write(lane, "src/api/route.ts", "export const route = 4;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const checked = await lanes.head(project, sessionBranch);
    await write(session, "README.md", "owner\n");
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
    expect(result).toEqual({
      kind: "stale",
      head: await lanes.head(project, sessionBranch),
    });
  });

  it("removes a published lane, but keeps one holding work beyond its publication", async () => {
    await write(lane, "src/api/route.ts", "export const route = 5;\n");
    await lanes.land({ worktreePath: lane, paths: null, message: "lane work" });
    const published = await lanes.publish(
      publishInput(
        await lanes.head(project, sessionBranch),
        "run-1-publish-api-5",
      ),
    );
    const commit = published.kind === "published" ? published.commit : "";
    const removal = {
      projectPath: project,
      worktreePath: lane,
      branch: laneBranch,
      published: commit,
    };

    await write(lane, "notes.md", "written after the publication\n");
    expect(await lanes.remove(removal)).toEqual({
      kind: "kept",
      detail: expect.stringContaining("notes.md"),
    });
    await rm(path.join(lane, "notes.md"));
    await write(lane, "src/api/route.ts", "export const route = 6;\n");
    await git(lane, ["commit", "-qam", "follow-up"]);
    expect(await lanes.remove(removal)).toEqual({
      kind: "kept",
      detail: expect.stringContaining(commit),
    });
    expect(await readFile(path.join(lane, "src/api/route.ts"), "utf-8")).toBe(
      "export const route = 6;\n",
    );

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
    expect(result).toEqual({
      kind: "blocked",
      detail: expect.stringContaining("experiment"),
    });
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

  it("reads a lane's unlanded changes without its index, and resyncs a stale index for landed paths", async () => {
    await write(lane, "src/api/route.ts", "export const route = 8;\n");
    await lanes.land({
      worktreePath: lane,
      paths: ["src/api"],
      message: "landed",
    });
    // As a crash between the branch move and the index resync leaves it.
    await git(lane, [
      "update-index",
      "--cacheinfo",
      `100644,${await git(lane, ["rev-parse", "HEAD~1:src/api/route.ts"])},src/api/route.ts`,
    ]);
    expect(await dirtyPaths(lane)).toEqual(["src/api/route.ts"]);
    expect(await lanes.unlandedPaths(lane)).toEqual([]);
    await lanes.resyncIndex({ worktreePath: lane, paths: ["src/api"] });
    expect(await dirtyPaths(lane)).toEqual([]);

    // A landed new file the index never learned of is landed all the same; a stray one is not.
    await write(lane, "src/api/new.ts", "export const added = 2;\n");
    await lanes.land({
      worktreePath: lane,
      paths: ["src/api"],
      message: "landed new",
    });
    await git(lane, ["rm", "-q", "--cached", "src/api/new.ts"]);
    await write(lane, "stray.md", "not landed\n");
    expect(await lanes.unlandedPaths(lane)).toEqual(["stray.md"]);
  });

  it("takes a session's Git lock when it is free, and names the CC job holding it otherwise", () => {
    expect(lanes.trySessionLock(project, "session")).toMatchObject({
      kind: "held",
    });
    sessionJob = { jobId: "job-7", jobType: "commit" };
    expect(lanes.trySessionLock(project, "session")).toEqual({
      kind: "busy",
      job: { jobId: "job-7", jobType: "commit" },
    });
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
    expect(await readFile(path.join(lane, "src/shared.ts"), "utf-8")).toBe(
      "export const shared = 'both';\n",
    );
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
    await git(project, [
      "worktree",
      "add",
      "-q",
      "-b",
      "session-1-ui",
      half,
      sessionBranch,
    ]);
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

/**
 * Publication merges the prepared commit into the session worktree, which
 * holds whatever the owner and session contexts left uncommitted (design
 * 2026-10-14 §2.2, premise P5).
 */
describe("lane publication beside uncommitted session work", () => {
  const publishInput = (expectedHead: string, jobId: string) => ({
    projectPath: project,
    sessionName: "session",
    laneBranch,
    targetBranch: sessionBranch,
    targetWorktreePath: session,
    expectedHead,
    message: `Publish lane 1-api\n\n${publicationMarker(jobId)}`,
    jobId,
  });

  /** Commits the lane's work, as landing does, and merges the session head into it. */
  async function laneWork(change: () => Promise<void>): Promise<string> {
    await change();
    await git(lane, ["add", "-A", "--force"]);
    await git(lane, ["commit", "-q", "-m", "lane work"]);
    const head = await lanes.head(project, sessionBranch);
    await mergeLaneHead(head);
    return head;
  }

  /** The session branch, index and worktree as Git reports them. */
  async function sessionState() {
    return {
      branch: await lanes.head(project, sessionBranch),
      index: await git(session, ["ls-files", "--stage"]),
      status: await git(session, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
      ]),
      unstaged: await git(session, ["diff"]),
      staged: await git(session, ["diff", "--cached"]),
    };
  }

  const read = (relative: string) =>
    readFile(path.join(session, relative), "utf-8");

  it("publishes beside unrelated staged, unstaged and untracked work, keeping all of it", async () => {
    const head = await laneWork(async () => {
      await write(lane, "src/api/route.ts", "export const route = 9;\n");
      await write(lane, "src/api/new.ts", "export const added = 9;\n");
    });
    await write(session, "src/shared.ts", "export const shared = 'owner';\n");
    await write(session, "notes.md", "staged by the owner\n");
    await git(session, ["add", "notes.md"]);
    await write(session, "scratch.md", "untracked\n");
    await write(session, "debug.log", "ignored\n");

    const published = await lanes.publish(publishInput(head, "job-beside"));
    expect(published.kind).toBe("published");
    const commit = published.kind === "published" ? published.commit : "";
    expect(await lanes.head(project, sessionBranch)).toBe(commit);
    expect(await read("src/api/route.ts")).toBe("export const route = 9;\n");
    expect(await read("src/api/new.ts")).toBe("export const added = 9;\n");
    expect(await read("src/shared.ts")).toBe(
      "export const shared = 'owner';\n",
    );
    expect(await read("scratch.md")).toBe("untracked\n");
    expect(await read("debug.log")).toBe("ignored\n");
    expect(await git(session, ["diff", "--cached", "--name-only"])).toBe(
      "notes.md",
    );
    expect((await dirtyPaths(session)).sort()).toEqual([
      "notes.md",
      "scratch.md",
      "src/shared.ts",
    ]);
  });

  it("publishes over a lane file the owner touched without changing it", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 10;\n"),
    );
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(session, "src/api/route.ts"), later, later);

    expect(
      await lanes.publish(publishInput(head, "job-touched")),
    ).toMatchObject({ kind: "published" });
    expect(await read("src/api/route.ts")).toBe("export const route = 10;\n");
  });

  const refusals: Array<{
    what: string;
    lane: () => Promise<void>;
    session: () => Promise<void>;
    path: string;
  }> = [
    {
      what: "a local change to a file the lane changes",
      lane: () => write(lane, "src/api/route.ts", "export const route = 11;\n"),
      session: () =>
        write(session, "src/api/route.ts", "export const route = 'owner';\n"),
      path: "src/api/route.ts",
    },
    {
      what: "a staged change to a file the lane changes",
      lane: () => write(lane, "src/api/route.ts", "export const route = 12;\n"),
      session: async () => {
        await write(session, "src/api/route.ts", "export const staged = 1;\n");
        await git(session, ["add", "src/api/route.ts"]);
      },
      path: "src/api/route.ts",
    },
    {
      what: "an untracked file at a path the lane adds",
      lane: () => write(lane, "src/api/new.ts", "export const lane = 1;\n"),
      session: () => write(session, "src/api/new.ts", "owner draft\n"),
      path: "src/api/new.ts",
    },
    {
      what: "an ignored file at a path the lane adds",
      lane: () => write(lane, "local.log", "defaults\n"),
      session: () => write(session, "local.log", "the owner's own settings\n"),
      path: "local.log",
    },
    {
      what: "an ignored file at a parent path of a file the lane adds",
      lane: () => write(lane, "cache.log/data.txt", "lane data\n"),
      session: () => write(session, "cache.log", "the owner's cache\n"),
      path: "cache.log",
    },
    {
      what: "an ignored dangling symlink at a path the lane adds",
      lane: () => write(lane, "link.log", "lane\n"),
      session: () =>
        symlink("/nonexistent/cc-target", path.join(session, "link.log")),
      path: "link.log",
    },
    {
      what: "an owner's edit to a file the lane deletes",
      lane: () => rm(path.join(lane, "src/shared.ts")),
      session: () =>
        write(session, "src/shared.ts", "export const shared = 'owner';\n"),
      path: "src/shared.ts",
    },
    {
      what: "an owner's edit to a file the lane renames",
      lane: async () => {
        await git(lane, ["mv", "src/shared.ts", "src/moved.ts"]);
      },
      session: () =>
        write(session, "src/shared.ts", "export const shared = 'owner';\n"),
      path: "src/shared.ts",
    },
  ];

  it.each(refusals)(
    "refuses $what, naming it and leaving the branch, index and worktree as they were",
    async ({ lane: change, session: prepare, path: inTheWay }) => {
      const head = await laneWork(change);
      await prepare();
      const before = await sessionState();

      expect(await lanes.publish(publishInput(head, "job-refused"))).toEqual({
        kind: "blocked",
        detail: expect.stringContaining(inTheWay),
      });
      expect(await sessionState()).toEqual(before);
    },
  );

  it("keeps an untracked or ignored file it refused to overwrite", async () => {
    const head = await laneWork(() => write(lane, "local.log", "defaults\n"));
    await write(session, "local.log", "the owner's own settings\n");
    await lanes.publish(publishInput(head, "job-kept"));
    expect(await read("local.log")).toBe("the owner's own settings\n");
  });

  /** Where Git keeps `name` for the worktree, as `git rev-parse --git-path` resolves it. */
  const gitPath = async (worktree: string, name: string) =>
    path.resolve(
      worktree,
      await git(worktree, ["rev-parse", "--git-path", name]),
    );

  it("reports the session's held index lock, under a path with an apostrophe, as one to wait out, changing nothing", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 13;\n"),
    );
    const lock = await gitPath(session, "index.lock");
    expect(lock).toContain("'");
    await writeFile(lock, "");
    const before = await sessionState();

    expect(await lanes.publish(publishInput(head, "job-locked"))).toEqual({
      kind: "git_locked",
      lock,
    });
    expect(await sessionState()).toEqual(before);
    expect(lanes.lockHeld(lock)).toBe(true);

    await rm(lock);
    expect(lanes.lockHeld(lock)).toBe(false);
    expect(await lanes.publish(publishInput(head, "job-locked"))).toMatchObject(
      { kind: "published" },
    );
  });

  it("waits out the session branch's held ref lock, which refuses after the merge staged the lane's files, and publishes once it is gone", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 19;\n"),
    );
    const lock = await gitPath(session, `refs/heads/${sessionBranch}.lock`);
    await writeFile(lock, "");

    expect(await lanes.publish(publishInput(head, "job-ref-locked"))).toEqual({
      kind: "git_locked",
      lock,
    });
    expect(await lanes.head(project, sessionBranch)).toBe(head);
    expect(await git(session, ["diff", "--cached", "--name-only"])).toBe(
      "src/api/route.ts",
    );

    await rm(lock);
    const published = await lanes.publish(publishInput(head, "job-ref-locked"));
    expect(published.kind).toBe("published");
    expect(await read("src/api/route.ts")).toBe("export const route = 19;\n");
    expect(await dirtyPaths(session)).toEqual([]);
  });

  it("tells a branch named index's ref lock from the worktree's index lock", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 20;\n"),
    );
    const indexTree = path.join(project, ".worktrees", "index");
    await git(project, [
      "worktree",
      "add",
      "-q",
      "-b",
      "index",
      indexTree,
      head,
    ]);
    const refLock = await gitPath(indexTree, "refs/heads/index.lock");
    expect(refLock).not.toBe(await gitPath(indexTree, "index.lock"));
    await writeFile(refLock, "");

    expect(
      await lanes.publish({
        ...publishInput(head, "job-index-branch"),
        targetBranch: "index",
        targetWorktreePath: indexTree,
      }),
    ).toEqual({ kind: "git_locked", lock: refLock });
    expect(await lanes.head(project, "index")).toBe(head);
  });

  it("fails on any other lock Git cannot take, and on the index lock when the reason is not that it exists", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 21;\n"),
    );
    const other = await gitPath(session, "ORIG_HEAD.lock");
    await writeFile(other, "");
    expect(await lanes.publish(publishInput(head, "job-other-lock"))).toEqual({
      kind: "failed",
      detail: expect.stringContaining("ORIG_HEAD.lock"),
    });
    expect(await lanes.head(project, sessionBranch)).toBe(head);
    await rm(other);

    // Git's own words for a lock it may not create, through a client that answers the merge with them.
    const lock = await gitPath(session, "index.lock");
    const denied = createLaneGit({
      ...laneGitDeps(),
      git: {
        async git(args, cwd, options) {
          if (args.includes("--ff-only"))
            throw Object.assign(new Error("Command failed: git merge"), {
              stderr: `fatal: Unable to create '${lock}': Permission denied\n`,
            });
          return defaultGitClient.git(args, cwd, options);
        },
      },
    });
    expect(await denied.publish(publishInput(head, "job-denied"))).toEqual({
      kind: "failed",
      detail: expect.stringContaining("Permission denied"),
    });
  });

  it("publishes even when the session branch is configured to squash merges", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 14;\n"),
    );
    await git(project, [
      "config",
      `branch.${sessionBranch}.mergeOptions`,
      "--squash",
    ]);
    await git(project, ["config", "merge.ff", "false"]);

    const published = await lanes.publish(publishInput(head, "job-squash"));
    expect(published.kind).toBe("published");
    const commit = published.kind === "published" ? published.commit : "";
    expect(await lanes.head(project, sessionBranch)).toBe(commit);
    expect(await git(session, ["rev-parse", "HEAD"])).toBe(commit);
    expect(await dirtyPaths(session)).toEqual([]);
  });

  it("publishes a new attempt after one stopped between writing the index and moving the branch", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 15;\n"),
    );
    const laneHead = await lanes.head(project, laneBranch);
    // As the interrupted merge leaves it: the lane's files in the index and worktree, the branch unmoved.
    await git(session, ["read-tree", "-m", "-u", head, `${laneHead}^{tree}`]);
    expect(await lanes.head(project, sessionBranch)).toBe(head);

    const published = await lanes.publish(publishInput(head, "job-replay"));
    expect(published.kind).toBe("published");
    expect(await read("src/api/route.ts")).toBe("export const route = 15;\n");
    expect(await dirtyPaths(session)).toEqual([]);
  });

  /** Lane Git whose publication merge runs the given hooks, as only a test may ask. */
  async function withHook(name: string, script: string): Promise<LaneGit> {
    const hooks = path.join(project, "test-hooks");
    await mkdir(hooks, { recursive: true });
    const hook = path.join(hooks, name);
    await writeFile(hook, `#!/bin/sh\n${script}\n`, "utf-8");
    await chmod(hook, 0o755);
    return createLaneGit({ ...laneGitDeps(), mergeHooksPath: hooks });
  }

  it("is stale when an owner commit lands between the merge's index write and its branch move, the commit carrying the lane's content", async () => {
    const head = await laneWork(async () => {
      await write(lane, "src/api/route.ts", "export const route = 16;\n");
      await rm(path.join(lane, "src/shared.ts"));
    });
    await write(session, "notes.md", "the owner's unstaged note\n");
    const racing = await withHook(
      "post-index-change",
      [
        `marker="$(git rev-parse --git-path cc-owner-committed)"`,
        `[ -e "$marker" ] && exit 0`,
        `: > "$marker"`,
        `git commit -q --no-verify -m "owner commit" >/dev/null 2>&1`,
        `exit 0`,
      ].join("\n"),
    );

    const owner = await racing.publish(publishInput(head, "job-race"));
    const moved = await lanes.head(project, sessionBranch);
    expect(owner).toEqual({ kind: "stale", head: moved });
    expect(await git(project, ["log", "-1", "--format=%s", moved])).toBe(
      "owner commit",
    );
    expect(await git(project, ["rev-parse", `${moved}^`])).toBe(head);
    expect(await git(project, ["show", `${moved}:src/api/route.ts`])).toBe(
      "export const route = 16;",
    );
    await expect(
      git(project, ["cat-file", "-e", `${moved}:src/shared.ts`]),
    ).rejects.toThrow();
    expect(await read("notes.md")).toBe("the owner's unstaged note\n");
  });

  it("publishes when Git dies after moving the branch to the publication, whatever its exit", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 22;\n"),
    );
    const dying = await withHook("post-merge", "kill -TERM $PPID");

    const published = await dying.publish(publishInput(head, "job-killed"));
    expect(published.kind).toBe("published");
    const commit = published.kind === "published" ? published.commit : "";
    expect(await lanes.head(project, sessionBranch)).toBe(commit);
    expect(await git(project, ["rev-parse", `${commit}^`])).toBe(head);
  });

  it("fails, naming the head it found, when the merge succeeds without moving the branch to the publication", async () => {
    const head = await laneWork(() =>
      write(lane, "src/api/route.ts", "export const route = 17;\n"),
    );
    const undoing = await withHook(
      "post-merge",
      `git update-ref refs/heads/${sessionBranch} ${head}`,
    );

    expect(await undoing.publish(publishInput(head, "job-undone"))).toEqual({
      kind: "failed",
      detail: expect.stringContaining(head),
    });
  });
});
