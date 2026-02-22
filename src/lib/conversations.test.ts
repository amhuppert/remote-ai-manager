import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const TEST_DIR = path.join("/tmp", "csm-conversations-test-" + Date.now());
const STATE_FILE = path.join(TEST_DIR, "state.json");

vi.mock("./config", () => ({
  readConfig: vi.fn().mockResolvedValue({
    baseDir: "/tmp/projects",
    ignorePatterns: [],
    stateFilePath: STATE_FILE,
    claudeTimeoutMs: 300_000,
  }),
}));

// Mock node:os to redirect homedir to test directory for auto-import tests
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => TEST_DIR,
    },
    homedir: () => TEST_DIR,
  };
});

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// Helper to seed state with a session
async function seedSession(sessionOverrides: Record<string, unknown> = {}) {
  const { writeState } = await import("./state");
  await writeState({
    projects: {
      "/proj": {
        rootPath: "/proj",
        sessions: {
          test: {
            sessionName: "test",
            worktreePath: "/proj/.worktrees/test",
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
            ...sessionOverrides,
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  });
}

describe("createConversation", () => {
  it("creates a conversation with correct defaults", async () => {
    await seedSession();
    const { createConversation } = await import("./conversations");

    const convo = await createConversation("/proj", "test");

    expect(convo.id).toBeTruthy();
    expect(convo.name).toBeNull();
    expect(convo.claudeSessionId).toBeNull();
    expect(convo.transcriptPath).toBeNull();
    expect(convo.status).toBe("new");
    expect(convo.promptCount).toBe(0);
    expect(convo.source).toBe("csm");
    expect(convo.summary).toBeNull();
    expect(convo.createdAt).toBeTruthy();
    expect(convo.lastActivityAt).toBeTruthy();
  });

  it("persists the conversation to state", async () => {
    await seedSession();
    const { createConversation } = await import("./conversations");
    const { getSession } = await import("./state");

    const convo = await createConversation("/proj", "test");

    const session = await getSession("/proj", "test");
    expect(session!.conversations).toHaveLength(1);
    expect(session!.conversations[0]!.id).toBe(convo.id);
  });

  it("generates unique IDs for each conversation", async () => {
    await seedSession();
    const { createConversation } = await import("./conversations");

    const c1 = await createConversation("/proj", "test");
    const c2 = await createConversation("/proj", "test");

    expect(c1.id).not.toBe(c2.id);
  });

  it("throws for non-existent project", async () => {
    await seedSession();
    const { createConversation } = await import("./conversations");

    await expect(createConversation("/nonexistent", "test")).rejects.toThrow(
      "Project not found: /nonexistent",
    );
  });

  it("throws for non-existent session", async () => {
    await seedSession();
    const { createConversation } = await import("./conversations");

    await expect(createConversation("/proj", "nonexistent")).rejects.toThrow(
      'Session "nonexistent" not found in project',
    );
  });
});

describe("getConversation", () => {
  it("returns conversation by ID", async () => {
    await seedSession();
    const { createConversation, getConversation } =
      await import("./conversations");

    const created = await createConversation("/proj", "test");
    const found = await getConversation("/proj", "test", created.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("returns null for non-existent conversation ID", async () => {
    await seedSession();
    const { getConversation } = await import("./conversations");

    const result = await getConversation("/proj", "test", "nonexistent-id");
    expect(result).toBeNull();
  });

  it("returns null for non-existent project", async () => {
    await seedSession();
    const { getConversation } = await import("./conversations");

    const result = await getConversation("/nonexistent", "test", "any-id");
    expect(result).toBeNull();
  });
});

describe("getSessionConversations", () => {
  it("returns conversations ordered by most recently active first", async () => {
    await seedSession();
    const { createConversation, getSessionConversations } =
      await import("./conversations");

    // Create two conversations (second one will have a later lastActivityAt)
    const c1 = await createConversation("/proj", "test");
    const c2 = await createConversation("/proj", "test");

    // c2 was created after c1, so c2 should appear first
    const convos = await getSessionConversations("/proj", "test");
    expect(convos).toHaveLength(2);
    expect(convos[0]!.id).toBe(c2.id);
    expect(convos[1]!.id).toBe(c1.id);
  });

  it("returns empty array for session with no conversations", async () => {
    await seedSession();
    const { getSessionConversations } = await import("./conversations");

    const convos = await getSessionConversations("/proj", "test");
    expect(convos).toEqual([]);
  });

  it("returns empty array for non-existent project", async () => {
    await seedSession();
    const { getSessionConversations } = await import("./conversations");

    const convos = await getSessionConversations("/nonexistent", "test");
    expect(convos).toEqual([]);
  });
});

describe("setConversationArchived", () => {
  it("archives a conversation and persists the change", async () => {
    const convoId = crypto.randomUUID();
    await seedSession({
      conversations: [makeConvo({ id: convoId })],
      source: "csm" as const,
    });
    const { setConversationArchived } = await import("./conversations");
    const { getSession } = await import("./state");

    await setConversationArchived("/proj", "test", convoId, true);

    const session = await getSession("/proj", "test");
    expect(session!.conversations[0]!.archived).toBe(true);
  });

  it("unarchives a conversation", async () => {
    const convoId = crypto.randomUUID();
    await seedSession({
      conversations: [makeConvo({ id: convoId, archived: true })],
      source: "csm" as const,
    });
    const { setConversationArchived } = await import("./conversations");
    const { getSession } = await import("./state");

    await setConversationArchived("/proj", "test", convoId, false);

    const session = await getSession("/proj", "test");
    expect(session!.conversations[0]!.archived).toBe(false);
  });

  it("throws for non-existent conversation ID", async () => {
    await seedSession({
      conversations: [makeConvo()],
      source: "csm" as const,
    });
    const { setConversationArchived } = await import("./conversations");

    await expect(
      setConversationArchived("/proj", "test", "nonexistent-id", true),
    ).rejects.toThrow(
      'Conversation "nonexistent-id" not found in session "test"',
    );
  });

  it("throws for non-existent session", async () => {
    await seedSession();
    const { setConversationArchived } = await import("./conversations");

    await expect(
      setConversationArchived("/proj", "nonexistent", "any-id", true),
    ).rejects.toThrow('Session "nonexistent" not found in project');
  });

  it("throws for non-existent project", async () => {
    await seedSession();
    const { setConversationArchived } = await import("./conversations");

    await expect(
      setConversationArchived("/nonexistent", "test", "any-id", true),
    ).rejects.toThrow("Project not found: /nonexistent");
  });
});

describe("renameConversation", () => {
  it("renames a conversation and persists the change", async () => {
    const convoId = crypto.randomUUID();
    await seedSession({
      conversations: [makeConvo({ id: convoId })],
    });
    const { renameConversation } = await import("./conversations");
    const { getSession } = await import("./state");

    await renameConversation("/proj", "test", convoId, "My task");

    const session = await getSession("/proj", "test");
    expect(session!.conversations[0]!.name).toBe("My task");
  });

  it("overwrites a previous name", async () => {
    const convoId = crypto.randomUUID();
    await seedSession({
      conversations: [makeConvo({ id: convoId, name: "Old name" })],
    });
    const { renameConversation } = await import("./conversations");
    const { getSession } = await import("./state");

    await renameConversation("/proj", "test", convoId, "New name");

    const session = await getSession("/proj", "test");
    expect(session!.conversations[0]!.name).toBe("New name");
  });

  it("throws for non-existent conversation ID", async () => {
    await seedSession({
      conversations: [makeConvo()],
    });
    const { renameConversation } = await import("./conversations");

    await expect(
      renameConversation("/proj", "test", "nonexistent-id", "Name"),
    ).rejects.toThrow(
      'Conversation "nonexistent-id" not found in session "test"',
    );
  });

  it("throws for non-existent session", async () => {
    await seedSession();
    const { renameConversation } = await import("./conversations");

    await expect(
      renameConversation("/proj", "nonexistent", "any-id", "Name"),
    ).rejects.toThrow('Session "nonexistent" not found in project');
  });

  it("throws for non-existent project", async () => {
    await seedSession();
    const { renameConversation } = await import("./conversations");

    await expect(
      renameConversation("/nonexistent", "test", "any-id", "Name"),
    ).rejects.toThrow("Project not found: /nonexistent");
  });
});

describe("deriveSessionStatus", () => {
  it("returns running if any conversation is running", async () => {
    const { deriveSessionStatus } = await import("./conversations");

    const session = makeSessionWith([
      makeConvo({ status: "awaiting" }),
      makeConvo({ status: "running" }),
      makeConvo({ status: "new" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("running");
  });

  it("returns awaiting if any conversation is awaiting and none running", async () => {
    const { deriveSessionStatus } = await import("./conversations");

    const session = makeSessionWith([
      makeConvo({ status: "new" }),
      makeConvo({ status: "awaiting" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("awaiting");
  });

  it("returns idle when all conversations are new", async () => {
    const { deriveSessionStatus } = await import("./conversations");

    const session = makeSessionWith([
      makeConvo({ status: "new" }),
      makeConvo({ status: "new" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("idle");
  });

  it("returns idle when no conversations exist", async () => {
    const { deriveSessionStatus } = await import("./conversations");

    const session = makeSessionWith([]);
    expect(deriveSessionStatus(session)).toBe("idle");
  });
});

describe("deriveSessionPromptCount", () => {
  it("sums prompt counts across all conversations", async () => {
    const { deriveSessionPromptCount } = await import("./conversations");

    const session = makeSessionWith([
      makeConvo({ promptCount: 3 }),
      makeConvo({ promptCount: 5 }),
      makeConvo({ promptCount: 2 }),
    ]);

    expect(deriveSessionPromptCount(session)).toBe(10);
  });

  it("returns 0 when no conversations exist", async () => {
    const { deriveSessionPromptCount } = await import("./conversations");

    const session = makeSessionWith([]);
    expect(deriveSessionPromptCount(session)).toBe(0);
  });
});

describe("deriveSessionLastActivity", () => {
  it("returns most recent lastActivityAt among conversations", async () => {
    const { deriveSessionLastActivity } = await import("./conversations");

    const session = makeSessionWith([
      makeConvo({ lastActivityAt: "2024-03-01T00:00:00Z" }),
      makeConvo({ lastActivityAt: "2024-06-01T00:00:00Z" }),
      makeConvo({ lastActivityAt: "2024-01-01T00:00:00Z" }),
    ]);

    expect(deriveSessionLastActivity(session)).toBe("2024-06-01T00:00:00Z");
  });

  it("falls back to session lastActivityAt when no conversations", async () => {
    const { deriveSessionLastActivity } = await import("./conversations");

    const session = makeSessionWith([]);
    expect(deriveSessionLastActivity(session)).toBe("2024-01-01T00:00:00Z");
  });
});

// ============================================================
// Schema Migration: conversationStatusSchema
// ============================================================

describe("conversationStatusSchema migration", () => {
  it("accepts new status values as-is", async () => {
    const { conversationStatusSchema } = await import("./schemas");

    expect(conversationStatusSchema.parse("new")).toBe("new");
    expect(conversationStatusSchema.parse("awaiting")).toBe("awaiting");
    expect(conversationStatusSchema.parse("running")).toBe("running");
  });

  it("migrates idle to new", async () => {
    const { conversationStatusSchema } = await import("./schemas");

    expect(conversationStatusSchema.parse("idle")).toBe("new");
  });

  it("migrates ready to awaiting", async () => {
    const { conversationStatusSchema } = await import("./schemas");

    expect(conversationStatusSchema.parse("ready")).toBe("awaiting");
  });

  it("rejects invalid status values", async () => {
    const { conversationStatusSchema } = await import("./schemas");

    const result = conversationStatusSchema.safeParse("invalid");
    expect(result.success).toBe(false);
  });

  it("migrates legacy status in full conversation state parsing", async () => {
    const { conversationStateSchema } = await import("./schemas");

    const legacyConvo = {
      id: "test-id",
      claudeSessionId: null,
      transcriptPath: null,
      status: "idle",
      promptCount: 0,
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
    };

    const parsed = conversationStateSchema.parse(legacyConvo);
    expect(parsed.status).toBe("new");
  });
});

// ============================================================
// Auto-Import: discoverAndImportConversations (Tasks 8.1–8.3)
// ============================================================

describe("encodeProjectPath", () => {
  it("encodes filesystem paths to Claude Code directory naming convention", async () => {
    const { encodeProjectPath } = await import("./conversations");
    expect(encodeProjectPath("/home/user/project")).toBe("-home-user-project");
    expect(encodeProjectPath("/home/user/project/.worktrees/my-session")).toBe(
      "-home-user-project--worktrees-my-session",
    );
  });
});

describe("discoverAndImportConversations", () => {
  // Helper: create the Claude project dir and write sessions-index.json
  async function writeSessionsIndex(
    worktreePath: string,
    entries: Record<string, unknown>[],
  ) {
    const { encodeProjectPath } = await import("./conversations");
    const dir = path.join(
      TEST_DIR,
      ".claude",
      "projects",
      encodeProjectPath(worktreePath),
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries }),
    );
    return dir;
  }

  // Helper: write a JSONL file in the Claude project dir
  async function writeJsonlFile(
    worktreePath: string,
    filename: string,
    lines: Record<string, unknown>[],
  ) {
    const { encodeProjectPath } = await import("./conversations");
    const dir = path.join(
      TEST_DIR,
      ".claude",
      "projects",
      encodeProjectPath(worktreePath),
    );
    await mkdir(dir, { recursive: true });
    const content = lines.map((l) => JSON.stringify(l)).join("\n");
    await writeFile(path.join(dir, filename), content);
    return dir;
  }

  it("imports sessions from sessions-index.json matching by cwd", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({ worktreePath });

    await writeSessionsIndex(worktreePath, [
      {
        sessionId: "abc-123",
        fullPath: "/home/user/.claude/projects/-proj/abc-123.jsonl",
        firstPrompt: "Hello world",
        summary: "Test session",
        messageCount: 5,
        created: "2024-06-01T00:00:00Z",
        modified: "2024-06-01T01:00:00Z",
        gitBranch: "main",
        projectPath: worktreePath,
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);

    expect(imported).toHaveLength(1);
    expect(imported[0]!.claudeSessionId).toBe("abc-123");
    expect(imported[0]!.source).toBe("imported");
    expect(imported[0]!.status).toBe("new");
    expect(imported[0]!.summary).toBe("Test session");
    expect(imported[0]!.promptCount).toBe(5);
  });

  it("imports sessions matching by gitBranch", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({ worktreePath, branchName: "csm/test" });

    await writeSessionsIndex(worktreePath, [
      {
        sessionId: "branch-match-1",
        fullPath: "/path/to/transcript.jsonl",
        messageCount: 3,
        created: "2024-06-01T00:00:00Z",
        modified: "2024-06-01T01:00:00Z",
        gitBranch: "csm/test",
        projectPath: "/different/path",
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);

    expect(imported).toHaveLength(1);
    expect(imported[0]!.claudeSessionId).toBe("branch-match-1");
  });

  it("skips sessions already tracked by claudeSessionId", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({
      worktreePath,
      conversations: [makeConvo({ claudeSessionId: "already-tracked" })],
      source: "csm" as const,
    });

    await writeSessionsIndex(worktreePath, [
      {
        sessionId: "already-tracked",
        fullPath: "/path/to/transcript.jsonl",
        messageCount: 3,
        created: "2024-06-01T00:00:00Z",
        modified: "2024-06-01T01:00:00Z",
        projectPath: worktreePath,
      },
      {
        sessionId: "new-session",
        fullPath: "/path/to/new.jsonl",
        messageCount: 1,
        created: "2024-06-02T00:00:00Z",
        modified: "2024-06-02T01:00:00Z",
        projectPath: worktreePath,
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);

    expect(imported).toHaveLength(1);
    expect(imported[0]!.claudeSessionId).toBe("new-session");
  });

  it("persists imported conversations to state", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({ worktreePath });

    await writeSessionsIndex(worktreePath, [
      {
        sessionId: "persist-test",
        fullPath: "/path/to/transcript.jsonl",
        messageCount: 2,
        created: "2024-06-01T00:00:00Z",
        modified: "2024-06-01T01:00:00Z",
        projectPath: worktreePath,
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    await discoverAndImportConversations("/proj", session);

    // Re-read state to verify persistence
    const updated = (await getSession("/proj", "test"))!;
    expect(updated.conversations).toHaveLength(1);
    expect(updated.conversations[0]!.claudeSessionId).toBe("persist-test");
    expect(updated.conversations[0]!.source).toBe("imported");
  });

  it("falls back to JSONL parsing when no sessions-index.json exists", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({ worktreePath, branchName: "csm/test" });

    // Write JSONL files directly (no sessions-index.json)
    await writeJsonlFile(worktreePath, "sess-from-jsonl.jsonl", [
      {
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "2024-06-01T00:00:00Z",
        sessionId: "sess-from-jsonl",
      },
      {
        type: "user",
        sessionId: "sess-from-jsonl",
        cwd: worktreePath,
        gitBranch: "csm/test",
        timestamp: "2024-06-01T00:00:00Z",
        message: { role: "user", content: "Hello from CLI" },
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);

    expect(imported).toHaveLength(1);
    expect(imported[0]!.claudeSessionId).toBe("sess-from-jsonl");
    expect(imported[0]!.source).toBe("imported");
    expect(imported[0]!.summary).toBe("Hello from CLI");
  });

  it("returns empty array when Claude project directory does not exist", async () => {
    await seedSession({ worktreePath: "/nonexistent/path" });

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);
    expect(imported).toEqual([]);
  });

  it("filters out sessions that do not match cwd or gitBranch", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({ worktreePath, branchName: "csm/test" });

    await writeSessionsIndex(worktreePath, [
      {
        sessionId: "unrelated-session",
        fullPath: "/path/to/transcript.jsonl",
        messageCount: 3,
        created: "2024-06-01T00:00:00Z",
        modified: "2024-06-01T01:00:00Z",
        gitBranch: "feature/other",
        projectPath: "/other/project",
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);
    expect(imported).toEqual([]);
  });

  it("uses firstPrompt as summary fallback when summary is null", async () => {
    const worktreePath = "/proj/.worktrees/test";
    await seedSession({ worktreePath });

    await writeSessionsIndex(worktreePath, [
      {
        sessionId: "no-summary",
        fullPath: "/path/to/transcript.jsonl",
        firstPrompt: "Create a web scraper that handles pagination",
        summary: null,
        messageCount: 8,
        created: "2024-06-01T00:00:00Z",
        modified: "2024-06-01T01:00:00Z",
        projectPath: worktreePath,
      },
    ]);

    const { discoverAndImportConversations } = await import("./conversations");
    const { getSession } = await import("./state");
    const session = (await getSession("/proj", "test"))!;

    const imported = await discoverAndImportConversations("/proj", session);

    expect(imported).toHaveLength(1);
    expect(imported[0]!.summary).toBe(
      "Create a web scraper that handles pagination",
    );
  });
});

// ============================================================
// Test helpers
// ============================================================

import type { ConversationState, SessionState } from "@/types";

function makeConvo(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: crypto.randomUUID(),
    name: null,
    claudeSessionId: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "csm",
    summary: null,
    archived: false,
    ...overrides,
  };
}

function makeSessionWith(
  conversations: ConversationState[],
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    sessionName: "test",
    worktreePath: "/proj/.worktrees/test",
    branchName: "csm/test",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations,
    source: "csm" as const,
    containerId: null,
    containerStatus: "none" as const,
    containerError: null,
    claudeHostDir: null,
    ...overrides,
  };
}
