import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { ConversationState, SessionState } from "@/types";
import { createConfigReader } from "./config";
import { createStateManager } from "./state";
import { createConversationService } from "./conversations";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
  deriveSessionLastActivity,
} from "./session-derived";
import { conversationStatusSchema, conversationStateSchema } from "./schemas";

// ============================================================
// Test helpers
// ============================================================

let TEST_DIR: string;

function createTestServices() {
  const configReader = createConfigReader(TEST_DIR);
  const state = createStateManager({
    readConfig: () => configReader.readConfig(),
  });
  const conversations = createConversationService({
    mutateSession: state.mutateSession,
    readState: state.readState,
    getSession: state.getSession,
  });
  return { state, conversations };
}

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
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    role: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
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
    source: "cc" as const,
    objective: null,
    creationMode: "fast" as const,
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    workflow: null,
    workflowHistory: [],
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

async function seedSession(
  state: ReturnType<typeof createStateManager>,
  sessionOverrides: Record<string, unknown> = {},
) {
  await state.writeState({
    projects: {
      "/proj": {
        rootPath: "/proj",
        roadmapItems: [],
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
            source: "cc" as const,
            objective: null,
            creationMode: "fast" as const,
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            workflow: null,
            workflowHistory: [],
            graphWorkflowExecution: null,
            graphWorkflowExecutionHistory: [],
            referenceDocuments: [],
            ...sessionOverrides,
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  });
}

// ============================================================
// Lifecycle
// ============================================================

beforeEach(async () => {
  TEST_DIR = path.join("/tmp", "cc-conversations-test-" + Date.now());
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ============================================================
// Tests
// ============================================================

describe("createConversation", () => {
  it("creates a conversation with correct defaults", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const convo = await conversations.createConversation("/proj", "test");

    expect(convo.id).toBeTruthy();
    expect(convo.name).toBe("test 1");
    expect(convo.claudeSessionId).toBeNull();
    expect(convo.transcriptPath).toBeNull();
    expect(convo.status).toBe("new");
    expect(convo.promptCount).toBe(0);
    expect(convo.source).toBe("cc");
    expect(convo.summary).toBeNull();
    expect(convo.pendingQuestionId).toBeNull();
    expect(convo.pendingQuestions).toBeNull();
    expect(convo.createdAt).toBeTruthy();
    expect(convo.lastActivityAt).toBeTruthy();
  });

  it("persists the conversation to state", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const convo = await conversations.createConversation("/proj", "test");

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations).toHaveLength(1);
    expect(session!.conversations[0]!.id).toBe(convo.id);
  });

  it("generates unique IDs for each conversation", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const c1 = await conversations.createConversation("/proj", "test");
    const c2 = await conversations.createConversation("/proj", "test");

    expect(c1.id).not.toBe(c2.id);
  });

  it("throws for non-existent project", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.createConversation("/nonexistent", "test"),
    ).rejects.toThrow('Session "test" not found');
  });

  it("throws for non-existent session", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.createConversation("/proj", "nonexistent"),
    ).rejects.toThrow('Session "nonexistent" not found in project');
  });
});

describe("getConversation", () => {
  it("returns conversation by ID", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const created = await conversations.createConversation("/proj", "test");
    const found = await conversations.getConversation(
      "/proj",
      "test",
      created.id,
    );

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("returns null for non-existent conversation ID", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const result = await conversations.getConversation(
      "/proj",
      "test",
      "nonexistent-id",
    );
    expect(result).toBeNull();
  });

  it("returns null for non-existent project", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const result = await conversations.getConversation(
      "/nonexistent",
      "test",
      "any-id",
    );
    expect(result).toBeNull();
  });
});

