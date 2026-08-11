import { describe, expect, it } from "vitest";
import type { IgnoredEntry, WorktreeStatusEntry } from "@/lib/git/worktree";
import {
  classifyLaneDrift,
  createLaneDriftAuditor,
  laneOwnedPrefixes,
  laneReservedPrefixes,
  summarizeIgnoredContents,
} from "./lane-drift";
import type { GraphWorkflowIgnoredBaselineEntry } from "./schemas";

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
const MEMBERS = ["context-api", "context-ui"];

/**
 * An ignored file, with a fingerprint that stands for its bytes. Cases about
 * WHICH paths exist pass names alone and get the same fingerprint everywhere;
 * cases about a file changing in place vary it explicitly.
 */
function ignoredFile(
  path: string,
  fingerprint = "as-provisioned",
): IgnoredEntry {
  return { path, fingerprint };
}

/** The baseline as provisioning would have recorded these ignored contents. */
const provisionedEntries = new WeakMap<
  readonly GraphWorkflowIgnoredBaselineEntry[],
  readonly IgnoredEntry[]
>();

function provisionedWith(roots: string[], entries: (string | IgnoredEntry)[]) {
  const contents = {
    roots,
    entries: entries.map((e) => (typeof e === "string" ? ignoredFile(e) : e)),
  };
  const baseline = summarizeIgnoredContents(contents);
  provisionedEntries.set(baseline, contents.entries);
  return baseline;
}

interface ClassifyOverrides {
  /** Ignored paths whose contents are unchanged from provisioning. */
  ignoredFiles?: readonly string[];
  /** Ignored files whose fingerprints matter to the case. */
  ignoredEntries?: readonly IgnoredEntry[];
  ownedPrefixes?: readonly string[];
  reservedPrefixes?: readonly string[];
  ignoredBaseline?: readonly GraphWorkflowIgnoredBaselineEntry[];
  hasFullAccessMember?: boolean;
}

