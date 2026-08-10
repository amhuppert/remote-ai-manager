/**
 * The drift audit end to end against real git (R8.1): a shared lane worktree,
 * a real owned landing, and the production auditor reading what git actually
 * reports.
 *
 * The classifier's unit tests fix the attribution rules; this fixes the part
 * only git can answer — which paths a worktree reports as dirty after a landing,
 * how it names ignored and renamed ones, and that a sibling's legitimate
 * in-progress work is among them. The ignored cases matter most here, because
 * the way git collapses ignored directories is exactly what a hand-written fake
 * would get wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import {
  readIgnoredContents,
  type IgnoredEntry,
  type IgnoredWorktreeContents,
} from "@/lib/git/worktree";
import { commitOwnedPaths } from "@/lib/git/owned-landing";
import { createLaneDriftAuditor, summarizeIgnoredContents } from "./lane-drift";
import type {
  GraphWorkflowCanonicalOwnership,
  GraphWorkflowIgnoredBaselineEntry,
} from "./schemas";

const MEMBER_CONTEXT_IDS = ["context-api", "context-ui"];
const provisionedEntries = new WeakMap<
  readonly GraphWorkflowIgnoredBaselineEntry[],
  readonly IgnoredEntry[]
>();

function captureIgnoredBaseline(contents: IgnoredWorktreeContents) {
  const baseline = summarizeIgnoredContents(contents);
  provisionedEntries.set(baseline, contents.entries);
  return baseline;
}

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

describe("lane drift audit after a real owned landing (R8.1)", () => {
  const auditor = createLaneDriftAuditor();
  let lane: string;
  let canonicalLane: string;
  let members: GraphWorkflowCanonicalOwnership[];

  beforeEach(async () => {
    lane = await mkdtemp(path.join(tmpdir(), "cc-lane-drift-"));
    await git(lane, ["init", "--initial-branch=lane-shared", "."]);
    await git(lane, ["config", "user.email", "engine@command-center.test"]);
    await git(lane, ["config", "user.name", "Command Center"]);
    // `.cc/` matches what `ensureCcArtifactsExcluded` establishes for every
    // real worktree, so CC's artifacts are ignored here exactly as in production.
    await write(lane, ".gitignore", "*.log\nnode_modules/\n.cc/\n");
    await write(lane, "src/api/handler.ts", "api v1\n");
    await write(lane, "src/ui/panel.tsx", "ui v1\n");
    await git(lane, ["add", "-A"]);
    await git(lane, ["commit", "-m", "lane fork point"]);
    canonicalLane = await realpath(lane);
    members = [
      {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLane, "src/api")],
      },
      {
        mode: "owned",
        canonicalPrefixes: [path.join(canonicalLane, "src/ui")],
      },
    ];
  });

  afterEach(async () => {
    await rm(lane, { recursive: true, force: true });
  });

  /** Land the API member's work the way the engine does. */
  async function landApi(): Promise<void> {
    const result = await commitOwnedPaths({
      worktreePath: lane,
      message: "Graph workflow context context-api",
      ownedPaths: ["src/api"],
    });
    expect(result.status).toBe("committed");
  }

  function audit(overrides: Partial<Parameters<typeof auditor.audit>[0]> = {}) {
    const ignoredBaseline = overrides.ignoredBaseline ?? [];
    return auditor.audit({
      laneWorktreePath: lane,
      memberOwnerships: overrides.memberOwnerships ?? members,
      memberContextIds: overrides.memberContextIds ?? MEMBER_CONTEXT_IDS,
      ignoredBaseline,
      ignoredBaselineEntries:
        overrides.ignoredBaselineEntries !== undefined
          ? overrides.ignoredBaselineEntries
          : (provisionedEntries.get(ignoredBaseline) ??
            (ignoredBaseline.length === 0 ? [] : null)),
    });
  }

  it("reports nothing when a landing leaves only the sibling's own in-progress work behind", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "src/ui/panel.tsx", "ui wip\n");
    await write(lane, "src/ui/draft.tsx", "// sibling draft\n");
    await landApi();

    await expect(audit()).resolves.toEqual({ unattributedPaths: [] });
  });

  it("accepts a baselined install that nobody touched", async () => {
    await write(
      lane,
      "node_modules/pkg/index.js",
      "installed at provisioning\n",
    );
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );
    await write(lane, "src/api/handler.ts", "api v2\n");
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: [],
    });
  });

  it("reports an overwrite that keeps the file's exact size", async () => {
    await write(lane, "node_modules/pkg/index.js", "aaaaaaaa\n");
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "node_modules/pkg/index.js", "bbbbbbbb\n");
    // Pinned rather than raced: the sizes match by construction, so this does
    // not depend on filesystem timestamp granularity between two writes.
    const touched = path.join(lane, "node_modules/pkg/index.js");
    await utimes(touched, new Date(90_000_000), new Date(90_000_000));
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: ["node_modules"],
    });
  });

  it("reports a rename that moved a file OUT of every member's ownership", async () => {
    await git(lane, ["mv", "src/ui/panel.tsx", "vendor-panel.tsx"]);
    await write(lane, "src/api/handler.ts", "api v2\n");
    await landApi();

    // The source endpoint is the UI member's and attributes; the destination is
    // owned by nobody.
    await expect(audit()).resolves.toEqual({
      unattributedPaths: ["vendor-panel.tsx"],
    });
  });

  it("reports a rename whose DESTINATION is owned but whose source nobody declared", async () => {
    await write(lane, "vendor/legacy.ts", "legacy\n");
    await git(lane, ["add", "-A"]);
    await git(lane, ["commit", "-m", "vendor file predates the lane members"]);
    // The API member's move is still in flight; the UI sibling is the one that
    // lands, so git still reports the move as a rename pair rather than as a
    // committed destination plus a leftover deletion.
    await git(lane, ["mv", "vendor/legacy.ts", "src/api/adopted.ts"]);
    await write(lane, "src/ui/panel.tsx", "ui v2\n");
    const landed = await commitOwnedPaths({
      worktreePath: lane,
      message: "Graph workflow context context-ui",
      ownedPaths: ["src/ui"],
    });
    expect(landed.status).toBe("committed");
    expect(await git(lane, ["status", "--porcelain=v2", "-z"])).toContain(
      "2 R",
    );

    // Only the source endpoint is drift. Reading the destination alone — all
    // porcelain v1's `old -> new` line gives without re-parsing an ambiguous
    // encoding — would have called this landing clean.
    await expect(audit()).resolves.toEqual({
      unattributedPaths: ["vendor/legacy.ts"],
    });
  });
});
