import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ManagerState } from "@/types";

const TEST_DIR = path.join("/tmp", "csm-hooks-test-" + Date.now());

// Track state in memory for assertions
let mockState: ManagerState = {
  projects: {},
  archivedProjects: [],
  pinnedProjects: [],
};

vi.mock("./state", () => ({
  readState: vi.fn(() => Promise.resolve(mockState)),
  writeState: vi.fn((state: ManagerState) => {
    mockState = state;
    return Promise.resolve();
  }),
  modifyState: vi.fn(async (fn: (state: ManagerState) => unknown) => {
    const result = await fn(mockState);
    return result;
  }),
}));

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  mockState = { projects: {}, archivedProjects: [], pinnedProjects: [] };
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("processHookEvent", () => {
  it("returns matched: false when cwd is missing", async () => {
    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({ session_id: "abc" });
    expect(result).toEqual({ matched: false });
  });

  it("returns matched: false when no matching session found", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            test: {
              sessionName: "test",
              worktreePath: "/project/.worktrees/test",
              branchName: "csm/test",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      cwd: "/some/other/path",
      session_id: "abc",
    });
    expect(result).toEqual({ matched: false });
  });

  it("updates session when cwd matches worktreePath", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            test: {
              sessionName: "test",
              worktreePath: "/project/.worktrees/test",
              branchName: "csm/test",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      cwd: "/project/.worktrees/test",
      session_id: "claude-session-123",
      transcript_path: "/home/user/.claude/transcripts/abc.jsonl",
    });

    expect(result.matched).toBe(true);
    expect(result.projectName).toBe("/project");
    expect(result.sessionName).toBe("test");
    expect(result.conversationId).toBeDefined();

    const session = mockState.projects["/project"]!.sessions["test"]!;
    // Hook should have created a conversation with the Claude session ID
    expect(session.conversations).toHaveLength(1);
    const convo = session.conversations[0]!;
    expect(convo.claudeSessionId).toBe("claude-session-123");
    expect(convo.transcriptPath).toBe(
      "/home/user/.claude/transcripts/abc.jsonl",
    );
    expect(convo.source).toBe("imported");
  });

  it("only updates provided fields (partial update)", async () => {
    mockState = {
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/proj/.worktrees/s1",
              branchName: "csm/s1",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-1",
                  name: null,
                  claudeSessionId: "existing-id",
                  transcriptPath: null,
                  status: "ready",

                  promptCount: 0,
                  createdAt: "2024-01-01T00:00:00Z",
                  lastActivityAt: "2024-01-01T00:00:00Z",
                  source: "csm",
                  summary: null,
                  archived: false,
                },
              ],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    await processHookEvent({
      cwd: "/proj/.worktrees/s1",
      session_id: "existing-id",
      transcript_path: "/new/path.jsonl",
    });

    const session = mockState.projects["/proj"]!.sessions["s1"]!;
    const convo = session.conversations[0]!;
    expect(convo.claudeSessionId).toBe("existing-id");
    expect(convo.transcriptPath).toBe("/new/path.jsonl");
  });

  it("links hook to running CSM conversation instead of creating duplicate", async () => {
    // Simulates the race condition: executePrompt has set status to "running"
    // but hasn't yet stored the claudeSessionId (still null). The hook fires
    // with the session_id from Claude CLI.
    mockState = {
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/proj/.worktrees/s1",
              branchName: "csm/s1",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-csm-1",
                  name: null,
                  claudeSessionId: null,
                  transcriptPath: null,
                  status: "running",

                  promptCount: 0,
                  createdAt: "2024-01-01T00:00:00Z",
                  lastActivityAt: "2024-01-01T00:00:01Z",
                  source: "csm",
                  summary: null,
                  archived: false,
                },
              ],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    await processHookEvent({
      cwd: "/proj/.worktrees/s1",
      session_id: "claude-new-session-456",
      transcript_path: "/home/user/.claude/transcripts/456.jsonl",
    });

    const session = mockState.projects["/proj"]!.sessions["s1"]!;
    // Should NOT have created a second conversation
    expect(session.conversations).toHaveLength(1);
    // Should have linked the session ID to the existing conversation
    const convo = session.conversations[0]!;
    expect(convo.id).toBe("conv-csm-1");
    expect(convo.claudeSessionId).toBe("claude-new-session-456");
    expect(convo.transcriptPath).toBe(
      "/home/user/.claude/transcripts/456.jsonl",
    );
  });

  it("sets conversation status to ready on Stop event", async () => {
    mockState = {
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/proj/.worktrees/s1",
              branchName: "csm/s1",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-running",
                  name: null,
                  claudeSessionId: "session-abc",
                  transcriptPath: null,
                  status: "running",
                  promptCount: 1,
                  createdAt: "2024-01-01T00:00:00Z",
                  lastActivityAt: "2024-01-01T00:00:00Z",
                  source: "csm",
                  summary: null,
                  archived: false,
                },
              ],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    await processHookEvent({
      cwd: "/proj/.worktrees/s1",
      session_id: "session-abc",
      hook_event_name: "Stop",
    });

    const convo =
      mockState.projects["/proj"]!.sessions["s1"]!.conversations[0]!;
    expect(convo.status).toBe("ready");
  });

  it("does not change status on non-Stop events", async () => {
    mockState = {
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/proj/.worktrees/s1",
              branchName: "csm/s1",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-running",
                  name: null,
                  claudeSessionId: "session-abc",
                  transcriptPath: null,
                  status: "running",
                  promptCount: 1,
                  createdAt: "2024-01-01T00:00:00Z",
                  lastActivityAt: "2024-01-01T00:00:00Z",
                  source: "csm",
                  summary: null,
                  archived: false,
                },
              ],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    await processHookEvent({
      cwd: "/proj/.worktrees/s1",
      session_id: "session-abc",
      hook_event_name: "UserPromptSubmit",
    });

    const convo =
      mockState.projects["/proj"]!.sessions["s1"]!.conversations[0]!;
    expect(convo.status).toBe("running");
  });

  it("creates new conversation when no running CSM conversation exists", async () => {
    // When the hook fires and there's no running CSM conversation (e.g.,
    // Claude was started directly from the CLI), it should create a new one.
    mockState = {
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/proj/.worktrees/s1",
              branchName: "csm/s1",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-idle",
                  name: null,
                  claudeSessionId: null,
                  transcriptPath: null,
                  status: "ready",

                  promptCount: 0,
                  createdAt: "2024-01-01T00:00:00Z",
                  lastActivityAt: "2024-01-01T00:00:00Z",
                  source: "csm",
                  summary: null,
                  archived: false,
                },
              ],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    await processHookEvent({
      cwd: "/proj/.worktrees/s1",
      session_id: "cli-session-789",
      transcript_path: "/home/user/.claude/transcripts/789.jsonl",
    });

    const session = mockState.projects["/proj"]!.sessions["s1"]!;
    // Should have created a second conversation (the CLI one)
    expect(session.conversations).toHaveLength(2);
    const newConvo = session.conversations.find(
      (c) => c.claudeSessionId === "cli-session-789",
    );
    expect(newConvo).toBeDefined();
    expect(newConvo!.source).toBe("imported");
    // Original conversation should be unchanged
    const original = session.conversations.find((c) => c.id === "conv-idle");
    expect(original!.claudeSessionId).toBeNull();
  });
});

