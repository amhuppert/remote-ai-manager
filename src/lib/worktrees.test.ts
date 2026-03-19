import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseWorktreeList,
  deriveSessionName,
  ensureUniqueName,
  discoverAndImportWorktrees,
  type WorktreeDeps,
} from "./worktrees";
import type { SessionState } from "@/types";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

const gitMock = vi.fn();
const existsSyncMock = vi.fn<(p: string) => boolean>();
const readStateMock = vi.fn();
const writeStateMock = vi.fn();
const mutateStateMock = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    projects: {},
    archivedProjects: [] as string[],
    pinnedProjects: [] as string[],
  };
}

function mockGitSuccess(stdout = "", stderr = "") {
  gitMock.mockResolvedValue({ stdout, stderr });
}

function mockGitFailure(error: Error) {
  gitMock.mockRejectedValue(error);
}

function makeDeps(): Partial<WorktreeDeps> {
  return {
    git: gitMock,
    existsSync: existsSyncMock as unknown as WorktreeDeps["existsSync"],
    mutateState: mutateStateMock,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  readStateMock.mockResolvedValue(emptyState());
  writeStateMock.mockResolvedValue(undefined);
  mutateStateMock.mockImplementation(
    async (_label: string, mutate: (state: unknown) => unknown) => {
      const state = await readStateMock();
      const result = await mutate(state);
      await writeStateMock(state, _label);
      return result;
    },
  );
  existsSyncMock.mockReturnValue(true);
});

// ===========================================================================
// 2.1 – parseWorktreeList
// ===========================================================================

describe("parseWorktreeList", () => {
  it("parses multiple worktrees from porcelain output", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123def456",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo/.worktrees/feature",
      "HEAD def789abc012",
      "branch refs/heads/csm/feature",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      path: "/home/user/repo",
      head: "abc123def456",
      branch: "refs/heads/main",
      isMainWorktree: true,
    });

    expect(result[1]).toEqual({
      path: "/home/user/repo/.worktrees/feature",
      head: "def789abc012",
      branch: "refs/heads/csm/feature",
      isMainWorktree: false,
    });
  });

  it("handles detached HEAD entries", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo/.worktrees/detached",
      "HEAD deadbeef",
      "detached",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      path: "/home/user/repo/.worktrees/detached",
      head: "deadbeef",
      branch: null,
      isMainWorktree: false,
    });
  });

  it("handles locked and prunable worktrees", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/locked-wt",
      "HEAD 111222",
      "branch refs/heads/feature/locked",
      "locked",
      "",
      "worktree /tmp/prunable-wt",
      "HEAD 333444",
      "branch refs/heads/feature/old",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(3);
    expect(result[1]!.path).toBe("/tmp/locked-wt");
    expect(result[1]!.branch).toBe("refs/heads/feature/locked");
    expect(result[2]!.path).toBe("/tmp/prunable-wt");
  });

  it("handles locked worktree with reason text", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/locked-reason",
      "HEAD 555666",
      "branch refs/heads/test",
      "locked reason some explanation here",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(2);
    expect(result[1]!.path).toBe("/tmp/locked-reason");
  });

  it("returns empty array for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("  \n  ")).toEqual([]);
  });

  it("returns single main worktree for single-worktree output", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.isMainWorktree).toBe(true);
  });

  it("skips malformed entries missing required fields", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/incomplete",
      "",
      "worktree /tmp/valid",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    // Main worktree + valid worktree; incomplete skipped
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe("/home/user/repo");
    expect(result[1]!.path).toBe("/tmp/valid");
  });

  it("handles bare repository as main worktree", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "bare",
      "",
      "worktree /tmp/wt1",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n");

    const result = parseWorktreeList(output);
    expect(result).toHaveLength(2);
    expect(result[0]!.isMainWorktree).toBe(true);
  });
});

// ===========================================================================
// 2.2 – deriveSessionName
// ===========================================================================

