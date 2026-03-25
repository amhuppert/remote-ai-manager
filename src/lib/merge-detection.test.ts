import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkAllSessionsForMerge,
  startMergeDetection,
  stopMergeDetection,
  _resetForTesting,
  type MergeDetectionDeps,
} from "./merge-detection";
import type { ManagerState, SessionFinishedEvent } from "@/types";

// ============================================================
// Helpers
// ============================================================

function makeState(
  sessions: Record<
    string,
    { sessionName: string; branchName: string; finished: boolean }
  >,
  projectPath = "/projects/foo",
): ManagerState {
  const sessionEntries: Record<
    string,
    ManagerState["projects"][string]["sessions"][string]
  > = {};
  for (const [key, s] of Object.entries(sessions)) {
    sessionEntries[key] = {
      sessionName: s.sessionName,
      branchName: s.branchName,
      worktreePath: `${projectPath}/.worktrees/${s.sessionName}`,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      archived: false,
      finished: s.finished,
      conversations: [],
      source: "cc",
      objective: null,
      creationMode: "fast",
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      workflow: null,
      workflowHistory: [],
    };
  }
  return {
    projects: {
      [projectPath]: {
        rootPath: projectPath,
        roadmapItems: [],
        sessions: sessionEntries,
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

// ============================================================
// Mock deps
// ============================================================

let mockBroadcast: ReturnType<typeof vi.fn>;
let mockReadState: ReturnType<typeof vi.fn>;
let mockReadConfig: ReturnType<typeof vi.fn>;
let mockIsBranchAncestorOfMain: ReturnType<typeof vi.fn>;
let mockIsBranchMentionedInMainLog: ReturnType<typeof vi.fn>;
let mockSetSessionFinished: ReturnType<typeof vi.fn>;
let mockStopAllForSession: ReturnType<typeof vi.fn>;
let deps: MergeDetectionDeps;

function lastBroadcast(): SessionFinishedEvent {
  const calls = mockBroadcast.mock.calls;
  return calls[calls.length - 1]![0] as SessionFinishedEvent;
}

// ============================================================
// Setup / Teardown
// ============================================================

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();

  mockBroadcast = vi.fn();
  mockReadState = vi.fn();
  mockReadConfig = vi.fn().mockResolvedValue({
    baseDir: "/projects",
    ignorePatterns: [],
    stateFilePath: "/config/state.json",
    claudeTimeoutMs: 3_600_000,
    defaultModel: "opus",
    mergeCheckIntervalMs: 5 * 60 * 1000,
  });
  mockIsBranchAncestorOfMain = vi.fn().mockResolvedValue(false);
  mockIsBranchMentionedInMainLog = vi.fn().mockResolvedValue(false);
  mockSetSessionFinished = vi.fn().mockResolvedValue(undefined);
  mockStopAllForSession = vi.fn().mockResolvedValue(undefined);

  deps = {
    broadcast: mockBroadcast,
    readState: mockReadState,
    readConfig: mockReadConfig,
    isBranchAncestorOfMain: mockIsBranchAncestorOfMain,
    isBranchMentionedInMainLog: mockIsBranchMentionedInMainLog,
    setSessionFinished: mockSetSessionFinished,
    stopAllForSession: mockStopAllForSession,
  };
});

afterEach(() => {
  _resetForTesting();
});

// ============================================================
// Tests
// ============================================================

describe("checkAllSessionsForMerge", () => {
  it("detects ancestor merge and marks session finished", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "my-session": {
          sessionName: "my-session",
          branchName: "csm/my-session",
          finished: false,
        },
      }),
    );
    mockIsBranchAncestorOfMain.mockResolvedValue(true);

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(1);
    expect(mockStopAllForSession).toHaveBeenCalledWith({
      projectPath: "/projects/foo",
      sessionName: "my-session",
    });
    expect(mockSetSessionFinished).toHaveBeenCalledWith(
      "/projects/foo",
      "my-session",
    );

    const event = lastBroadcast();
    expect(event.type).toBe("session-finished");
    expect(event.sessionName).toBe("my-session");
    expect(event.branchName).toBe("csm/my-session");
    expect(event.detectionMethod).toBe("ancestor");
    expect(event.projectName).toBe("foo");
  });

  it("falls through to commit-message strategy when ancestor fails", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "squash-session": {
          sessionName: "squash-session",
          branchName: "csm/squash-session",
          finished: false,
        },
      }),
    );
    mockIsBranchAncestorOfMain.mockResolvedValue(false);
    mockIsBranchMentionedInMainLog.mockResolvedValue(true);

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(1);
    expect(mockStopAllForSession).toHaveBeenCalledWith({
      projectPath: "/projects/foo",
      sessionName: "squash-session",
    });
    expect(mockSetSessionFinished).toHaveBeenCalledWith(
      "/projects/foo",
      "squash-session",
    );

    const event = lastBroadcast();
    expect(event.detectionMethod).toBe("commit-message");
  });

  it("skips already-finished sessions", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "done-session": {
          sessionName: "done-session",
          branchName: "csm/done-session",
          finished: true,
        },
      }),
    );

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(0);
    expect(mockIsBranchAncestorOfMain).not.toHaveBeenCalled();
    expect(mockIsBranchMentionedInMainLog).not.toHaveBeenCalled();
    expect(mockSetSessionFinished).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("still marks session finished when stopAllForSession fails", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "my-session": {
          sessionName: "my-session",
          branchName: "csm/my-session",
          finished: false,
        },
      }),
    );
    mockIsBranchAncestorOfMain.mockResolvedValue(true);
    mockStopAllForSession.mockRejectedValue(new Error("kill failed"));

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(1);
    expect(mockStopAllForSession).toHaveBeenCalled();
    expect(mockSetSessionFinished).toHaveBeenCalledWith(
      "/projects/foo",
      "my-session",
    );
  });

  it("does not mark session when neither strategy detects a merge", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "active-session": {
          sessionName: "active-session",
          branchName: "csm/active-session",
          finished: false,
        },
      }),
    );

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(0);
    expect(mockSetSessionFinished).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("does not mark session when branch never diverged (ancestor but tip == merge-base)", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "no-commits-session": {
          sessionName: "no-commits-session",
          branchName: "csm/no-commits-session",
          finished: false,
        },
      }),
    );

    // isBranchAncestorOfMain returns false for non-diverged branches now
    mockIsBranchAncestorOfMain.mockResolvedValue(false);
    mockIsBranchMentionedInMainLog.mockResolvedValue(false);

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(0);
    expect(mockSetSessionFinished).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("continues checking other sessions when one fails", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "fail-session": {
          sessionName: "fail-session",
          branchName: "csm/fail-session",
          finished: false,
        },
        "good-session": {
          sessionName: "good-session",
          branchName: "csm/good-session",
          finished: false,
        },
      }),
    );

    // First session throws, second detects merge
    mockIsBranchAncestorOfMain
      .mockRejectedValueOnce(new Error("git failed"))
      .mockResolvedValueOnce(true);

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(1);
    expect(mockSetSessionFinished).toHaveBeenCalledTimes(1);
  });

  it("skips strategy 2 when strategy 1 detects merge", async () => {
    mockReadState.mockResolvedValue(
      makeState({
        "merged-session": {
          sessionName: "merged-session",
          branchName: "csm/merged-session",
          finished: false,
        },
      }),
    );
    mockIsBranchAncestorOfMain.mockResolvedValue(true);

    await checkAllSessionsForMerge(deps);

    expect(mockIsBranchMentionedInMainLog).not.toHaveBeenCalled();
  });

  it("returns correct count with multiple projects and sessions", async () => {
    const state: ManagerState = {
      projects: {
        "/projects/alpha": {
          rootPath: "/projects/alpha",
          roadmapItems: [],
          sessions: {
            s1: {
              sessionName: "s1",
              branchName: "csm/s1",
              worktreePath: "/projects/alpha/.worktrees/s1",
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              workflow: null,
              workflowHistory: [],
            },
          },
        },
        "/projects/beta": {
          rootPath: "/projects/beta",
          roadmapItems: [],
          sessions: {
            s2: {
              sessionName: "s2",
              branchName: "csm/s2",
              worktreePath: "/projects/beta/.worktrees/s2",
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              workflow: null,
              workflowHistory: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };
    mockReadState.mockResolvedValue(state);
    mockIsBranchAncestorOfMain.mockResolvedValue(true);

    const count = await checkAllSessionsForMerge(deps);

    expect(count).toBe(2);
    expect(mockSetSessionFinished).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
  });
});

describe("startMergeDetection / stopMergeDetection", () => {
  it("starts and stops without error", async () => {
    mockReadState.mockResolvedValue({
      projects: {},
      archivedProjects: [],
      pinnedProjects: [],
    });

    await startMergeDetection(deps);

    // Should not throw
    stopMergeDetection();
  });

  it("clears existing interval before starting a new one", async () => {
    mockReadState.mockResolvedValue({
      projects: {},
      archivedProjects: [],
      pinnedProjects: [],
    });

    await startMergeDetection(deps);
    await startMergeDetection(deps); // Should clear previous

    // Should not throw
    stopMergeDetection();
  });

  it("uses mergeCheckIntervalMs from config", async () => {
    mockReadConfig.mockResolvedValue({
      baseDir: "/projects",
      ignorePatterns: [],
      stateFilePath: "/config/state.json",
      claudeTimeoutMs: 3_600_000,
      defaultModel: "opus",
      mergeCheckIntervalMs: 60_000, // 1 minute
    });
    mockReadState.mockResolvedValue({
      projects: {},
      archivedProjects: [],
      pinnedProjects: [],
    });

    await startMergeDetection(deps);

    // Config was read to get the interval
    expect(mockReadConfig).toHaveBeenCalled();

    stopMergeDetection();
  });
});
