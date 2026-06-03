import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createConfigReader } from "../config/loader";
import { createStateManager } from "../state-store";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "../state-store/state-db";
import { createConversationService } from "./service";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
  deriveSessionLastActivity,
} from "../sessions/derived";
import {
  conversationStatusSchema,
  conversationStateSchema,
} from "@/lib/conversations/schemas";
import type { TranscriptEntry } from "../prompt/transcript";

// ============================================================
// Test helpers
// ============================================================

let TEST_DIR: string;

interface FakeForkSessionCall {
  sourceSessionId: string;
  options: { dir?: string; upToMessageId?: string } | undefined;
}

function makeFakeForkSession(
  result: { sessionId: string } | (() => Promise<{ sessionId: string }>) = {
    sessionId: "fake-forked-session-id",
  },
) {
  const calls: FakeForkSessionCall[] = [];
  const fn = async (
    sourceSessionId: string,
    options?: { dir?: string; upToMessageId?: string },
  ): Promise<{ sessionId: string }> => {
    calls.push({ sourceSessionId, options });
    if (typeof result === "function") {
      return result();
    }
    return result;
  };
  return { fn, calls };
}

function createTestServices(
  overrides: {
    forkSession?: ReturnType<typeof makeFakeForkSession>["fn"];
  } = {},
) {
  const configReader = createConfigReader(TEST_DIR);
  const state = createStateManager({
    readConfig: () => configReader.readConfig(),
  });
  const fakeFork = overrides.forkSession ?? makeFakeForkSession().fn;
  const conversations = createConversationService({
    mutateSession: state.mutateSession,
    getSession: state.getSession,
    getConversation: state.getConversation,
    getSessionConversations: state.getSessionConversations,
    setConversationPendingPromptText: state.setConversationPendingPromptText,
    configDir: TEST_DIR,
    forkSession: fakeFork,
  });
  return { state, conversations };
}

async function writeSourceTranscript(
  filePath: string,
  entries: TranscriptEntry[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, content, "utf-8");
}

function userEntry(text: string, timestamp: string): TranscriptEntry {
  return {
    timestamp,
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistantEntry(
  text: string,
  uuid: string,
  timestamp: string,
): TranscriptEntry {
  return {
    timestamp,
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text }],
    uuid,
  };
}

