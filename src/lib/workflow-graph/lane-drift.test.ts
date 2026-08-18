import { describe, expect, it } from "vitest";
import type { WorktreeStatusEntry } from "@/lib/git/worktree";
import {
  classifyLaneDrift,
  createLaneDriftAuditor,
  laneOwnedPrefixes,
} from "./lane-drift";

function changed(path: string): WorktreeStatusEntry {
  return { path, originalPath: null, kind: "changed" };
}
function untracked(path: string): WorktreeStatusEntry {
  return { path, originalPath: null, kind: "untracked" };
}
function renamed(path: string, originalPath: string): WorktreeStatusEntry {
  return { path, originalPath, kind: "renamed" };
}

const LANE_UNION = ["src/api", "src/ui", "docs/api.md"];

interface ClassifyOverrides {
  ownedPrefixes?: readonly string[];
  hasFullAccessMember?: boolean;
}

function classify(
  entries: readonly WorktreeStatusEntry[],
  overrides: ClassifyOverrides = {},
) {
  return classifyLaneDrift({
    entries,
    ownedPrefixes: overrides.ownedPrefixes ?? LANE_UNION,
    hasFullAccessMember: overrides.hasFullAccessMember ?? false,
  });
}

describe("classifyLaneDrift", () => {
  it("attributes every member's in-progress change to the lane union, so a clean concurrent landing reports nothing", () => {
    expect(
      classify([
        changed("src/api/handler.ts"),
        untracked("src/api/new.ts"),
        changed("src/ui/panel.tsx"),
        changed("docs/api.md"),
      ]).unattributedPaths,
    ).toEqual([]);
  });

  it("reports a path no member owns", () => {
    expect(
      classify([
        changed("src/api/handler.ts"),
        changed("src/server/router.ts"),
        untracked("scripts/deploy.sh"),
      ]).unattributedPaths,
    ).toEqual(["scripts/deploy.sh", "src/server/router.ts"]);
  });

  it("does not let one owned prefix swallow a sibling directory that merely shares its opening characters", () => {
    expect(classify([changed("src/apix/other.ts")]).unattributedPaths).toEqual([
      "src/apix/other.ts",
    ]);
  });

  it("attributes both endpoints of a rename, and reports the one that left the lane union", () => {
    expect(
      classify([renamed("src/api/moved.ts", "src/api/old.ts")])
        .unattributedPaths,
    ).toEqual([]);
    expect(
      classify([renamed("vendor/escaped.ts", "src/api/old.ts")])
        .unattributedPaths,
    ).toEqual(["vendor/escaped.ts"]);
    expect(
      classify([renamed("src/api/arrived.ts", "vendor/source.ts")])
        .unattributedPaths,
    ).toEqual(["vendor/source.ts"]);
  });

  it("judges a .cc entry like any other path — unattributed unless a member owns it", () => {
    // Reaching here at all is the abnormal case: `.cc/` is excluded in the
    // shared common dir before the first artifact lands, and an exclude rule
    // does not untrack, so only a repo that COMMITTED a .cc path can report
    // one. There is no reserved-prefix carve-out for that shape — failing loud
    // is the honest verdict on a tree state the engine never produces.
    expect(
      classify([
        untracked(".cc/temp/context-api/doc.json"),
        untracked(".cc/graph-workflow-docs/charter.md"),
        changed(".cc/workflow/validation.log"),
      ]).unattributedPaths,
    ).toEqual([
      ".cc/graph-workflow-docs/charter.md",
      ".cc/temp/context-api/doc.json",
      ".cc/workflow/validation.log",
    ]);
  });

  it("reports nothing at all when a member holds full lane access, because that member owns the whole tree", () => {
    expect(
      classify([changed("anywhere/at/all.ts")], {
        hasFullAccessMember: true,
        ownedPrefixes: [],
      }).unattributedPaths,
    ).toEqual([]);
  });

  it("reports each unattributed path once, in a stable order", () => {
    expect(
      classify([
        untracked("z/last.ts"),
        changed("a/first.ts"),
        renamed("z/last.ts", "a/first.ts"),
      ]).unattributedPaths,
    ).toEqual(["a/first.ts", "z/last.ts"]);
  });
});

describe("createLaneDriftAuditor", () => {
  it("judges what git reports against the frozen union, relativized to the canonical worktree", async () => {
    const auditor = createLaneDriftAuditor({
      readStatus: async () => [
        changed("src/api/handler.ts"),
        untracked("vendor/dropped.ts"),
      ],
      // Production resolves a symlinked worktree root; the frozen prefixes are
      // stated against the resolved form, so the two must be compared there.
      realpath: async () => "/private/lane",
    });

    await expect(
      auditor.audit({
        laneWorktreePath: "/lane",
        memberOwnerships: [
          { mode: "owned", canonicalPrefixes: ["/private/lane/src/api"] },
        ],
      }),
    ).resolves.toEqual({ unattributedPaths: ["vendor/dropped.ts"] });
  });
});

describe("laneOwnedPrefixes", () => {
  it("relativizes every owning member's frozen prefixes against the canonical lane worktree", () => {
    expect(
      laneOwnedPrefixes("/private/lane", [
        {
          mode: "owned",
          canonicalPrefixes: ["/private/lane/src/api", "/private/lane/docs"],
        },
        { mode: "owned", canonicalPrefixes: ["/private/lane/src/ui"] },
        { mode: "readOnly", canonicalPrefixes: [] },
      ]),
    ).toEqual({
      ownedPrefixes: ["src/api", "docs", "src/ui"],
      hasFullAccessMember: false,
    });
  });

  it("flags a full-access member rather than trying to enumerate a surface it does not declare", () => {
    expect(
      laneOwnedPrefixes("/private/lane", [
        { mode: "owned", canonicalPrefixes: ["/private/lane/src/api"] },
        { mode: "full", canonicalPrefixes: [] },
      ]),
    ).toEqual({ ownedPrefixes: ["src/api"], hasFullAccessMember: true });
  });

  it("drops a frozen prefix that no longer sits under the lane worktree instead of emitting an escaping pathspec", () => {
    expect(
      laneOwnedPrefixes("/private/lane", [
        {
          mode: "owned",
          canonicalPrefixes: ["/elsewhere/src", "/private/lane/src/api"],
        },
      ]),
    ).toEqual({ ownedPrefixes: ["src/api"], hasFullAccessMember: false });
  });
});
