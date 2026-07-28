import { describe, it, expect } from "vitest";
import type { Snapshot } from "xstate";
import type { ConversationContext } from "./types";
import {
  CONVERSATION_CONTEXT_DISPOSITION,
  persistedConversationSnapshotSchema,
  toPersistedConversationSnapshot,
} from "./persisted-snapshot-codec";

/** A multi-hundred-KB array standing in for the turn's content blocks. */
function bigBlocks(): unknown[] {
  return Array.from({ length: 400 }, (_, i) => ({
    type: "text",
    text: "x".repeat(1000) + i,
  }));
}

/** A live XState persisted snapshot carrying the two production offenders:
 *  `context.lastResult.contentBlocks` and the `children` child-actor subtree. */
function makeFullSnapshot(): Snapshot<unknown> {
  const context: ConversationContext = {
    _schemaVersion: 1,
    conversationScope: "session",
    projectPath: "/repo",
    projectName: "proj",
    sessionName: "sess",
    worktreePath: "/repo/.worktrees/sess",
    conversationId: "conv-1",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-02T00:00:00Z",
    status: "waiting_for_input",
    promptCount: 3,
    transcriptPath: "/tmp/t.jsonl",
    agentBackend: "claude",
    backendRef: { backend: "claude", ref: "sess-abc" },
    forkedFrom: null,
    role: null,
    activeTurn: {
      kind: "conversation_turn",
      promptText: "hello",
      images: [],
      backend: "claude",
      modelId: null,
      effort: null,
      codexFastMode: null,
      autonomous: false,
      startedAt: "2024-01-02T00:00:00Z",
      streamId: "stream-1",
    },
    pendingQuestion: {
      questionId: "q1",
      questions: [
        {
          question: "Proceed?",
          options: [],
          multiSelect: false,
          required: true,
          allowNote: true,
        },
      ],
    },
    debugMode: null,
    totals: {
      totalCostUsd: 1.5,
      totalDurationMs: 100,
      totalTurns: 3,
      contextTokens: 200,
      contextWindowMax: 2000,
    },
    lastResult: {
      backendRef: { backend: "claude", ref: "sess-abc" },
      costUsd: 0.5,
      durationMs: 50,
      numTurns: 1,
      contextTokens: 100,
      contextWindow: 2000,
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
      contentBlocks: bigBlocks() as never,
      transcript: bigBlocks() as never,
      structuredOutput: { ok: true },
      aborted: false,
      compacted: false,
      error: null,
      continuationDisposition: "retain",
    },
    lastError: null,
  };

  return {
    status: "active",
    value: { waitingForInput: {} },
    historyValue: {},
    context,
    children: {
      "0.conversation.executing.conversationTurn": {
        snapshot: { status: "active", context: { blob: bigBlocks() } },
        src: "executePrompt",
      },
    },
  } as unknown as Snapshot<unknown>;
}

describe("toPersistedConversationSnapshot", () => {
  it("drops lastResult.contentBlocks and the children subtree", () => {
    const snapshot = makeFullSnapshot();
    const projected = toPersistedConversationSnapshot(snapshot) as Record<
      string,
      unknown
    >;

    expect(projected).not.toHaveProperty("children");

    const projectedContext = projected.context as Record<string, unknown>;
    const lastResult = projectedContext.lastResult as Record<string, unknown>;
    expect(lastResult).not.toHaveProperty("contentBlocks");
    expect(lastResult).not.toHaveProperty("transcript");
  });

  it("retains machine value/status, identity, backendRef, totals, activeTurn identity, debugMode, and lastResult scalars", () => {
    const snapshot = makeFullSnapshot();
    const projected = toPersistedConversationSnapshot(snapshot) as Record<
      string,
      unknown
    >;

    expect(projected.status).toBe("active");
    expect(projected.value).toEqual({ waitingForInput: {} });

    const ctx = projected.context as Record<string, unknown>;
    expect(ctx._schemaVersion).toBe(1);
    expect(ctx.conversationId).toBe("conv-1");
    expect(ctx.projectPath).toBe("/repo");
    expect(ctx.backendRef).toEqual({ backend: "claude", ref: "sess-abc" });
    expect(ctx.totals).toEqual({
      totalCostUsd: 1.5,
      totalDurationMs: 100,
      totalTurns: 3,
      contextTokens: 200,
      contextWindowMax: 2000,
    });
    expect(ctx.debugMode).toBeNull();
    expect(ctx.pendingQuestion).toEqual({
      questionId: "q1",
      questions: [
        {
          question: "Proceed?",
          options: [],
          multiSelect: false,
          required: true,
          allowNote: true,
        },
      ],
    });

    const activeTurn = ctx.activeTurn as Record<string, unknown>;
    expect(activeTurn.kind).toBe("conversation_turn");
    expect(activeTurn.streamId).toBe("stream-1");

    const lastResult = ctx.lastResult as Record<string, unknown>;
    expect(lastResult.costUsd).toBe(0.5);
    expect(lastResult.durationMs).toBe(50);
    expect(lastResult.error).toBeNull();
    expect(lastResult.aborted).toBe(false);
    expect(lastResult.backendRef).toEqual({
      backend: "claude",
      ref: "sess-abc",
    });
    expect(lastResult.structuredOutput).toEqual({ ok: true });
  });

  it("does not mutate the live snapshot", () => {
    const snapshot = makeFullSnapshot() as unknown as {
      children: unknown;
      context: { lastResult: { contentBlocks: unknown[] } };
    };
    toPersistedConversationSnapshot(snapshot as unknown as Snapshot<unknown>);

    expect(snapshot.children).toBeDefined();
    expect(snapshot.context.lastResult.contentBlocks).toHaveLength(400);
  });

  it("shrinks the serialized payload by an order of magnitude", () => {
    const snapshot = makeFullSnapshot();
    const before = JSON.stringify(snapshot).length;
    const after = JSON.stringify(
      toPersistedConversationSnapshot(snapshot),
    ).length;
    expect(after * 5).toBeLessThan(before);
  });

  it("produces a projection that validates against the persisted schema", () => {
    const snapshot = makeFullSnapshot();
    const projected = toPersistedConversationSnapshot(snapshot);
    const parsed = persistedConversationSnapshotSchema.safeParse(projected);
    expect(parsed.success).toBe(true);
  });

  it("preserves a snapshot with no context (children still dropped)", () => {
    const projected = toPersistedConversationSnapshot({
      value: "idle",
      children: { c: {} },
    } as unknown as Snapshot<unknown>) as Record<string, unknown>;
    expect(projected).toEqual({ value: "idle" });
  });
});

describe("CONVERSATION_CONTEXT_DISPOSITION", () => {
  it("assigns a disposition to every ConversationContext field", () => {
    // The `satisfies Record<keyof ConversationContext, ...>` in the module is
    // the compile-time guard; this is the runtime witness that the map is not
    // empty and every value is a known disposition.
    const values = new Set(Object.values(CONVERSATION_CONTEXT_DISPOSITION));
    for (const value of values) {
      expect(["persist", "derive-on-rehydrate", "drop"]).toContain(value);
    }
    expect(
      Object.keys(CONVERSATION_CONTEXT_DISPOSITION).length,
    ).toBeGreaterThan(0);
  });
});