describe("deriveSessionName", () => {
  it("strips refs/heads/ prefix from branch name", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/feature/login",
      isMainWorktree: false,
    });
    expect(name).toBe("feature/login");
  });

  it("strips csm/ prefix from branch name", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/csm/my-feature",
      isMainWorktree: false,
    });
    expect(name).toBe("my-feature");
  });

  it("strips both refs/heads/ and csm/ prefixes", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/csm/deep-feature",
      isMainWorktree: false,
    });
    expect(name).toBe("deep-feature");
  });

  it("preserves feature/ prefix in branch name", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/feature/auth",
      isMainWorktree: false,
    });
    expect(name).toBe("feature/auth");
  });

  it("preserves bugfix/ prefix in branch name", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/bugfix/issue-42",
      isMainWorktree: false,
    });
    expect(name).toBe("bugfix/issue-42");
  });

  it("falls back to directory basename for detached HEAD", () => {
    const name = deriveSessionName({
      path: "/home/user/repo/.worktrees/my-detached",
      head: "abc",
      branch: null,
      isMainWorktree: false,
    });
    expect(name).toBe("my-detached");
  });

  it("handles branch name without refs/heads/ prefix", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "main",
      isMainWorktree: false,
    });
    expect(name).toBe("main");
  });

  it("strips random 6-char hex suffix from csm/ branch", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/csm/my-feature-a1b2c3",
      isMainWorktree: false,
    });
    expect(name).toBe("my-feature");
  });

  it("handles csm/ branch without suffix (backward compat)", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/csm/my-feature",
      isMainWorktree: false,
    });
    expect(name).toBe("my-feature");
  });

  it("does not strip partial hex suffixes (less than 6 chars)", () => {
    const name = deriveSessionName({
      path: "/tmp/wt",
      head: "abc",
      branch: "refs/heads/csm/my-feature-a1b2",
      isMainWorktree: false,
    });
    expect(name).toBe("my-feature-a1b2");
  });

  it("strips custom prefix when branchPrefix is provided", () => {
    const name = deriveSessionName(
      {
        path: "/tmp/wt",
        head: "abc",
        branch: "refs/heads/dev/my-feature-abc123",
        isMainWorktree: false,
      },
      "dev",
    );
    expect(name).toBe("my-feature");
  });

  it("does not strip csm/ when branchPrefix is a different value", () => {
    const name = deriveSessionName(
      {
        path: "/tmp/wt",
        head: "abc",
        branch: "refs/heads/csm/my-feature-abc123",
        isMainWorktree: false,
      },
      "dev",
    );
    expect(name).toBe("csm/my-feature-abc123");
  });

  it("handles empty string branchPrefix (no prefix stripping)", () => {
    const name = deriveSessionName(
      {
        path: "/tmp/wt",
        head: "abc",
        branch: "refs/heads/my-feature-abc123",
        isMainWorktree: false,
      },
      "",
    );
    expect(name).toBe("my-feature-abc123");
  });
});

// ===========================================================================
// 2.2 – ensureUniqueName
// ===========================================================================

describe("ensureUniqueName", () => {
  it("returns name as-is when no conflict", () => {
    const existing = new Set(["alpha", "beta"]);
    expect(ensureUniqueName("gamma", existing)).toBe("gamma");
  });

  it("appends -2 on first conflict", () => {
    const existing = new Set(["feature"]);
    expect(ensureUniqueName("feature", existing)).toBe("feature-2");
  });

  it("increments suffix on multiple conflicts", () => {
    const existing = new Set(["feature", "feature-2", "feature-3"]);
    expect(ensureUniqueName("feature", existing)).toBe("feature-4");
  });

  it("handles empty existing set", () => {
    expect(ensureUniqueName("anything", new Set())).toBe("anything");
  });
});

// ===========================================================================
// 3 – discoverAndImportWorktrees
// ===========================================================================