function assistantEntryNoUuid(
  text: string,
  timestamp: string,
): TranscriptEntry {
  return {
    timestamp,
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function makeConvo(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: crypto.randomUUID(),
    scope: "session",
    name: null,
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
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude" as const,
    backendRef: null,
    unread: false,
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
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(async () => {
  _resetStateDb();
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

describe("setConversationPendingPromptText", () => {
  it("persists a non-empty string", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo({ id: convoId })],
    });

    await conversations.setConversationPendingPromptText(
      "/proj",
      "test",
      convoId,
      "draft prompt",
    );

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.pendingPromptText).toBe("draft prompt");
  });

  it("clears the field when text is null", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [
        makeConvo({ id: convoId, pendingPromptText: "previous draft" }),
      ],
    });

    await conversations.setConversationPendingPromptText(
      "/proj",
      "test",
      convoId,
      null,
    );

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.pendingPromptText).toBeNull();
  });

  it("overwrites a previous value", async () => {
    const convoId = crypto.randomUUID();
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [
        makeConvo({ id: convoId, pendingPromptText: "previous" }),
      ],
    });

    await conversations.setConversationPendingPromptText(
      "/proj",
      "test",
      convoId,
      "next",
    );

    const session = await state.getSession("/proj", "test");
    expect(session!.conversations[0]!.pendingPromptText).toBe("next");
  });

  it("throws for non-existent conversation ID", async () => {
    const { state, conversations } = createTestServices();
    await seedSession(state, {
      conversations: [makeConvo()],
    });

    await expect(
      conversations.setConversationPendingPromptText(
        "/proj",
        "test",
        "nonexistent-id",
        "x",
      ),
    ).rejects.toThrow(
      'Conversation "nonexistent-id" not found in session "test"',
    );
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

  it("returns running when an active collaboration envelope is running and no conversations are active", () => {
    const session = makeSessionWith([], {
      workflowEnvelopes: {
        "wf-1": {
          workflowId: "wf-1",
          workflowType: "collaboration",
          status: "running",
          phase: "round",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          featureSnapshot: {},
        },
      },
    });

    expect(deriveSessionStatus(session)).toBe("running");
  });

  it("returns waiting_for_input when a collaboration envelope is paused", () => {
    const session = makeSessionWith([], {
      workflowEnvelopes: {
        "wf-1": {
          workflowId: "wf-1",
          workflowType: "collaboration",
          status: "paused",
          phase: "awaiting-user-input",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          featureSnapshot: {},
        },
      },
    });

    expect(deriveSessionStatus(session)).toBe("waiting_for_input");
  });

  it("ignores collaboration envelopes that are completed or failed", () => {
    const session = makeSessionWith([], {
      workflowEnvelopes: {
        "wf-1": {
          workflowId: "wf-1",
          workflowType: "collaboration",
          status: "completed",
          phase: "done",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          featureSnapshot: {},
        },
      },
    });

    expect(deriveSessionStatus(session)).toBe("idle");
  });

  it("ignores envelopes whose workflowType is not collaboration", () => {
    const session = makeSessionWith([], {
      workflowEnvelopes: {
        "wf-1": {
          workflowId: "wf-1",
          workflowType: "graph-workflow",
          status: "running",
          phase: "step",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          featureSnapshot: {},
        },
      },
    });

    expect(deriveSessionStatus(session)).toBe("idle");
  });

  it("prefers waiting_for_input from paused envelope over conversation new status", () => {
    const session = makeSessionWith([makeConvo({ status: "new" })], {
      workflowEnvelopes: {
        "wf-1": {
          workflowId: "wf-1",
          workflowType: "collaboration",
          status: "paused",
          phase: "awaiting-user-input",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          featureSnapshot: {},
        },
      },
    });

    expect(deriveSessionStatus(session)).toBe("waiting_for_input");
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
// forkConversation — role-aware semantics
// ============================================================

describe("forkConversation", () => {
  async function seedWithSourceTranscript(
    state: ReturnType<typeof createStateManager>,
    sourceId: string,
    transcriptPath: string,
    entries: TranscriptEntry[],
    sourceOverrides: Partial<ConversationState> = {},
  ) {
    await writeSourceTranscript(transcriptPath, entries);
    await seedSession(state, {
      conversations: [
        makeConvo({
          id: sourceId,
          name: "Source convo",
          transcriptPath,
          status: "awaiting",
          promptCount: 2,
          backendRef: { backend: "claude", sessionId: "src-session-abc" },
          ...sourceOverrides,
        }),
      ],
    });
  }

  /** Read the forked conversation's transcript and parse merged messages. */
  async function readForkedTranscript(transcriptPath: string) {
    const raw = await readFile(transcriptPath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TranscriptEntry);
  }

  it("case 1: fork at assistant message — inclusive copy, anchor on assistant UUID, eager native fork", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const fake = makeFakeForkSession({ sessionId: "forked-1" });
    const { state, conversations } = createTestServices({
      forkSession: fake.fn,
    });

    // u0, a1, u2, a3
    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("hello", "2024-01-01T00:00:00Z"),
      assistantEntry("hi there", "uuid-a1", "2024-01-01T00:00:01Z"),
      userEntry("more please", "2024-01-01T00:00:02Z"),
      assistantEntry("sure", "uuid-a3", "2024-01-01T00:00:03Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 1, // assistant a1
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork).toBeTruthy();
    expect(fork!.pendingPromptText).toBeNull();
    expect(fork!.forkedFrom).toEqual({
      sourceConversationId: sourceId,
      messageIndex: 1,
      sourceBackend: "claude",
      sourceBackendRef: { backend: "claude", sessionId: "src-session-abc" },
      forkLocator: "uuid-a1",
      forkMode: "native",
    });
    expect(fork!.backendRef).toEqual({
      backend: "claude",
      sessionId: "forked-1",
    });
    expect(fork!.transcriptPath).toBeTruthy();

    const copied = await readForkedTranscript(fork!.transcriptPath!);
    // Inclusive copy through index 1 → keeps u0, a1
    expect(copied).toHaveLength(2);
    expect(copied[0]!.role).toBe("user");
    expect(copied[1]!.role).toBe("assistant");
    expect(copied[1]!.uuid).toBe("uuid-a1");

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      sourceSessionId: "src-session-abc",
      options: { dir: "/proj", upToMessageId: "uuid-a1" },
    });
  });

  it("case 2: fork at user message N>0 — exclusive copy, anchor on prior assistant UUID, eager native fork, pendingPromptText set", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const fake = makeFakeForkSession({ sessionId: "forked-2" });
    const { state, conversations } = createTestServices({
      forkSession: fake.fn,
    });

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("hello", "2024-01-01T00:00:00Z"),
      assistantEntry("hi there", "uuid-a1", "2024-01-01T00:00:01Z"),
      userEntry("rewrite this", "2024-01-01T00:00:02Z"),
      assistantEntry("ok", "uuid-a3", "2024-01-01T00:00:03Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 2, // user "rewrite this"
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork).toBeTruthy();
    expect(fork!.pendingPromptText).toBe("rewrite this");
    expect(fork!.forkedFrom!.forkLocator).toBe("uuid-a1");
    expect(fork!.forkedFrom!.forkMode).toBe("native");
    expect(fork!.forkedFrom!.sourceBackendRef).toEqual({
      backend: "claude",
      sessionId: "src-session-abc",
    });
    expect(fork!.forkedFrom!.sourceBackend).toBe("claude");
    expect(fork!.backendRef).toEqual({
      backend: "claude",
      sessionId: "forked-2",
    });

    const copied = await readForkedTranscript(fork!.transcriptPath!);
    // Exclusive copy at index 2 → keeps u0, a1; excludes the user at index 2
    expect(copied).toHaveLength(2);
    expect(copied[0]!.role).toBe("user");
    expect(copied[0]!.content?.[0]).toMatchObject({ text: "hello" });
    expect(copied[1]!.role).toBe("assistant");
    expect(copied[1]!.uuid).toBe("uuid-a1");

    expect(fake.calls[0]).toEqual({
      sourceSessionId: "src-session-abc",
      options: { dir: "/proj", upToMessageId: "uuid-a1" },
    });
  });

  it("case 3: fork at user message index 0 — empty transcript, no source backend ref, no SDK fork call, pendingPromptText set", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const fake = makeFakeForkSession({ sessionId: "should-not-be-used" });
    const { state, conversations } = createTestServices({
      forkSession: fake.fn,
    });

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("first prompt", "2024-01-01T00:00:00Z"),
      assistantEntry("response", "uuid-a1", "2024-01-01T00:00:01Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 0,
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork).toBeTruthy();
    expect(fork!.pendingPromptText).toBe("first prompt");
    expect(fork!.transcriptPath).toBeNull();
    expect(fork!.forkedFrom).toEqual({
      sourceConversationId: sourceId,
      messageIndex: 0,
      sourceBackend: null,
      sourceBackendRef: null,
      forkLocator: null,
      forkMode: null,
    });
    expect(fork!.backendRef).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("case 3: works even when the source has no backend session", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const { state, conversations } = createTestServices();

    await seedWithSourceTranscript(
      state,
      sourceId,
      transcriptPath,
      [userEntry("solo prompt", "2024-01-01T00:00:00Z")],
      { backendRef: null }, // source never engaged the SDK
    );

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 0,
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork!.pendingPromptText).toBe("solo prompt");
    expect(fork!.transcriptPath).toBeNull();
  });

  it("rejects fork when the source has no backend session and target is not index-0 user", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const { state, conversations } = createTestServices();

    await seedWithSourceTranscript(
      state,
      sourceId,
      transcriptPath,
      [
        userEntry("hello", "2024-01-01T00:00:00Z"),
        assistantEntry("hi", "uuid-a1", "2024-01-01T00:00:01Z"),
      ],
      { backendRef: null },
    );

    await expect(
      conversations.forkConversation({
        projectPath: "/proj",
        sessionName: "test",
        sourceConversationId: sourceId,
        messageIndex: 1, // assistant
      }),
    ).rejects.toThrow("no backend session");
  });

  it("rejects invalid messageIndex", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const { state, conversations } = createTestServices();

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("hello", "2024-01-01T00:00:00Z"),
      assistantEntry("hi", "uuid-a1", "2024-01-01T00:00:01Z"),
    ]);

    await expect(
      conversations.forkConversation({
        projectPath: "/proj",
        sessionName: "test",
        sourceConversationId: sourceId,
        messageIndex: 99,
      }),
    ).rejects.toThrow("Invalid messageIndex");
  });

  it("case 4 (assistant fork): synthetic fallback when SDK forkSession throws — backendRef null, forkMode synthetic, pendingPromptText holds the seed", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const throwingFork = makeFakeForkSession(async () => {
      throw new Error("anchor not found in compacted session");
    });
    const { state, conversations } = createTestServices({
      forkSession: throwingFork.fn,
    });

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("hello there", "2024-01-01T00:00:00Z"),
      assistantEntry("hi back", "uuid-a1", "2024-01-01T00:00:01Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 1, // assistant fork
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork).toBeTruthy();
    expect(fork!.backendRef).toBeNull();
    expect(fork!.forkedFrom!.forkMode).toBe("synthetic");
    // For assistant forks pendingPromptText was null; the seed becomes its value.
    expect(fork!.pendingPromptText).not.toBeNull();
    expect(fork!.pendingPromptText).toContain("hello there");
    expect(fork!.pendingPromptText).toContain("hi back");
    expect(throwingFork.calls).toHaveLength(1);
  });

  it("case 4 (user fork): synthetic fallback prepends the seed in front of the user's edited prompt", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const throwingFork = makeFakeForkSession(async () => {
      throw new Error("compacted away");
    });
    const { state, conversations } = createTestServices({
      forkSession: throwingFork.fn,
    });

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("first question", "2024-01-01T00:00:00Z"),
      assistantEntry("first answer", "uuid-a1", "2024-01-01T00:00:01Z"),
      userEntry("rewritten turn", "2024-01-01T00:00:02Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 2, // user fork N>0
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork).toBeTruthy();
    expect(fork!.backendRef).toBeNull();
    expect(fork!.forkedFrom!.forkMode).toBe("synthetic");
    expect(fork!.pendingPromptText).not.toBeNull();
    // Seed should appear, ending with a separator before the user's edited text.
    expect(fork!.pendingPromptText).toContain("first question");
    expect(fork!.pendingPromptText).toContain("first answer");
    expect(fork!.pendingPromptText).toContain("---");
    expect(fork!.pendingPromptText!.endsWith("rewritten turn")).toBe(true);
  });

  it("case 4: typed ForkCreationError when SDK fork AND synthetic seed both fail (transcript deleted between validation and fallback)", async () => {
    const { ForkCreationError } = await import("./service");
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");

    // Initial validation read at the top of forkConversation() succeeds.
    // The injected forkSession deletes the transcript file before throwing,
    // so the synthetic-seed re-read fails and buildSyntheticForkSeed returns
    // null — exercising the typed-error path.
    const failingFork = makeFakeForkSession(async () => {
      await rm(transcriptPath, { force: true });
      throw new Error("upstream fork failed");
    });
    const { state, conversations } = createTestServices({
      forkSession: failingFork.fn,
    });

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("u0", "2024-01-01T00:00:00Z"),
      assistantEntry("a1", "uuid-a1", "2024-01-01T00:00:01Z"),
    ]);

    await expect(
      conversations.forkConversation({
        projectPath: "/proj",
        sessionName: "test",
        sourceConversationId: sourceId,
        messageIndex: 1,
      }),
    ).rejects.toBeInstanceOf(ForkCreationError);

    // The conversation must not have been added to state.
    const session = await state.getSession("/proj", "test");
    expect(session!.conversations).toHaveLength(1); // only the source
    expect(failingFork.calls).toHaveLength(1);
  });

  it("legacy transcript without assistant UUID: falls back to synthetic without calling the SDK (avoid silent divergence)", async () => {
    // When the transcript predates UUID storage (or the assistant entry lacks
    // a uuid), findForkAnchorUuid returns null. Calling the SDK without
    // upToMessageId would silently fork from the latest source state and
    // diverge from the visible truncated transcript. The implementation must
    // skip the SDK call entirely and use the synthetic seed instead.
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const fake = makeFakeForkSession({ sessionId: "must-not-be-used" });
    const { state, conversations } = createTestServices({
      forkSession: fake.fn,
    });

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("hello there", "2024-01-01T00:00:00Z"),
      assistantEntryNoUuid("hi back", "2024-01-01T00:00:01Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 1, // assistant fork — anchor would be uuid, but it's missing
    });

    const session = await state.getSession("/proj", "test");
    const fork = session!.conversations.find(
      (c) => c.id === result.conversationId,
    );
    expect(fork).toBeTruthy();
    // SDK must NOT have been called — avoids the silent-divergence bug where
    // forkSession would fork from the latest source state.
    expect(fake.calls).toHaveLength(0);
    expect(fork!.backendRef).toBeNull();
    expect(fork!.forkedFrom!.forkMode).toBe("synthetic");
    expect(fork!.forkedFrom!.forkLocator).toBeNull();
    expect(fork!.pendingPromptText).not.toBeNull();
    expect(fork!.pendingPromptText).toContain("hello there");
    expect(fork!.pendingPromptText).toContain("hi back");
  });

  it("writes the forked transcript under the injected configDir", async () => {
    const sourceId = crypto.randomUUID();
    const transcriptPath = path.join(TEST_DIR, "source.jsonl");
    const { state, conversations } = createTestServices();

    await seedWithSourceTranscript(state, sourceId, transcriptPath, [
      userEntry("hello", "2024-01-01T00:00:00Z"),
      assistantEntry("hi", "uuid-a1", "2024-01-01T00:00:01Z"),
    ]);

    const result = await conversations.forkConversation({
      projectPath: "/proj",
      sessionName: "test",
      sourceConversationId: sourceId,
      messageIndex: 1,
    });

    const expectedPath = path.join(
      TEST_DIR,
      "transcripts",
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(expectedPath)).toBe(true);
  });
});