describe("getSessionConversations", () => {
  it("returns conversations ordered by most recently active first", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    // Create two conversations (second one will have a later lastActivityAt)
    const c1 = await conversations.createConversation("/proj", "test");
    const c2 = await conversations.createConversation("/proj", "test");

    // c2 was created after c1, so c2 should appear first
    const convos = await conversations.getSessionConversations("/proj", "test");
    expect(convos).toHaveLength(2);
    expect(convos[0]!.id).toBe(c2.id);
    expect(convos[1]!.id).toBe(c1.id);
  });

  it("returns empty array for session with no conversations", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const convos = await conversations.getSessionConversations("/proj", "test");
    expect(convos).toEqual([]);
  });

  it("returns empty array for non-existent project", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const convos = await conversations.getSessionConversations(
      "/nonexistent",
      "test",
    );
    expect(convos).toEqual([]);
  });
});

describe("setConversationArchived", () => {
  it("archives a conversation and persists the change", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo({ id: convoId })],
      source: "cc" as const,
    });

    await conversations.setConversationArchived("/proj", "test", convoId, true);

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.archived).toBe(true);
  });

  it("unarchives a conversation", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo({ id: convoId, archived: true })],
      source: "cc" as const,
    });

    await conversations.setConversationArchived(
      "/proj",
      "test",
      convoId,
      false,
    );

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.archived).toBe(false);
  });

  it("throws for non-existent conversation ID", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo()],
      source: "cc" as const,
    });

    await expect(
      conversations.setConversationArchived(
        "/proj",
        "test",
        "nonexistent-id",
        true,
      ),
    ).rejects.toThrow(
      'Conversation "nonexistent-id" not found in session "test"',
    );
  });

  it("throws for non-existent session", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.setConversationArchived(
        "/proj",
        "nonexistent",
        "any-id",
        true,
      ),
    ).rejects.toThrow('Session "nonexistent" not found in project');
  });

  it("throws for non-existent project", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.setConversationArchived(
        "/nonexistent",
        "test",
        "any-id",
        true,
      ),
    ).rejects.toThrow('Session "test" not found');
  });
});

describe("renameConversation", () => {
  it("renames a conversation and persists the change", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo({ id: convoId })],
    });

    await conversations.renameConversation("/proj", "test", convoId, "My task");

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.name).toBe("My task");
  });

  it("overwrites a previous name", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo({ id: convoId, name: "Old name" })],
    });

    await conversations.renameConversation(
      "/proj",
      "test",
      convoId,
      "New name",
    );

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.name).toBe("New name");
  });

  it("throws for non-existent conversation ID", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo()],
    });

    await expect(
      conversations.renameConversation(
        "/proj",
        "test",
        "nonexistent-id",
        "Name",
      ),
    ).rejects.toThrow(
      'Conversation "nonexistent-id" not found in session "test"',
    );
  });

  it("throws for non-existent session", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.renameConversation(
        "/proj",
        "nonexistent",
        "any-id",
        "Name",
      ),
    ).rejects.toThrow('Session "nonexistent" not found in project');
  });

  it("throws for non-existent project", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.renameConversation(
        "/nonexistent",
        "test",
        "any-id",
        "Name",
      ),
    ).rejects.toThrow('Session "test" not found');
  });
});

