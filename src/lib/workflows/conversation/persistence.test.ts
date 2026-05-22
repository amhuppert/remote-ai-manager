import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  persistConversationSnapshot,
  restoreConversationSnapshot,
  validateRestoredSnapshot,
  clearConversationSnapshot,
  setPersistenceDeps,
  _resetForTesting,
} from "./persistence";
import type { ManagerState, ConversationState } from "@/types";

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
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude" as const,
    backendRef: null,
    ...overrides,
  };
}

function makeState(conversation: ConversationState): ManagerState {
  return {
    projects: {
      "/repo": {
        rootPath: "/repo",
        sessions: {
          "sess-1": {
            sessionName: "sess-1",
            worktreePath: "/repo/.worktrees/sess-1",
            branchName: "csm/sess-1",
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            archived: false,
            finished: false,
            conversations: [conversation],
            source: "cc",
            objective: null,
            creationMode: "fast",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution: null,
            graphWorkflowExecutionHistory: [],
            referenceDocuments: [],
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

describe("conversation persistence", () => {
  const mockMutateConversation = vi.fn();
  const mockReadState = vi.fn();

  beforeEach(() => {
    _resetForTesting();
    mockMutateConversation.mockReset();
    mockReadState.mockReset();
    setPersistenceDeps({
      mutateConversation: mockMutateConversation,
      readState: mockReadState,
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
      mockReadState.mockResolvedValue(makeState(conv));

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
      mockReadState.mockResolvedValue(makeState(conv));

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
      mockReadState.mockResolvedValue(makeState(conv));

      const result = await restoreConversationSnapshot(
        "/repo",
        "sess-1",
        "conv-1",
        1,
      );
      expect(result).toBeNull();
    });

    it("returns null when conversation not found", async () => {
      mockReadState.mockResolvedValue(
        makeState(makeConversation({ id: "other-conv" })),
      );

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
      expect(mockReadState).not.toHaveBeenCalled();
    });

    it("returns null when schema version mismatches without reading state", () => {
      const snapshot = {
        context: { _schemaVersion: 99, conversationId: "conv-1" },
        value: "idle",
      };

      const result = validateRestoredSnapshot(snapshot, "conv-1", 1);

      expect(result).toBeNull();
      expect(mockReadState).not.toHaveBeenCalled();
    });

    it("returns null when snapshot is null", () => {
      const result = validateRestoredSnapshot(null, "conv-1", 1);
      expect(result).toBeNull();
    });

    it("returns null when snapshot has no context", () => {
      const result = validateRestoredSnapshot({ value: "idle" }, "conv-1", 1);
      expect(result).toBeNull();
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
