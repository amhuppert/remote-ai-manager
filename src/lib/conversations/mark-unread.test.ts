/**
 * Tests for markUnreadOnFinish — the action body that runs when a
 * conversation transitions from running → awaiting (turn end).
 *
 * Uses factory-pattern dependency injection: each test provides its own
 * mutateConversation + publishSessionStatus fakes. No internal mocking.
 */
import { describe, it, expect, vi } from "vitest";
import {
  markUnreadOnFinish,
  markReadOnUserTurnStart,
  type MarkUnreadOnFinishDeps,
} from "./mark-unread";
import type { ConversationState, ConversationRole } from "./schemas";

function makeFakeConversation(): ConversationState {
  return {
    id: "c-1",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    source: "cc",
    summary: null,
    archived: false,
    unread: false,
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
    agentBackend: "claude",
    backendRef: null,
  } as unknown as ConversationState;
}

function makeDeps(): {
  deps: MarkUnreadOnFinishDeps;
  mutationCalls: Array<{
    projectPath: string;
    sessionName: string;
    conversationId: string;
    reason: string;
    result: ConversationState;
  }>;
  publishedEvents: Array<
    Parameters<MarkUnreadOnFinishDeps["publishSessionStatus"]>[0]
  >;
} {
  const mutationCalls: Array<{
    projectPath: string;
    sessionName: string;
    conversationId: string;
    reason: string;
    result: ConversationState;
  }> = [];
  const publishedEvents: Array<
    Parameters<MarkUnreadOnFinishDeps["publishSessionStatus"]>[0]
  > = [];

  const deps: MarkUnreadOnFinishDeps = {
    async mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      reason,
      mutator,
    ) {
      const c = makeFakeConversation();
      await mutator(c);
      mutationCalls.push({
        projectPath,
        sessionName,
        conversationId,
        reason,
        result: c,
      });
    },
    publishSessionStatus(event) {
      publishedEvents.push(event);
      return { delivered: true };
    },
  };

  return { deps, mutationCalls, publishedEvents };
}

function makeCtx(role: ConversationRole) {
  return {
    projectPath: "/proj",
    projectName: "proj-display",
    sessionName: "sess",
    conversationId: "conv-1",
    role,
  };
}

describe("markUnreadOnFinish", () => {
  it("sets unread=true and publishes a conversation-unread SSE event for a regular conversation", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();

    await markUnreadOnFinish(makeCtx(null), deps);

    expect(mutationCalls).toHaveLength(1);
    const call = mutationCalls[0]!;
    expect(call.projectPath).toBe("/proj");
    expect(call.sessionName).toBe("sess");
    expect(call.conversationId).toBe("conv-1");
    expect(call.result.unread).toBe(true);

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      type: "conversation-unread",
      projectName: "proj-display",
      sessionName: "sess",
      conversationId: "conv-1",
      unread: true,
    });
  });

  it("marks unread for the planner role (planner is a user-facing role)", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markUnreadOnFinish(makeCtx("planner"), deps);
    expect(mutationCalls).toHaveLength(1);
    expect(publishedEvents).toHaveLength(1);
  });

  it("marks unread for the initialization role", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markUnreadOnFinish(makeCtx("initialization"), deps);
    expect(mutationCalls).toHaveLength(1);
    expect(publishedEvents).toHaveLength(1);
  });

  it("does NOT mutate or publish for iteration role (workflow-managed)", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markUnreadOnFinish(makeCtx("iteration"), deps);
    expect(mutationCalls).toHaveLength(0);
    expect(publishedEvents).toHaveLength(0);
  });

  it("does NOT mutate or publish for validator role (workflow-managed)", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markUnreadOnFinish(makeCtx("validator"), deps);
    expect(mutationCalls).toHaveLength(0);
    expect(publishedEvents).toHaveLength(0);
  });

  it("does not publish when mutateConversation rejects (UI stays consistent with DB)", async () => {
    const publishedEvents: unknown[] = [];
    const deps: MarkUnreadOnFinishDeps = {
      mutateConversation: vi.fn(async () => {
        throw new Error("conversation not found");
      }),
      publishSessionStatus: (event) => {
        publishedEvents.push(event);
        return { delivered: true };
      },
    };

    await expect(markUnreadOnFinish(makeCtx(null), deps)).rejects.toThrow(
      /conversation not found/,
    );
    expect(publishedEvents).toHaveLength(0);
  });
});

describe("markReadOnUserTurnStart", () => {
  it("sets unread=false and publishes conversation-unread (unread=false) for a regular conversation", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();

    await markReadOnUserTurnStart(makeCtx(null), deps);

    expect(mutationCalls).toHaveLength(1);
    const call = mutationCalls[0]!;
    expect(call.projectPath).toBe("/proj");
    expect(call.sessionName).toBe("sess");
    expect(call.conversationId).toBe("conv-1");
    expect(call.result.unread).toBe(false);

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      type: "conversation-unread",
      projectName: "proj-display",
      sessionName: "sess",
      conversationId: "conv-1",
      unread: false,
    });
  });

  it("clears unread for the planner role", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markReadOnUserTurnStart(makeCtx("planner"), deps);
    expect(mutationCalls).toHaveLength(1);
    expect(publishedEvents).toHaveLength(1);
  });

  it("does NOT mutate or publish for iteration role (workflow-managed, never unread)", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markReadOnUserTurnStart(makeCtx("iteration"), deps);
    expect(mutationCalls).toHaveLength(0);
    expect(publishedEvents).toHaveLength(0);
  });

  it("does NOT mutate or publish for validator role", async () => {
    const { deps, mutationCalls, publishedEvents } = makeDeps();
    await markReadOnUserTurnStart(makeCtx("validator"), deps);
    expect(mutationCalls).toHaveLength(0);
    expect(publishedEvents).toHaveLength(0);
  });
});