describe("deriveSessionStatus", () => {
  it("returns waiting_for_input if any conversation has that status", () => {
    const session = makeSessionWith([
      makeConvo({ status: "awaiting" }),
      makeConvo({ status: "waiting_for_input" }),
      makeConvo({ status: "new" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("waiting_for_input");
  });

  it("returns waiting_for_input over running when both present", () => {
    const session = makeSessionWith([
      makeConvo({ status: "running" }),
      makeConvo({ status: "waiting_for_input" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("waiting_for_input");
  });

  it("returns running if any conversation is running", () => {
    const session = makeSessionWith([
      makeConvo({ status: "awaiting" }),
      makeConvo({ status: "running" }),
      makeConvo({ status: "new" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("running");
  });

  it("returns awaiting if any conversation is awaiting and none running", () => {
    const session = makeSessionWith([
      makeConvo({ status: "new" }),
      makeConvo({ status: "awaiting" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("awaiting");
  });

  it("returns new when all conversations are new", () => {
    const session = makeSessionWith([
      makeConvo({ status: "new" }),
      makeConvo({ status: "new" }),
    ]);

    expect(deriveSessionStatus(session)).toBe("new");
  });

  it("returns idle when no conversations exist", () => {
    const session = makeSessionWith([]);
    expect(deriveSessionStatus(session)).toBe("idle");
  });

  it("returns running when workflow status is running", () => {
    const session = makeSessionWith([makeConvo({ status: "awaiting" })], {
      workflow: {
        status: "running",
        objective: "test",
        fixPlan: [],
        references: [],
        config: {
          maxIterations: 20,
          iterationTimeoutMs: 3_600_000,
          contextSoftLimitTokens: 160_000,
          contextHardLimitTokens: 180_000,
          circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
          model: "opus",
          effort: "high",
        },
        circuitBreaker: {
          state: "closed",
          consecutiveNoProgress: 0,
          consecutiveSameError: 0,
          lastErrorPattern: null,
          lastProgressIteration: 0,
        },
        iterations: [],
        haltReason: null,
        generatingPlan: false,
        createdAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: null,
        totalCostUsd: 0,
        totalDurationMs: 0,
        currentIterationConversationId: null,
      },
    });

    expect(deriveSessionStatus(session)).toBe("running");
  });

  it("falls through to conversation status when workflow status is stopped", () => {
    const session = makeSessionWith([makeConvo({ status: "new" })], {
      workflow: {
        status: "stopped",
        objective: "test",
        fixPlan: [],
        references: [],
        config: {
          maxIterations: 20,
          iterationTimeoutMs: 3_600_000,
          contextSoftLimitTokens: 160_000,
          contextHardLimitTokens: 180_000,
          circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
          model: "opus",
          effort: "high",
        },
        circuitBreaker: {
          state: "closed",
          consecutiveNoProgress: 0,
          consecutiveSameError: 0,
          lastErrorPattern: null,
          lastProgressIteration: 0,
        },
        iterations: [],
        haltReason: null,
        generatingPlan: false,
        createdAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: null,
        totalCostUsd: 0,
        totalDurationMs: 0,
        currentIterationConversationId: null,
      },
    });

    expect(deriveSessionStatus(session)).toBe("new");
  });

  it("falls through to conversation status for non-active workflow states", () => {
    const session = makeSessionWith([makeConvo({ status: "running" })], {
      workflow: {
        status: "completed",
        objective: "test",
        fixPlan: [],
        references: [],
        config: {
          maxIterations: 20,
          iterationTimeoutMs: 3_600_000,
          contextSoftLimitTokens: 160_000,
          contextHardLimitTokens: 180_000,
          circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
          model: "opus",
          effort: "high",
        },
        circuitBreaker: {
          state: "closed",
          consecutiveNoProgress: 0,
          consecutiveSameError: 0,
          lastErrorPattern: null,
          lastProgressIteration: 0,
        },
        iterations: [],
        haltReason: { type: "plan_complete" },
        generatingPlan: false,
        createdAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-02T00:00:00Z",
        totalCostUsd: 1.5,
        totalDurationMs: 60000,
        currentIterationConversationId: null,
      },
    });

    expect(deriveSessionStatus(session)).toBe("running");
  });
});

describe("deriveSessionPromptCount", () => {
  it("sums prompt counts across all conversations", () => {
    const session = makeSessionWith([
      makeConvo({ promptCount: 3 }),
      makeConvo({ promptCount: 5 }),
      makeConvo({ promptCount: 2 }),
    ]);

    expect(deriveSessionPromptCount(session)).toBe(10);
  });

  it("returns 0 when no conversations exist", () => {
    const session = makeSessionWith([]);
    expect(deriveSessionPromptCount(session)).toBe(0);
  });
});

describe("deriveSessionLastActivity", () => {
  it("returns most recent lastActivityAt among conversations", () => {
    const session = makeSessionWith([
      makeConvo({ lastActivityAt: "2024-03-01T00:00:00Z" }),
      makeConvo({ lastActivityAt: "2024-06-01T00:00:00Z" }),
      makeConvo({ lastActivityAt: "2024-01-01T00:00:00Z" }),
    ]);

    expect(deriveSessionLastActivity(session)).toBe("2024-06-01T00:00:00Z");
  });

  it("falls back to session lastActivityAt when no conversations", () => {
    const session = makeSessionWith([]);
    expect(deriveSessionLastActivity(session)).toBe("2024-01-01T00:00:00Z");
  });
});

// ============================================================
// createConversation with role
// ============================================================

describe("createConversation with role", () => {
  it("defaults role to null when no opts provided", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const convo = await conversations.createConversation("/proj", "test");
    expect(convo.role).toBeNull();
  });

  it("sets role to initialization when specified", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    const convo = await conversations.createConversation("/proj", "test", {
      role: "initialization",
    });
    expect(convo.role).toBe("initialization");
  });

  it("persists the role to state", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await conversations.createConversation("/proj", "test", {
      role: "initialization",
    });

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.role).toBe("initialization");
  });
});

// ============================================================
// finalizeInitialization
// ============================================================

describe("finalizeInitialization", () => {
  it("archives the initialization conversation and creates a new one", async () => {
    const initConvoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      creationMode: "focus" as const,
      tddEnabled: true,
      workflow: null,
      objective: "Test objective",
      conversations: [
        makeConvo({ id: initConvoId, role: "initialization", promptCount: 1 }),
      ],
    });

    const result = await conversations.finalizeInitialization("/proj", "test");

    // Verify result
    expect(result.conversationId).toBeTruthy();
    expect(result.name).toBeTruthy();

    // Verify state
    const session = await state.getSession("/proj", "test");
    expect(session!.conversations).toHaveLength(2);

    // Init conversation should be archived
    const initConvo = session!.conversations.find((c) => c.id === initConvoId);
    expect(initConvo!.archived).toBe(true);

    // New conversation should have role null and not be archived
    const newConvo = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(newConvo).toBeTruthy();
    expect(newConvo!.role).toBeNull();
    expect(newConvo!.archived).toBe(false);
    expect(newConvo!.status).toBe("new");
  });

  it("throws when no initialization conversation exists", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      creationMode: "focus" as const,
      tddEnabled: true,
      workflow: null,
      objective: "Test objective",
      conversations: [makeConvo({ role: null })],
    });

    await expect(
      conversations.finalizeInitialization("/proj", "test"),
    ).rejects.toThrow("No initialization conversation found in this session");
  });

  it("throws for non-existent project", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.finalizeInitialization("/nonexistent", "test"),
    ).rejects.toThrow('Session "test" not found');
  });

  it("throws for non-existent session", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state);

    await expect(
      conversations.finalizeInitialization("/proj", "nonexistent"),
    ).rejects.toThrow('Session "nonexistent" not found in project');
  });
});

// ============================================================
// Schema Migration: conversationStatusSchema
// ============================================================

describe("conversationStatusSchema migration", () => {
  it("accepts new status values as-is", () => {
    expect(conversationStatusSchema.parse("new")).toBe("new");
    expect(conversationStatusSchema.parse("awaiting")).toBe("awaiting");
    expect(conversationStatusSchema.parse("running")).toBe("running");
  });

  it("migrates idle to new", () => {
    expect(conversationStatusSchema.parse("idle")).toBe("new");
  });

  it("migrates ready to awaiting", () => {
    expect(conversationStatusSchema.parse("ready")).toBe("awaiting");
  });

  it("rejects invalid status values", () => {
    const result = conversationStatusSchema.safeParse("invalid");
    expect(result.success).toBe(false);
  });

  it("migrates legacy status in full conversation state parsing", () => {
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