// ===========================================================================
// Container identity-based hook matching (Req 8.3)
// ===========================================================================

describe("processHookEvent — container identity matching", () => {
  it("matches session by csm_project_path and csm_session_name", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            "container-session": {
              sessionName: "container-session",
              worktreePath: "/project/.worktrees/container-session",
              branchName: "csm/container-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: "abc123",
              containerStatus: "running" as const,
              containerError: null,
              claudeHostDir: "/tmp/claude-dir",
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      session_id: "claude-container-sess",
      csm_project_path: "/project",
      csm_session_name: "container-session",
      hook_event_name: "UserPromptSubmit",
    });

    expect(result.matched).toBe(true);
    expect(result.sessionName).toBe("container-session");
    expect(result.conversationId).toBeDefined();

    const session = mockState.projects["/project"]!.sessions["container-session"]!;
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]!.claudeSessionId).toBe("claude-container-sess");
  });

  it("prefers container identity over cwd matching", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            "cwd-session": {
              sessionName: "cwd-session",
              worktreePath: "/workspace",
              branchName: "csm/cwd-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
            "container-session": {
              sessionName: "container-session",
              worktreePath: "/project/.worktrees/container-session",
              branchName: "csm/container-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: "abc123",
              containerStatus: "running" as const,
              containerError: null,
              claudeHostDir: "/tmp/claude-dir",
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    // Send both cwd and identity — identity should win
    const result = await processHookEvent({
      session_id: "sess-123",
      cwd: "/workspace",
      csm_project_path: "/project",
      csm_session_name: "container-session",
    });

    expect(result.matched).toBe(true);
    expect(result.sessionName).toBe("container-session");
  });

  it("falls back to cwd when container identity fields are absent", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            "host-session": {
              sessionName: "host-session",
              worktreePath: "/project/.worktrees/host-session",
              branchName: "csm/host-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      session_id: "sess-456",
      cwd: "/project/.worktrees/host-session",
    });

    expect(result.matched).toBe(true);
    expect(result.sessionName).toBe("host-session");
  });

  it("returns matched: false when container identity does not match any session", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            "existing": {
              sessionName: "existing",
              worktreePath: "/project/.worktrees/existing",
              branchName: "csm/existing",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      session_id: "sess-789",
      csm_project_path: "/project",
      csm_session_name: "nonexistent-session",
    });

    expect(result.matched).toBe(false);
  });
});