describe("discoverAndImportWorktrees", () => {
  const projectPath = "/home/user/repo";

  const porcelainOutput = [
    "worktree /home/user/repo",
    "HEAD aaa111",
    "branch refs/heads/main",
    "",
    "worktree /home/user/repo/.worktrees/existing-feature",
    "HEAD bbb222",
    "branch refs/heads/csm/existing-feature",
    "",
    "worktree /tmp/external-worktree",
    "HEAD ccc333",
    "branch refs/heads/feature/new-thing",
    "",
    "worktree /home/user/repo/.worktrees/detached-wt",
    "HEAD ddd444",
    "detached",
    "",
  ].join("\n");

  const existingSession: SessionState = {
    sessionName: "existing-feature",
    worktreePath: "/home/user/repo/.worktrees/existing-feature",
    branchName: "csm/existing-feature",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast" as const,
    tddEnabled: true,
    workflow: null,
    workflowHistory: [],
  };

  it("imports untracked worktrees as sessions with source=imported", async () => {
    mockGitSuccess(porcelainOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "existing-feature": existingSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [existingSession],
      makeDeps(),
    );

    expect(result.imported).toHaveLength(2);
    expect(result.imported[0]!.source).toBe("imported");
    expect(result.imported[0]!.worktreePath).toBe("/tmp/external-worktree");
    expect(result.imported[0]!.branchName).toBe("feature/new-thing");
    expect(result.imported[0]!.sessionName).toBe("feature/new-thing");

    expect(result.imported[1]!.source).toBe("imported");
    expect(result.imported[1]!.worktreePath).toBe(
      "/home/user/repo/.worktrees/detached-wt",
    );
    expect(result.imported[1]!.sessionName).toBe("detached-wt");
    expect(result.imported[1]!.branchName).toBe("");
  });

  it("does not modify existing sessions", async () => {
    mockGitSuccess(porcelainOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "existing-feature": existingSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await discoverAndImportWorktrees(
      projectPath,
      [existingSession],
      makeDeps(),
    );

    // Verify existing session is unchanged in the written state
    const savedState = writeStateMock.mock.calls[0]![0];
    const savedExisting =
      savedState.projects[projectPath].sessions["existing-feature"];
    expect(savedExisting.source).toBe("cc");
    expect(savedExisting.worktreePath).toBe(
      "/home/user/repo/.worktrees/existing-feature",
    );
  });

  it("detects orphaned sessions", async () => {
    const orphanedSession: SessionState = {
      sessionName: "orphan",
      worktreePath: "/home/user/repo/.worktrees/orphan",
      branchName: "csm/orphan",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc",
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      workflow: null,
      workflowHistory: [],
    };

    // Git returns only main worktree — orphan's path doesn't exist on disk
    mockGitSuccess(
      [
        "worktree /home/user/repo",
        "HEAD aaa111",
        "branch refs/heads/main",
        "",
      ].join("\n"),
    );

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p) === orphanedSession.worktreePath) return false;
      return true;
    });

    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            orphan: orphanedSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [orphanedSession],
      makeDeps(),
    );

    expect(result.orphanedSessionNames).toContain("orphan");
    expect(result.imported).toHaveLength(0);
  });

  it("does not flag finished sessions as orphaned", async () => {
    const finishedSession: SessionState = {
      sessionName: "done",
      worktreePath: "/home/user/repo/.worktrees/done",
      branchName: "csm/done",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: true,
      finished: true,
      conversations: [],
      source: "cc",
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      workflow: null,
      workflowHistory: [],
    };

    mockGitSuccess(
      [
        "worktree /home/user/repo",
        "HEAD aaa111",
        "branch refs/heads/main",
        "",
      ].join("\n"),
    );

    existsSyncMock.mockReturnValue(false);

    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: { done: finishedSession },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [finishedSession],
      makeDeps(),
    );

    expect(result.orphanedSessionNames).not.toContain("done");
  });

  it("returns empty result on git failure", async () => {
    mockGitFailure(new Error("git not found"));

    const result = await discoverAndImportWorktrees(
      projectPath,
      [],
      makeDeps(),
    );

    expect(result.imported).toEqual([]);
    expect(result.orphanedSessionNames).toEqual([]);
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("deduplicates by worktreePath — does not re-import already-tracked worktrees", async () => {
    mockGitSuccess(porcelainOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "existing-feature": existingSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [existingSession],
      makeDeps(),
    );

    // existing-feature should NOT be in imported list
    const importedPaths = result.imported.map((s) => s.worktreePath);
    expect(importedPaths).not.toContain(existingSession.worktreePath);
  });

  it("skips worktree with matching branch even at different path (no duplicate import)", async () => {
    // Worktree at a different path but with same branch as existing session
    const conflictOutput = [
      "worktree /home/user/repo",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/new-wt",
      "HEAD bbb222",
      "branch refs/heads/csm/existing-feature",
      "",
    ].join("\n");

    mockGitSuccess(conflictOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "existing-feature": existingSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [existingSession],
      makeDeps(),
    );

    // Branch-name dedup prevents import — this is the same session
    expect(result.imported).toHaveLength(0);
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("resolves name collisions with numeric suffix for genuinely different branches", async () => {
    // Worktree with a DIFFERENT branch that derives to a name colliding
    // with an existing session name
    const conflictOutput = [
      "worktree /home/user/repo",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/new-wt",
      "HEAD bbb222",
      "branch refs/heads/feature/existing-feature",
      "",
    ].join("\n");

    mockGitSuccess(conflictOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "existing-feature": existingSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [existingSession],
      makeDeps(),
    );

    // Different branch, so it IS imported — name deduplication applies
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]!.sessionName).toBe("feature/existing-feature");
  });

  it("persists imported sessions atomically via writeState", async () => {
    mockGitSuccess(porcelainOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "existing-feature": existingSession,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await discoverAndImportWorktrees(
      projectPath,
      [existingSession],
      makeDeps(),
    );

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const sessions = savedState.projects[projectPath].sessions;

    // Should contain existing + 2 imported
    expect(Object.keys(sessions)).toHaveLength(3);
  });

  it("does not call writeState when there are no imports", async () => {
    // Only main worktree, and no existing sessions that could be orphaned
    mockGitSuccess(
      [
        "worktree /home/user/repo",
        "HEAD aaa111",
        "branch refs/heads/main",
        "",
      ].join("\n"),
    );

    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {},
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await discoverAndImportWorktrees(projectPath, [], makeDeps());

    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("skips worktrees whose branch matches an existing session (branch-name dedup)", async () => {
    // Session in state with Title Case name — its branch differs from path
    const sessionWithBranch: SessionState = {
      sessionName: "Activity Panel Polish",
      worktreePath: "/home/user/repo/.worktrees/activity-panel-polish",
      branchName: "csm/activity-panel-polish",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [] as SessionState["conversations"],
      source: "cc",
      objective: "Polish the activity panel",
      creationMode: "optimistic" as const,
      tddEnabled: true,
      workflow: null,
      workflowHistory: [],
    };

    // Git discovers a worktree at a DIFFERENT path but with the SAME branch
    const porcelainWithMatchingBranch = [
      "worktree /home/user/repo",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/different-path",
      "HEAD bbb222",
      "branch refs/heads/csm/activity-panel-polish",
      "",
    ].join("\n");

    mockGitSuccess(porcelainWithMatchingBranch);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {
            "Activity Panel Polish": sessionWithBranch,
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [sessionWithBranch],
      makeDeps(),
    );

    // Should NOT import — branch matches existing session
    expect(result.imported).toHaveLength(0);
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("sets timestamps on imported sessions to current time", async () => {
    const simpleOutput = [
      "worktree /home/user/repo",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/new-wt",
      "HEAD bbb222",
      "branch refs/heads/feature/test",
      "",
    ].join("\n");

    mockGitSuccess(simpleOutput);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {},
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const before = new Date().toISOString();
    const result = await discoverAndImportWorktrees(
      projectPath,
      [],
      makeDeps(),
    );
    const after = new Date().toISOString();

    const imported = result.imported[0]!;
    expect(new Date(imported.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
    expect(new Date(imported.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(after).getTime(),
    );
    expect(imported.createdAt).toBe(imported.lastActivityAt);
  });

  it("strips custom branch prefix when branchPrefix is provided", async () => {
    const customPorcelain = [
      "worktree /home/user/repo",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo/.worktrees/my-feature-abc123",
      "HEAD bbb222",
      "branch refs/heads/dev/my-feature-abc123",
      "",
    ].join("\n");

    mockGitSuccess(customPorcelain);
    readStateMock.mockResolvedValue({
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: {},
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await discoverAndImportWorktrees(
      projectPath,
      [],
      makeDeps(),
      "dev",
    );

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]!.sessionName).toBe("my-feature");
  });
});
