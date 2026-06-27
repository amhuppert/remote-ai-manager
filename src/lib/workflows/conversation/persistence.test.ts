import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  persistConversationSnapshot,
  restoreConversationSnapshot,
  validateRestoredSnapshot,
  clearConversationSnapshot,
  setPersistenceDeps,
  _resetForTesting,
} from "./persistence";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { ConversationState } from "@/lib/conversations/schemas";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "sess-1";
const CONVERSATION_ID = "conv-1";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: CONVERSATION_ID,
    scope: "session",
    name: null,
    transcriptPath: null,
    status: "awaiting",
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
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    ...overrides,
  };
}

describe("conversation persistence", () => {
  let fixture: PersistenceFixture;

  /** Reload the seeded conversation through the real serialization boundary. */
  async function reloadConversation(): Promise<ConversationState> {
    const conversation = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    if (!conversation) {
      throw new Error("seeded conversation missing after reload");
    }
    return conversation;
  }

  beforeEach(async () => {
    _resetForTesting();
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      makeConversation(),
    );
    setPersistenceDeps(fixture.deps);
  });

  afterEach(() => {
    _resetForTesting();
    fixture.close();
  });

  describe("persistConversationSnapshot", () => {
    it("persists the snapshot to the conversation record", async () => {
      const snapshot = { value: "idle" } as never;

      persistConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        snapshot,
        { immediate: true },
      );

      await vi.waitFor(async () => {
        const reloaded = await reloadConversation();
        expect(reloaded.machineSnapshot).toEqual({ value: "idle" });
      });
    });

    it("debounces writes by default", async () => {
      vi.useFakeTimers();
      try {
        persistConversationSnapshot(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          {
            value: "idle",
          } as never,
        );

        // Nothing persisted before the debounce window elapses.
        const beforeDebounce = await reloadConversation();
        expect(beforeDebounce.machineSnapshot).toBeNull();

        // Advance past the debounce; this fires the timer and flushes the
        // async write through the real write queue.
        await vi.advanceTimersByTimeAsync(600);

        const afterDebounce = await reloadConversation();
        expect(afterDebounce.machineSnapshot).toEqual({ value: "idle" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("restoreConversationSnapshot", () => {
    async function seedSnapshot(snapshot: unknown): Promise<void> {
      await fixture.deps.mutateConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "test.seed-snapshot",
        (conversation) => {
          conversation.machineSnapshot = snapshot;
        },
      );
    }

    it("returns snapshot when schema version matches", async () => {
      const snapshot = {
        context: { _schemaVersion: 1, conversationId: CONVERSATION_ID },
        value: "idle",
      };
      await seedSnapshot(snapshot);

      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toEqual(snapshot);
    });

    it("returns null when schema version mismatches", async () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: CONVERSATION_ID },
        value: "idle",
      };
      await seedSnapshot(snapshot);

      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when no snapshot exists", async () => {
      // The seeded conversation already has a null machineSnapshot.
      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when conversation not found", async () => {
      const result = await restoreConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        "missing-conv",
        1,
      );
      expect(result).toBeNull();
    });
  });

  describe("validateRestoredSnapshot", () => {
    it("returns snapshot when schema version matches", () => {
      const snapshot = {
        context: { _schemaVersion: 1, conversationId: CONVERSATION_ID },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).toEqual(snapshot);
    });

    it("returns null when schema version mismatches", () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: CONVERSATION_ID },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).toBeNull();
    });

    it("returns null when snapshot is null", () => {
      const result = validateRestoredSnapshot(null, CONVERSATION_ID, 1);
      expect(result).toBeNull();
    });

    it("returns null when snapshot has no context", () => {
      const result = validateRestoredSnapshot(
        { value: "idle" },
        CONVERSATION_ID,
        1,
      );
      expect(result).toBeNull();
    });

    it("coerces legacy persisted activeTurn (no kind) to conversation_turn variant and preserves all fields", () => {
      // Shaped like a pre-discriminator activeTurn — no `kind` field. The
      // restorer must add kind='conversation_turn' so the new machine code
      // matches the variant.
      const legacyActiveTurn = {
        promptText: "do the thing",
        images: [],
        backend: "claude",
        modelId: null,
        effort: null,
        autonomous: false,
        startedAt: "2024-01-01T00:00:00Z",
        streamId: "stream-legacy",
      };
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: CONVERSATION_ID,
          activeTurn: { ...legacyActiveTurn },
        },
        value: "executing",
      };

      const result = validateRestoredSnapshot(snapshot, CONVERSATION_ID, 1);

      expect(result).not.toBeNull();
      const restoredActiveTurn = (
        result as unknown as {
          context: { activeTurn: Record<string, unknown> };
        }
      ).context.activeTurn;
      expect(restoredActiveTurn).toEqual({
        kind: "conversation_turn",
        ...legacyActiveTurn,
      });

      // Re-serializing the in-memory shape into the persisted JSON form
      // round-trips the legacy fields verbatim — only `kind` is added.
      const reSerialized = JSON.parse(JSON.stringify(restoredActiveTurn));
      const { kind, ...withoutKind } = reSerialized as {
        kind: string;
      } & typeof legacyActiveTurn;
      expect(kind).toBe("conversation_turn");
      expect(withoutKind).toEqual(legacyActiveTurn);
    });

    it("round-trips a task_run activeTurn variant unchanged", () => {
      const taskRunActiveTurn = {
        kind: "task_run",
        startedAt: "2024-02-02T00:00:00Z",
        outputFormat: {
          type: "json_schema",
          schema: { type: "object" },
        },
      };
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: "conv-2",
          activeTurn: { ...taskRunActiveTurn },
        },
        value: "executing",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-2", 1);

      expect(result).not.toBeNull();
      const restoredActiveTurn = (
        result as unknown as {
          context: { activeTurn: Record<string, unknown> };
        }
      ).context.activeTurn;
      expect(restoredActiveTurn).toEqual(taskRunActiveTurn);

      const reSerialized = JSON.parse(JSON.stringify(restoredActiveTurn));
      expect(reSerialized).toEqual(taskRunActiveTurn);
    });

    it("leaves a null activeTurn untouched", () => {
      const snapshot = {
        context: {
          _schemaVersion: 1,
          conversationId: "conv-3",
          activeTurn: null,
        },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-3", 1);

      expect(result).not.toBeNull();
      const restored = result as unknown as {
        context: { activeTurn: unknown };
      };
      expect(restored.context.activeTurn).toBeNull();
    });
  });

  describe("clearConversationSnapshot", () => {
    it("clears a persisted machineSnapshot back to null", async () => {
      await fixture.deps.mutateConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "test.seed-snapshot",
        (conversation) => {
          conversation.machineSnapshot = { value: "idle" };
        },
      );
      const seeded = await reloadConversation();
      expect(seeded.machineSnapshot).toEqual({ value: "idle" });

      await clearConversationSnapshot(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
      );

      const reloaded = await reloadConversation();
      expect(reloaded.machineSnapshot).toBeNull();
    });
  });
});
