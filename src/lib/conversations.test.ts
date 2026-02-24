import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
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
            objective: null,
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
    expect(convo.name).toBe("test 1");
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
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    forkedFrom: null,
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
    objective: null,
    ...overrides,
  };
}
