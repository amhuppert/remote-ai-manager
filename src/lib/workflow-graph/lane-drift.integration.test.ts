/**
 * The drift audit end to end against real git (R8.1): a shared lane worktree,
 * a real owned landing, and the production auditor reading what git actually
 * reports.
 *
 * The classifier's unit tests fix the attribution rules; this fixes the part
 * only git can answer — which paths a worktree reports as dirty after a
 * landing, how it names renamed ones, which of them it leaves out because the
 * ignore rules cover them, and that a sibling's legitimate in-progress work is
 * among them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "@/lib/git/client";
import { commitOwnedPaths } from "@/lib/git/owned-landing";
import { createLaneDriftAuditor } from "./lane-drift";
import type { GraphWorkflowCanonicalOwnership } from "./schemas";


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
    await write(
      lane,
      ".gitignore",
      "*.log\nnode_modules/\n.cc/\n*.tsbuildinfo\n",
    );
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
    return auditor.audit({
      laneWorktreePath: lane,
      memberOwnerships: overrides.memberOwnerships ?? members,
    });
  }

  it("reports nothing when a landing leaves only the sibling's own in-progress work behind", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "src/ui/panel.tsx", "ui wip\n");
    await write(lane, "src/ui/draft.tsx", "// sibling draft\n");
    await landApi();

    await expect(audit()).resolves.toEqual({ unattributedPaths: [] });
  });

  it("reports nothing when the toolchain rewrites gitignored content around a landing", async () => {
    await write(lane, "node_modules/pkg/index.js", "installed\n");
    await write(lane, "tsconfig.tsbuildinfo", '{"version":1}\n');
    await write(lane, "src/api/handler.ts", "api v2\n");
    await landApi();
    // What a validation run does to a lane worktree: an install adds a package
    // file, an incremental typecheck rewrites its build info in place.
    await write(lane, "node_modules/pkg/postinstall.js", "generated\n");
    await write(lane, "tsconfig.tsbuildinfo", '{"version":2}\n');

    await expect(audit()).resolves.toEqual({ unattributedPaths: [] });
  });

  it("still reports an unattributed tracked change while gitignored content churns around it", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "scripts/deploy.sh", "#!/bin/sh\n");
    await landApi();
    await write(lane, "node_modules/pkg/postinstall.js", "generated\n");

    await expect(audit()).resolves.toEqual({
      unattributedPaths: ["scripts/deploy.sh"],
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
