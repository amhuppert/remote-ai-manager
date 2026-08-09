/**
 * The owned-landing path end to end against real git: a frozen ownership
 * envelope, the production lane committer, and a lane worktree that two
 * concurrent members share.
 *
 * The unit tests above the committer prove the routing decision; only real git
 * can prove the claim the decision exists for — that a sibling's in-progress
 * files are still sitting uncommitted and byte-identical after another member
 * lands.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import { createLaneCommitter } from "./lane-committer";

const CONTEXT_API = "context-api";
const CONTEXT_UI = "context-ui";

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

describe("owned landing through the lane committer (real git)", () => {
  let laneWorktree: string;
  let canonicalLaneWorktree: string;

  beforeEach(async () => {
    laneWorktree = await mkdtemp(path.join(tmpdir(), "cc-lane-landing-"));
    await git(laneWorktree, ["init", "--initial-branch=lane-shared", "."]);
    await git(laneWorktree, [
      "config",
      "user.email",
      "engine@command-center.test",
    ]);
    await git(laneWorktree, ["config", "user.name", "Command Center"]);
    await write(laneWorktree, "src/api/handler.ts", "export const a = 1;\n");
    await write(laneWorktree, "src/ui/panel.tsx", "export const Panel = 1;\n");
    await git(laneWorktree, ["add", "-A"]);
    await git(laneWorktree, ["commit", "-m", "lane fork point"]);
    // What the scheduler froze at admission: symlink-resolved absolute paths.
    canonicalLaneWorktree = await realpath(laneWorktree);
  });

  afterEach(async () => {
    await rm(laneWorktree, { recursive: true, force: true });
  });

  it("commits exactly the landing member's owned paths and leaves the sibling's work uncommitted and unmodified", async () => {
    const committer = createLaneCommitter();
    await write(laneWorktree, "src/api/handler.ts", "export const a = 2;\n");
    await write(laneWorktree, "src/api/added.ts", "export const added = 1;\n");
    // The sibling is mid-turn in the paths it owns.
    await write(
      laneWorktree,
      "src/ui/panel.tsx",
      "export const Panel = 'wip';\n",
    );
    await write(laneWorktree, "src/ui/draft.tsx", "// sibling draft\n");

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: CONTEXT_API,
      laneId: "lane-shared",
      laneWorktreePath: laneWorktree,
      preTurnHeadSha: await git(laneWorktree, ["rev-parse", "HEAD"]),
      landingToken: "token-api",
      ownership: {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLaneWorktree, "src/api")],
      },
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(await git(laneWorktree, ["rev-parse", "HEAD"])).toBe(
      result.snapshot.sha,
    );
    expect(
      (
        await git(laneWorktree, ["show", "--name-status", "--format=", "HEAD"])
      ).split("\n"),
    ).toEqual(["A\tsrc/api/added.ts", "M\tsrc/api/handler.ts"]);
    expect(await git(laneWorktree, ["log", "-1", "--format=%B"])).toContain(
      "Landing-Intent: token-api",
    );

    // The sibling's files: same bytes on disk, still absent from the branch.
    expect(
      await readFile(path.join(laneWorktree, "src/ui/panel.tsx"), "utf-8"),
    ).toBe("export const Panel = 'wip';\n");
    expect(await git(laneWorktree, ["show", "HEAD:src/ui/panel.tsx"])).toBe(
      "export const Panel = 1;",
    );
    const dirty = await git(laneWorktree, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(dirty).toContain("src/ui/panel.tsx");
    expect(dirty).toContain("src/ui/draft.tsx");
  });

  it("lands both members correctly when a sibling's landing moved lane HEAD in between", async () => {
    const committer = createLaneCommitter();
    const forkPoint = await git(laneWorktree, ["rev-parse", "HEAD"]);
    await write(laneWorktree, "src/api/handler.ts", "export const a = 2;\n");
    await write(laneWorktree, "src/ui/panel.tsx", "export const Panel = 2;\n");

    const first = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: CONTEXT_API,
      laneId: "lane-shared",
      laneWorktreePath: laneWorktree,
      preTurnHeadSha: forkPoint,
      landingToken: "token-api",
      ownership: {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLaneWorktree, "src/api")],
      },
    });
    // The UI member's baseline is the fork point; HEAD has moved past it.
    const second = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: CONTEXT_UI,
      laneId: "lane-shared",
      laneWorktreePath: laneWorktree,
      preTurnHeadSha: forkPoint,
      landingToken: "token-ui",
      ownership: {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLaneWorktree, "src/ui")],
      },
    });

    expect(first.status).toBe("committed");
    expect(second.status).toBe("committed");
    if (first.status !== "committed" || second.status !== "committed") return;

    // Two commits, each carrying only its own member's paths, stacked in order.
    expect(await git(laneWorktree, ["rev-parse", "HEAD"])).toBe(
      second.snapshot.sha,
    );
    expect(await git(laneWorktree, ["rev-parse", "HEAD~1"])).toBe(
      first.snapshot.sha,
    );
    expect(
      await git(laneWorktree, ["show", "--name-only", "--format=", "HEAD~1"]),
    ).toBe("src/api/handler.ts");
    expect(
      await git(laneWorktree, ["show", "--name-only", "--format=", "HEAD"]),
    ).toBe("src/ui/panel.tsx");
    // Both members' work survives on the branch — neither landing reverted the
    // other, which a stale-baseline commit would have done.
    expect(await git(laneWorktree, ["show", "HEAD:src/api/handler.ts"])).toBe(
      "export const a = 2;",
    );
    expect(await git(laneWorktree, ["show", "HEAD:src/ui/panel.tsx"])).toBe(
      "export const Panel = 2;",
    );
    expect(
      await git(laneWorktree, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]),
    ).not.toContain("??");
  });

  it("skips a read-only member's landing instead of sweeping its lane siblings' work into a commit", async () => {
    const committer = createLaneCommitter();
    const forkPoint = await git(laneWorktree, ["rev-parse", "HEAD"]);
    await write(laneWorktree, "src/api/handler.ts", "export const a = 9;\n");

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-reader",
      laneId: "lane-shared",
      laneWorktreePath: laneWorktree,
      preTurnHeadSha: forkPoint,
      ownership: { mode: "readOnly", canonicalPrefixes: [] },
    });

    expect(result).toEqual({ status: "skipped" });
    expect(await git(laneWorktree, ["rev-parse", "HEAD"])).toBe(forkPoint);
  });

  it("keeps the whole-tree commit for a full-access member, including paths no ownership names", async () => {
    const committer = createLaneCommitter();
    await write(laneWorktree, "src/api/handler.ts", "export const a = 3;\n");
    await write(laneWorktree, "src/ui/panel.tsx", "export const Panel = 3;\n");
    await write(laneWorktree, "README.md", "unowned\n");

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-full",
      laneId: "lane-shared",
      laneWorktreePath: laneWorktree,
      preTurnHeadSha: await git(laneWorktree, ["rev-parse", "HEAD"]),
      landingToken: "token-full",
      ownership: { mode: "full", canonicalPrefixes: [] },
    });

    expect(result.status).toBe("committed");
    expect(
      (
        await git(laneWorktree, ["show", "--name-only", "--format=", "HEAD"])
      ).split("\n"),
    ).toEqual(["README.md", "src/api/handler.ts", "src/ui/panel.tsx"]);
    expect(await git(laneWorktree, ["log", "-1", "--format=%B"])).toContain(
      "Landing-Intent: token-full",
    );
  });

  it("adopts the moved HEAD for a full-access member that committed its own work", async () => {
    const committer = createLaneCommitter();
    const forkPoint = await git(laneWorktree, ["rev-parse", "HEAD"]);
    await write(laneWorktree, "src/api/handler.ts", "export const a = 4;\n");
    await git(laneWorktree, ["add", "-A"]);
    await git(laneWorktree, ["commit", "-m", "implementer's own commit"]);
    const selfSha = await git(laneWorktree, ["rev-parse", "HEAD"]);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-full",
      laneId: "lane-shared",
      laneWorktreePath: laneWorktree,
      preTurnHeadSha: forkPoint,
      ownership: { mode: "full", canonicalPrefixes: [] },
    });

    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;
    expect(result.snapshot.sha).toBe(selfSha);
  });
});