function classify(
  entries: readonly WorktreeStatusEntry[],
  overrides: ClassifyOverrides = {},
) {
  return classifyLaneDrift({
    entries,
    ignoredEntries:
      overrides.ignoredEntries ??
      (overrides.ignoredFiles ?? []).map((path) => ignoredFile(path)),
    ownedPrefixes: overrides.ownedPrefixes ?? LANE_UNION,
    reservedPrefixes:
      overrides.reservedPrefixes ?? laneReservedPrefixes(MEMBERS),
    ignoredBaseline: overrides.ignoredBaseline ?? [],
    ignoredBaselineEntries:
      provisionedEntries.get(overrides.ignoredBaseline ?? []) ?? [],
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

  it("never reports the engine's own artifact directories or a member's injected payload directory", () => {
    expect(
      classify([], {
        ignoredFiles: [
          ".cc/temp/context-api/doc.json",
          ".cc/temp/context-ui/answers.json",
          ".cc/graph-workflow-docs/charter.md",
          ".cc/workflow/validation.log",
        ],
      }).unattributedPaths,
    ).toEqual([]);
  });

  it("does not exempt a managed-skills collision that appeared after provisioning", () => {
    expect(
      classify([], {
        ignoredFiles: [".agents/skills/command-center"],
      }).unattributedPaths,
    ).toEqual([".agents/skills/command-center"]);
  });

  it("baselines an unchanged managed-skills conflict but reports later mutation", () => {
    const bridgePath = ".agents/skills/command-center";
    const baseline = provisionedWith(
      [bridgePath],
      [ignoredFile(bridgePath, "project-owned")],
    );

    expect(
      classify([], {
        ignoredEntries: [ignoredFile(bridgePath, "project-owned")],
        ignoredBaseline: baseline,
      }).unattributedPaths,
    ).toEqual([]);
    expect(
      classify([], {
        ignoredEntries: [ignoredFile(bridgePath, "mutated")],
        ignoredBaseline: baseline,
      }).unattributedPaths,
    ).toEqual([bridgePath]);
  });

  it("reports a write into CC's namespace that no engine directory and no member's payload directory accounts for", () => {
    expect(
      classify([], {
        ignoredFiles: [
          ".cc/unrelated-secret",
          ".cc/temp/context-stranger/notes.md",
        ],
      }).unattributedPaths,
    ).toEqual([".cc/temp/context-stranger/notes.md", ".cc/unrelated-secret"]);
  });

  it("reports an ignored write that no baseline, ownership, or reserved namespace accounts for", () => {
    expect(
      classify([], {
        // The provisioned install is still exactly as it was; only the new file
        // is unaccounted for.
        ignoredFiles: ["node_modules/pkg/index.js", "secrets.env"],
        ignoredBaseline: provisionedWith(
          ["node_modules"],
          ["node_modules/pkg/index.js"],
        ),
      }).unattributedPaths,
    ).toEqual(["secrets.env"]);
  });

  it("accepts a baselined ignored directory whose contents provisioning installed are still exactly what is there", () => {
    const files = [
      "node_modules/pkg/index.js",
      "node_modules/pkg/package.json",
    ];
    expect(
      classify([], {
        ignoredFiles: files,
        ignoredBaseline: provisionedWith(["node_modules"], files),
      }).unattributedPaths,
    ).toEqual([]);
  });

  it("reports a new file written INSIDE a baselined ignored directory, which git names as that same directory either way", () => {
    const provisioned = ["node_modules/pkg/index.js"];
    expect(
      classify([], {
        ignoredFiles: [...provisioned, "node_modules/leak.env"],
        ignoredBaseline: provisionedWith(["node_modules"], provisioned),
      }).unattributedPaths,
    ).toEqual(["node_modules"]);
  });

  it("accepts an ignored write inside a member's own ownership, which is that member's business", () => {
    expect(
      classify([], { ignoredFiles: ["src/api/build.log"] }).unattributedPaths,
    ).toEqual([]);
  });

  it("does not pre-authorize an ignored descendant owned only by a future lane member", () => {
    const ignoredBaseline = provisionedWith(
      ["node_modules"],
      ["node_modules/pkg/index.js", "node_modules/other/index.js"],
    );

    expect(
      classify([], {
        ignoredEntries: [
          ignoredFile("node_modules/pkg/index.js", "server-write"),
          ignoredFile("node_modules/other/index.js"),
        ],
        ownedPrefixes: [],
        ignoredBaseline,
      }).unattributedPaths,
    ).toEqual(["node_modules"]);
  });

  it("filters both baseline and current ignored entries by the current ownership union", () => {
    const provisioned = [
      ignoredFile("node_modules/pkg/index.js"),
      ignoredFile("node_modules/other/index.js"),
    ];

    expect(
      classify([], {
        ignoredEntries: [
          ignoredFile("node_modules/pkg/index.js", "owned-write"),
          ignoredFile("node_modules/other/index.js"),
        ],
        ownedPrefixes: ["node_modules/pkg"],
        ignoredBaseline: provisionedWith(["node_modules"], provisioned),
      }).unattributedPaths,
    ).toEqual([]);
  });

  it("leaves a baselined directory a member declared ownership OF unjudged, because its digest predates that declaration", () => {
    expect(
      classify([], {
        ignoredFiles: ["src/api/dist/bundle.js", "src/api/dist/new-chunk.js"],
        ownedPrefixes: ["src/api/dist"],
        ignoredBaseline: provisionedWith(
          ["src/api/dist"],
          ["src/api/dist/bundle.js"],
        ),
      }).unattributedPaths,
    ).toEqual([]);
  });

  it("still judges a baselined root when ownership only reaches a path INSIDE it, so a narrow claim cannot exempt the whole tree", () => {
    expect(
      classify([], {
        ignoredFiles: ["node_modules/pkg/index.js", "node_modules/leak.env"],
        ownedPrefixes: ["node_modules/pkg"],
        ignoredBaseline: provisionedWith(
          ["node_modules"],
          ["node_modules/pkg/index.js"],
        ),
      }).unattributedPaths,
    ).toEqual(["node_modules"]);
  });

  it("reports an ignored file OVERWRITTEN in place, which changes no path at all", () => {
    expect(
      classify([], {
        ignoredEntries: [
          ignoredFile("node_modules/pkg/index.js", "overwritten"),
        ],
        ignoredBaseline: provisionedWith(
          ["node_modules"],
          ["node_modules/pkg/index.js"],
        ),
      }).unattributedPaths,
    ).toEqual(["node_modules"]);
  });

  it("reports a baselined root whose last remaining file was DELETED, which nothing at audit time names", () => {
    expect(
      classify([], {
        ignoredFiles: [],
        ignoredBaseline: provisionedWith(
          ["node_modules"],
          ["node_modules/pkg/index.js"],
        ),
      }).unattributedPaths,
    ).toEqual(["node_modules"]);
  });

  it("reports nothing at all when a member holds full lane access, because that member owns the whole tree", () => {
    expect(
      classify([changed("anywhere/at/all.ts")], {
        ignoredFiles: ["secrets.env"],
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

describe("summarizeIgnoredContents", () => {
  it("digests each ignored root over the files beneath it, so two identical contents summarize identically", () => {
    const first = provisionedWith(
      ["node_modules", "debug.log"],
      ["node_modules/a.js", "node_modules/b.js", "debug.log"],
    );
    const reordered = provisionedWith(
      ["node_modules", "debug.log"],
      ["debug.log", "node_modules/b.js", "node_modules/a.js"],
    );

    expect(first.map((entry) => entry.path)).toEqual([
      "node_modules",
      "debug.log",
    ]);
    expect(first).toEqual(reordered);
  });

  it("gives a root that gained a file a different digest from the one it was provisioned with", () => {
    const before = provisionedWith(["node_modules"], ["node_modules/a.js"]);
    const after = provisionedWith(
      ["node_modules"],
      ["node_modules/a.js", "node_modules/leak.env"],
    );

    expect(after[0]?.digest).not.toBe(before[0]?.digest);
  });

  it("gives a root whose one file was rewritten in place a different digest, though its path list is identical", () => {
    const before = provisionedWith(["node_modules"], ["node_modules/a.js"]);
    const after = provisionedWith(
      ["node_modules"],
      [ignoredFile("node_modules/a.js", "rewritten")],
    );

    expect(after.map((entry) => entry.path)).toEqual(
      before.map((entry) => entry.path),
    );
    expect(after[0]?.digest).not.toBe(before[0]?.digest);
  });

  it("leaves CC's own namespace out entirely, so writes there are judged by name rather than swallowed by a directory digest", () => {
    expect(
      provisionedWith(
        [".cc", "node_modules"],
        [".cc/graph-workflow-docs/charter.md", "node_modules/a.js"],
      ).map((entry) => entry.path),
    ).toEqual(["node_modules"]);
  });
});

describe("laneReservedPrefixes", () => {
  it("reserves the engine's directories plus one payload directory per member, and nothing else under CC's namespace", () => {
    expect(laneReservedPrefixes(["context-api"])).toEqual([
      ".cc/graph-workflow-docs",
      ".cc/workflow",
      ".cc/temp/context-api",
    ]);
  });
});

describe("createLaneDriftAuditor managed checkout ownership", () => {
  function auditor(ownedCheckoutPaths: readonly string[]) {
    return createLaneDriftAuditor({
      readStatus: async () => [],
      readIgnoredEntries: async () => [
        ignoredFile(".agents/skills/command-center"),
      ],
      realpath: async (target) => target,
      listManagedSkillsOwnedCheckoutPaths: async () => ownedCheckoutPaths,
    });
  }

  const input = {
    laneWorktreePath: "/repo/.worktrees/session.lane-a",
    memberOwnerships: [],
    memberContextIds: [],
    ignoredBaseline: [],
    ignoredBaselineEntries: [],
  } as const;

  it("exempts an exact checkout path attested by the backend registry", async () => {
    await expect(
      auditor([".agents/skills/command-center"]).audit(input),
    ).resolves.toEqual({ unattributedPaths: [] });
  });

  it("reports the same path when no backend attests ownership", async () => {
    await expect(auditor([]).audit(input)).resolves.toEqual({
      unattributedPaths: [".agents/skills/command-center"],
    });
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
