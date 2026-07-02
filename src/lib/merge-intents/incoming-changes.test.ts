import { describe, expect, it, vi } from "vitest";
import type { GitClient } from "@/lib/git/client";
import type { MergeIntent } from "./schemas";
import { buildIncomingChangesSection } from "./incoming-changes";

const t0 = "2026-07-02T12:00:00.000Z";

function fakeGitClient(stdout: string): GitClient {
  return {
    async git() {
      return { stdout, stderr: "" };
    },
  };
}

function makeIntent(overrides: Partial<MergeIntent>): MergeIntent {
  return {
    projectPath: "/repo",
    commitSha: "sha",
    intent: "intent",
    source: "session-merge",
    createdAt: t0,
    ...overrides,
  };
}

const PARAMS = {
  projectPath: "/repo",
  worktreePath: "/repo/.worktrees/s1",
  targetBranch: "main",
};

describe("buildIncomingChangesSection", () => {
  it("lists incoming commit subjects and attaches recorded intents where available", async () => {
    const gitLog = [
      "aaaa111Merge csm/other into main",
      "bbbb222fix: adjust config loader",
    ].join("\n");
    const getMergeIntents = vi.fn(() => [
      makeIntent({
        commitSha: "aaaa111",
        intent: "Session other reworked the config loader cache keying.",
      }),
    ]);

    const section = await buildIncomingChangesSection(PARAMS, {
      gitClient: fakeGitClient(gitLog),
      getMergeIntents,
    });

    expect(section).not.toBeNull();
    expect(section).toContain("main");
    expect(section).toContain("aaaa111");
    expect(section).toContain("Merge csm/other into main");
    expect(section).toContain(
      "Session other reworked the config loader cache keying.",
    );
    expect(section).toContain("bbbb222");
    expect(section).toContain("fix: adjust config loader");
    expect(getMergeIntents).toHaveBeenCalledWith("/repo", [
      "aaaa111",
      "bbbb222",
    ]);
  });

  it("queries the commits reachable from the target branch but not HEAD", async () => {
    const git = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await buildIncomingChangesSection(PARAMS, {
      gitClient: { git },
      getMergeIntents: () => [],
    });

    expect(git).toHaveBeenCalledTimes(1);
    const [args, cwd] = git.mock.calls[0]! as unknown as [string[], string];
    expect(cwd).toBe("/repo/.worktrees/s1");
    expect(args).toContain("HEAD..main");
  });

  it("returns null when there are no incoming commits", async () => {
    const section = await buildIncomingChangesSection(PARAMS, {
      gitClient: fakeGitClient(""),
      getMergeIntents: () => [],
    });
    expect(section).toBeNull();
  });

  it("returns null instead of throwing when git fails", async () => {
    const section = await buildIncomingChangesSection(PARAMS, {
      gitClient: {
        async git() {
          throw new Error("not a git repository");
        },
      },
      getMergeIntents: () => [],
    });
    expect(section).toBeNull();
  });

  it("returns null instead of throwing when the intent lookup fails", async () => {
    const section = await buildIncomingChangesSection(PARAMS, {
      gitClient: fakeGitClient("aaaa111subject"),
      getMergeIntents: () => {
        throw new Error("db unavailable");
      },
    });
    expect(section).toBeNull();
  });

  it("caps oversized intents and marks truncation", async () => {
    const section = await buildIncomingChangesSection(PARAMS, {
      gitClient: fakeGitClient("aaaa111subject"),
      getMergeIntents: () => [
        makeIntent({ commitSha: "aaaa111", intent: "y".repeat(20_000) }),
      ],
    });

    expect(section).not.toBeNull();
    expect(section!.length).toBeLessThanOrEqual(8_000);
    expect(section).toContain("truncated");
  });
});
