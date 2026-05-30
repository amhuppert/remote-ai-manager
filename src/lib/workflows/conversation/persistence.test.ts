import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  persistConversationSnapshot,
  restoreConversationSnapshot,
  validateRestoredSnapshot,
  clearConversationSnapshot,
  setPersistenceDeps,
  _resetForTesting,
} from "./persistence";
import type { ConversationState } from "@/lib/conversations/schemas";
function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-1",
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
    ...overrides,
  };
}

describe("conversation persistence", () => {
  const mockMutateConversation = vi.fn();
  const mockGetConversation = vi.fn();

  beforeEach(() => {
    _resetForTesting();
    mockMutateConversation.mockReset();
    mockGetConversation.mockReset();
    setPersistenceDeps({
      mutateConversation: mockMutateConversation,
      getConversation: mockGetConversation,
    });
  });

  afterEach(() => {
    _resetForTesting();
  });

  describe("persistConversationSnapshot", () => {
    it("calls mutateConversation with the snapshot", async () => {
      mockMutateConversation.mockImplementation(
        async (
          _projectPath: string,
          _sessionName: string,
          _conversationId: string,
          _label: string,
          mutate: (c: ConversationState) => void,
        ) => {
          const conv = makeConversation();
          mutate(conv);
          expect(conv.machineSnapshot).toEqual({ value: "idle" });
        },
      );

      persistConversationSnapshot(
        "/repo",
        "sess-1",
        "conv-1",
        {
          value: "idle",
        } as never,
        { immediate: true },
      );

      // Wait for the async write
      await vi.waitFor(() => {
        expect(mockMutateConversation).toHaveBeenCalledOnce();
      });
    });

    it("debounces writes by default", async () => {
      vi.useFakeTimers();

      persistConversationSnapshot("/repo", "sess-1", "conv-1", {
        value: "idle",
      } as never);

      // Not called yet
      expect(mockMutateConversation).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(600);

      expect(mockMutateConversation).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });

  describe("restoreConversationSnapshot", () => {
    it("returns snapshot when schema version matches", async () => {
      const snapshot = {
        context: { _schemaVersion: 1, conversationId: "conv-1" },
        value: "idle",
      };
      const conv = makeConversation({ machineSnapshot: snapshot });
      mockGetConversation.mockResolvedValue(conv);

      const result = await restoreConversationSnapshot(
        "/repo",
        "sess-1",
        "conv-1",
        1,
      );
      expect(result).toEqual(snapshot);
    });

    it("returns null when schema version mismatches", async () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: "conv-1" },
        value: "idle",
      };
      const conv = makeConversation({ machineSnapshot: snapshot });
      mockGetConversation.mockResolvedValue(conv);

      const result = await restoreConversationSnapshot(
        "/repo",
        "sess-1",
        "conv-1",
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when no snapshot exists", async () => {
      const conv = makeConversation({ machineSnapshot: null });
      mockGetConversation.mockResolvedValue(conv);

      const result = await restoreConversationSnapshot(
        "/repo",
        "sess-1",
        "conv-1",
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when conversation not found", async () => {
      mockGetConversation.mockResolvedValue(null);

      const result = await restoreConversationSnapshot(
        "/repo",
        "sess-1",
        "conv-1",
        1,
      );
      expect(result).toBeNull();
    });
  });

  describe("validateRestoredSnapshot", () => {
    it("returns snapshot when schema version matches without reading state", () => {
      const snapshot = {
        context: { _schemaVersion: 1, conversationId: "conv-1" },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-1", 1);

      expect(result).toEqual(snapshot);
      expect(mockGetConversation).not.toHaveBeenCalled();
    });

    it("returns null when schema version mismatches without reading state", () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: "conv-1" },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-1", 1);

      expect(result).toBeNull();
      expect(mockGetConversation).not.toHaveBeenCalled();
    });

    it("returns null when snapshot is null", () => {
      const result = validateRestoredSnapshot(null, "conv-1", 1);
      expect(result).toBeNull();
    });

    it("returns null when snapshot has no context", () => {
      const result = validateRestoredSnapshot({ value: "idle" }, "conv-1", 1);
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
          conversationId: "conv-1",
          activeTurn: { ...legacyActiveTurn },
        },
        value: "executing",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-1", 1);

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
    it("sets machineSnapshot to null", async () => {
      mockMutateConversation.mockImplementation(
        async (
          _projectPath: string,
          _sessionName: string,
          _conversationId: string,
          _label: string,
          mutate: (c: ConversationState) => void,
        ) => {
          const conv = makeConversation({
            machineSnapshot: { value: "idle" },
          });
          mutate(conv);
          expect(conv.machineSnapshot).toBeNull();
        },
      );

      await clearConversationSnapshot("/repo", "sess-1", "conv-1");
      expect(mockMutateConversation).toHaveBeenCalledOnce();
    });
  });
});
