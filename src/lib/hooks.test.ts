import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ManagerState } from "@/types";

const TEST_DIR = path.join("/tmp", "csm-hooks-test-" + Date.now());

// Track state in memory for assertions
let mockState: ManagerState = { projects: {}, archivedProjects: [] };

vi.mock("./state", () => ({
  readState: vi.fn(() => Promise.resolve(mockState)),
  writeState: vi.fn((state: ManagerState) => {
    mockState = state;
    return Promise.resolve();
  }),
}));

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  mockState = { projects: {}, archivedProjects: [] };
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("processHookEvent", () => {
  it("returns false when cwd is missing", async () => {
    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({ session_id: "abc" });
    expect(result).toBe(false);
  });

  it("returns false when no matching session found", async () => {
    mockState = {
      projects: {
        "/project": {
          rootPath: "/project",
          sessions: {
            test: {
              sessionName: "test",
              worktreePath: "/project/.worktrees/test",
              branchName: "csm/test",
              claudeSessionId: null,
              transcriptPath: null,
              status: "ready",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              promptCount: 0,
              archived: false,
              messages: [],
            },
          },
        },
      },
      archivedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      cwd: "/some/other/path",
      session_id: "abc",
    });
    expect(result).toBe(false);
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
              claudeSessionId: null,
              transcriptPath: null,
              status: "ready",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              promptCount: 0,
              archived: false,
              messages: [],
            },
          },
        },
      },
      archivedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    const result = await processHookEvent({
      cwd: "/project/.worktrees/test",
      session_id: "claude-session-123",
      transcript_path: "/home/user/.claude/transcripts/abc.jsonl",
    });

    expect(result).toBe(true);

    const session = mockState.projects["/project"]!.sessions["test"]!;
    expect(session.claudeSessionId).toBe("claude-session-123");
    expect(session.transcriptPath).toBe(
      "/home/user/.claude/transcripts/abc.jsonl",
    );
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
              claudeSessionId: "existing-id",
              transcriptPath: null,
              status: "ready",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              promptCount: 0,
              archived: false,
              messages: [],
            },
          },
        },
      },
      archivedProjects: [],
    };

    const { processHookEvent } = await import("./hooks");
    await processHookEvent({
      cwd: "/proj/.worktrees/s1",
      transcript_path: "/new/path.jsonl",
      // Note: no session_id — should keep existing
    });

    const session = mockState.projects["/proj"]!.sessions["s1"]!;
    expect(session.claudeSessionId).toBe("existing-id");
    expect(session.transcriptPath).toBe("/new/path.jsonl");
  });
});
