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
  chmod,
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
const CONTEXT_API_PAYLOAD = ".cc/temp/context-api";

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

  it("reports a change in paths no member owns — the server-mediated write the sandbox cannot see", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "scripts/deploy.sh", "#!/bin/sh\n");
    await landApi();

    await expect(audit()).resolves.toEqual({
      unattributedPaths: ["scripts/deploy.sh"],
    });
  });

  it("reports an ignored write the lane was not provisioned with, and accepts the ones it was", async () => {
    await write(
      lane,
      "node_modules/pkg/index.js",
      "installed at provisioning\n",
    );
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "credentials.log", "leaked\n");
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: ["credentials.log"],
    });
  });

  it("reports a write INSIDE a directory the baseline already covers, which git reports as that directory either way", async () => {
    await write(
      lane,
      "node_modules/pkg/index.js",
      "installed at provisioning\n",
    );
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );
    // git names this exactly as it named the pre-existing install: one entry,
    // `node_modules/`. Only the contents underneath tell the two apart.
    expect(ignoredBaseline.map((entry) => entry.path)).toEqual([
      "node_modules",
    ]);

    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "node_modules/leak.env", "AWS_SECRET=…\n");
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: ["node_modules"],
    });
  });

  it("reports an OVERWRITE of a file the baseline already covers, which adds no new path at all", async () => {
    await write(
      lane,
      "node_modules/pkg/index.js",
      "installed at provisioning\n",
    );
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    // Same path, different bytes: a name-only baseline cannot see this.
    await write(lane, "node_modules/pkg/index.js", "AWS_SECRET=…\n");
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: ["node_modules"],
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

  it("reports replacement of an ignored file whose contents are unreadable at both provisioning and audit", async () => {
    const target = path.join(lane, "node_modules/pkg/private.bin");
    await write(lane, "node_modules/pkg/private.bin", "before\n");
    await chmod(target, 0o000);
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await rm(target);
    await write(lane, "node_modules/pkg/private.bin", "after!\n");
    await chmod(target, 0o000);
    await write(lane, "src/api/handler.ts", "api v2\n");
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: ["node_modules"],
    });
  });

  it("reports the DELETION of the last ignored file under a baselined directory", async () => {
    await write(
      lane,
      "node_modules/pkg/index.js",
      "installed at provisioning\n",
    );
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    // The directory stops existing as ignored content entirely, so nothing at
    // audit time carries the baseline's name — it has to be judged anyway.
    await rm(path.join(lane, "node_modules"), { recursive: true, force: true });
    await landApi();

    await expect(audit({ ignoredBaseline })).resolves.toEqual({
      unattributedPaths: ["node_modules"],
    });
  });

  it("still reports an unowned ignored write when a member owns only a narrow path INSIDE the baselined directory", async () => {
    await write(
      lane,
      "node_modules/pkg/index.js",
      "installed at provisioning\n",
    );
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "node_modules/leak.env", "AWS_SECRET=…\n");
    await landApi();

    // Ownership of `node_modules/pkg` says nothing about `node_modules` as a
    // whole; a prefix narrower than the baseline root must not exempt the root.
    await expect(
      audit({
        ignoredBaseline,
        memberOwnerships: [
          ...members,
          {
            mode: "owned",
            canonicalPrefixes: [path.join(canonicalLane, "node_modules/pkg")],
          },
        ],
      }),
    ).resolves.toEqual({ unattributedPaths: ["node_modules"] });
  });

  /** A third member owning a path that the `node_modules/` rule already ignores. */
  const OWNS_NODE_MODULES_PKG = "node_modules/pkg";

  it("accepts a member's own writes under a path it owns INSIDE a baselined directory", async () => {
    await write(lane, "node_modules/pkg/index.js", "installed\n");
    await write(lane, "node_modules/other/lib.js", "installed\n");
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "node_modules/pkg/index.js", "rebuilt by its owner\n");
    await write(lane, "node_modules/pkg/added.js", "also its owner's\n");
    await landApi();

    await expect(
      audit({
        ignoredBaseline,
        memberOwnerships: [
          ...members,
          {
            mode: "owned",
            canonicalPrefixes: [
              path.join(canonicalLane, OWNS_NODE_MODULES_PKG),
            ],
          },
        ],
      }),
    ).resolves.toEqual({ unattributedPaths: [] });
  });

  it("still reports an unowned write under a baselined directory that a member owns part of", async () => {
    await write(lane, "node_modules/pkg/index.js", "installed\n");
    await write(lane, "node_modules/other/lib.js", "installed\n");
    const ignoredBaseline = captureIgnoredBaseline(
      await readIgnoredContents(lane),
    );

    await write(lane, "src/api/handler.ts", "api v2\n");
    // Both at once: the owner's legitimate work, and a write nobody declared.
    await write(lane, "node_modules/pkg/index.js", "rebuilt by its owner\n");
    await write(lane, "node_modules/leak.env", "AWS_SECRET=…\n");
    await landApi();

    // Filtering the current owner's surface must not hide the rest of the root.
    await expect(
      audit({
        ignoredBaseline,
        memberOwnerships: [
          ...members,
          {
            mode: "owned",
            canonicalPrefixes: [
              path.join(canonicalLane, OWNS_NODE_MODULES_PKG),
            ],
          },
        ],
      }),
    ).resolves.toEqual({ unattributedPaths: ["node_modules"] });
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

  it("never reports a member's own payload directory or the engine's own documents, which live in the same ignored namespace", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, `${CONTEXT_API_PAYLOAD}/doc.json`, "{}\n");
    await write(lane, ".cc/temp/context-ui/answers.json", "{}\n");
    await write(lane, ".cc/graph-workflow-docs/charter.md", "# charter\n");
    await write(lane, ".cc/workflow/validation.log", "ok\n");
    await landApi();

    await expect(audit()).resolves.toEqual({ unattributedPaths: [] });
  });

  it("reports a write elsewhere in CC's namespace, which no engine directory and no member's payload directory accounts for", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, `${CONTEXT_API_PAYLOAD}/doc.json`, "{}\n");
    await write(lane, ".cc/unrelated-secret", "server-mediated write\n");
    await landApi();

    await expect(audit()).resolves.toEqual({
      unattributedPaths: [".cc/unrelated-secret"],
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

  it("reports nothing at all once a member holds full lane access", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "scripts/deploy.sh", "#!/bin/sh\n");
    await landApi();

    await expect(
      audit({
        memberOwnerships: [...members, { mode: "full", canonicalPrefixes: [] }],
      }),
    ).resolves.toEqual({ unattributedPaths: [] });
  });
});
