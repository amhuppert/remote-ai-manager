/**
 * A full-access lane member has to land exactly as it always did, even after an
 * enveloped sibling landed in the same worktree first (R7.2).
 *
 * The owned landing builds its commit out of band, so the only thing that can
 * carry its effects into a later whole-tree commit is the shared worktree
 * itself. That makes this a real-git claim rather than a fake-git one: the
 * failure it guards against is git reporting paths as dirty that the whole-tree
 * committer then finds nothing to commit for.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import { resyncSharedIndexToHead } from "@/lib/git/shared-index";
import { createLaneCommitter } from "./lane-committer";

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

describe("full-access landing parity after an enveloped sibling landed (R7.2)", () => {
  const committer = createLaneCommitter();
  let lane: string;
  let canonicalLane: string;

  function input(contextId: string) {
    return {
      projectPath: "/projects/demo",
      sessionName: "demo",
      contextId,
      laneId: "lane-shared",
      laneWorktreePath: lane,
      landingToken: `cc-landing:exec-1:${contextId}:1`,
    };
  }

  beforeEach(async () => {
    lane = await mkdtemp(path.join(tmpdir(), "cc-landing-parity-"));
    canonicalLane = await realpath(lane);
    await git(lane, ["init", "--initial-branch=lane-shared", "."]);
    await git(lane, ["config", "user.email", "engine@command-center.test"]);
    await git(lane, ["config", "user.name", "Command Center"]);
    await write(lane, "src/api/handler.ts", "api v1\n");
    await write(lane, "src/ui/panel.tsx", "ui v1\n");
    await git(lane, ["add", "-A"]);
    await git(lane, ["commit", "-m", "lane fork point"]);
  });

  afterEach(async () => {
    await rm(lane, { recursive: true, force: true });
  });

  /** The enveloped member's landing, which every case here starts from. */
  async function landOwnedSibling(): Promise<void> {
    await write(lane, "src/api/handler.ts", "api v2\n");
    const result = await committer.commit({
      ...input("context-api"),
      preTurnHeadSha: await git(lane, ["rev-parse", "HEAD"]),
      ownership: {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLane, "src/api")],
      },
    });
    expect(result.status).toBe("committed");
  }

  it("leaves the shared index exactly as it found it, staged sibling state included (D7)", async () => {
    // A sibling stages work of its own mid-turn, which is the state D7 exists
    // to protect: nothing about a landing may read or write this index.
    await write(lane, "src/ui/panel.tsx", "ui staged\n");
    await git(lane, ["add", "src/ui/panel.tsx"]);
    const stagedSiblingBlob = await git(lane, [
      "rev-parse",
      ":src/ui/panel.tsx",
    ]);

    await landOwnedSibling();

    // The landing published through a PRIVATE index, so the shared index still
    // holds the pre-landing blob for the path that just landed — git reports it
    // as differing from the new HEAD. That staleness is the contract, not a
    // defect: the alternative is a write to the one index a sibling is using.
    expect(
      (await git(lane, ["diff", "--cached", "--name-only"])).split("\n"),
    ).toContain("src/api/handler.ts");
    // And the sibling's staged blob is byte-identical to what it staged.
    expect(await git(lane, ["rev-parse", ":src/ui/panel.tsx"])).toBe(
      stagedSiblingBlob,
    );
  });

  it("skips, rather than failing, when the full-access member changed nothing of its own", async () => {
    await landOwnedSibling();
    const preTurnHeadSha = await git(lane, ["rev-parse", "HEAD"]);

    const result = await committer.commit({
      ...input("context-full"),
      preTurnHeadSha,
      ownership: { mode: "full", canonicalPrefixes: [] },
    });

    expect(result).toEqual({ status: "skipped" });
    expect(await git(lane, ["rev-parse", "HEAD"])).toBe(preTurnHeadSha);
  });

  it.each([
    { shape: "modified", act: () => write(lane, "src/api/handler.ts", "v2\n") },
    { shape: "added", act: () => write(lane, "src/api/added.ts", "new\n") },
    {
      shape: "deleted",
      act: () => rm(path.join(lane, "src/api/handler.ts")),
    },
  ])(
    "skips after a sibling landed a $shape path, which the shared index still describes the old way",
    async ({ act }) => {
      // Each shape leaves the index wrong in a different direction: a stale
      // blob, a missing entry, a lingering entry. All three have to read as
      // "nothing of mine to commit".
      await act();
      const landed = await committer.commit({
        ...input("context-api"),
        preTurnHeadSha: await git(lane, ["rev-parse", "HEAD"]),
        ownership: {
          mode: "owned",
          canonicalPrefixes: [path.join(canonicalLane, "src/api")],
        },
      });
      expect(landed.status).toBe("committed");
      const preTurnHeadSha = await git(lane, ["rev-parse", "HEAD"]);

      const result = await committer.commit({
        ...input("context-full"),
        preTurnHeadSha,
        ownership: { mode: "full", canonicalPrefixes: [] },
      });

      expect(result).toEqual({ status: "skipped" });
      expect(await git(lane, ["rev-parse", "HEAD"])).toBe(preTurnHeadSha);
    },
  );

  it("adopts the moved HEAD when the full-access member committed its own work during the turn", async () => {
    await landOwnedSibling();
    const preTurnHeadSha = await git(lane, ["rev-parse", "HEAD"]);
    await write(lane, "src/ui/panel.tsx", "ui v2\n");
    await git(lane, ["commit", "-am", "agent self-commit"]);
    const selfCommit = await git(lane, ["rev-parse", "HEAD"]);

    const result = await committer.commit({
      ...input("context-full"),
      preTurnHeadSha,
      ownership: { mode: "full", canonicalPrefixes: [] },
    });

    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;
    expect(result.snapshot.sha).toBe(selfCommit);
  });

  it("keeps a sibling's newly ADDED file through a self-commit, which the shared index has no entry for", async () => {
    // The one shape of index staleness a self-commit turns into data loss. The
    // owned landing put a path into HEAD that the shared index never learned
    // about, and `git commit -a` builds its commit FROM that index — so the
    // commit the agent makes publishes the file's deletion, silently reverting
    // a sibling's landed work. Only an added path does this: a stale blob or a
    // lingering entry survives `commit -a` as an ordinary modification.
    await write(lane, "src/api/added.ts", "added by the owner\n");
    const landed = await committer.commit({
      ...input("context-api"),
      preTurnHeadSha: await git(lane, ["rev-parse", "HEAD"]),
      ownership: {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLane, "src/api")],
      },
    });
    expect(landed.status).toBe("committed");
    expect(await git(lane, ["ls-files", "--", "src/api/added.ts"])).toBe("");

    // Handing the lane to a whole-tree writer is what repairs the index. It is
    // not part of the landing (which must never touch the shared index) — it is
    // the engine preparing the worktree for a member that owns all of it.
    const preTurnHeadSha = await git(lane, ["rev-parse", "HEAD"]);
    await resyncSharedIndexToHead(lane);

    await write(lane, "src/ui/panel.tsx", "ui v2\n");
    await git(lane, ["commit", "-am", "agent self-commit"]);
    const selfCommit = await git(lane, ["rev-parse", "HEAD"]);

    const result = await committer.commit({
      ...input("context-full"),
      preTurnHeadSha,
      ownership: { mode: "full", canonicalPrefixes: [] },
    });

    // The sibling's file survived, and the self-commit was ADOPTED rather than
    // followed by a restoration commit carrying different evidence (R7.2).
    expect(await git(lane, ["show", "HEAD:src/api/added.ts"])).toBe(
      "added by the owner",
    );
    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;
    expect(result.snapshot.sha).toBe(selfCommit);
  });

  it("whole-tree commits its own uncommitted work, trailer included, without re-landing the sibling's paths", async () => {
    await landOwnedSibling();
    const preTurnHeadSha = await git(lane, ["rev-parse", "HEAD"]);
    await write(lane, "src/ui/panel.tsx", "ui v2\n");

    const result = await committer.commit({
      ...input("context-full"),
      preTurnHeadSha,
      ownership: { mode: "full", canonicalPrefixes: [] },
    });

    expect(result.status).toBe("committed");
    expect(await git(lane, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "src/ui/panel.tsx",
    );
    expect(await git(lane, ["log", "-1", "--format=%B"])).toBe(
      "Graph workflow context context-full\n\nLanding-Intent: cc-landing:exec-1:context-full:1",
    );
  });
});
