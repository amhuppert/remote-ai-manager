import { describe, expect, it, vi, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { fromPromise } from "xstate";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { conversationMachine } from "@/lib/workflows/conversation/machine";
import {
  sendConversationEvent,
  setMachineFactory,
  startConversationActor,
  _resetForTesting,
  _resetMachineFactoryForTesting,
} from "@/lib/workflows/conversation/manager";
import type {
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "@/lib/workflows/conversation/types";
import {
  createAskQuestionHandlers,
  type AskRouteDeps,
} from "./ask-route-handlers";

const ts = "2025-01-01T00:00:00.000Z";

function conv(overrides: Partial<ConversationState> = {}): ConversationState {
  return conversationStateSchema.parse({
    id: "conv-1",
    scope: "session",
    transcriptPath: null,
    status: "running",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    ...overrides,
  });
}

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(
    "http://127.0.0.1/api/projects/cc/sessions/sess/conversations/conv-1/ask",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

const params = Promise.resolve({
  name: "cc",
  session: "sess",
  conversationId: "conv-1",
});

function authAllows(): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return { kind: "valid" };
    },
  };
}

function authDenies(): AgentAuth {
  return {
    async requireToken() {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken() {
      return { kind: "invalid" };
    },
  };
}

function makeDeps(overrides: Partial<AskRouteDeps> = {}): {
  deps: AskRouteDeps;
  send: ReturnType<typeof vi.fn>;
  resolveLaneAskPermission: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => true);
  const resolveLaneAskPermission = vi.fn(async () => ({ allowed: false }));
  const deps: AskRouteDeps = {
    auth: authAllows(),
    async resolveProjectPath() {
      return "/repos/cc";
    },
    async getSession() {
      return { conversations: [conv()] };
    },
    sendConversationEvent: send,
    resolveLaneAskPermission,
    generateQuestionBatchId: () => "q_test1234",
    ...overrides,
  };
  return {
    deps,
    send,
    resolveLaneAskPermission: deps.resolveLaneAskPermission as ReturnType<
      typeof vi.fn
    >,
  };
}

const validBody = {
  questions: [
    {
      question: "Which order?",
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "named",
      question: "Named one?",
      options: [{ label: "Yes" }],
    },
  ],
};

afterEach(() => {
  _resetForTesting();
  _resetMachineFactoryForTesting();
});

describe("POST conversation ask", () => {
  it("rejects a missing/invalid token with 401 and fires no machine event", async () => {
    const { deps, send } = makeDeps({ auth: authDenies() });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation does not exist", async () => {
    const { deps, send } = makeDeps({
      async getSession() {
        return { conversations: [conv({ id: "other" })] };
      },
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("mode gate: a disabled lane conversation (gate denies) gets 403 with the proceed-with-best-judgment text and fires no event", async () => {
    const { deps, send, resolveLaneAskPermission } = makeDeps({
      async getSession() {
        return { conversations: [conv({ role: "validator" })] };
      },
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "autonomous conversation — proceed with best judgment",
    });
    expect(resolveLaneAskPermission).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("mode gate: an enabled iteration-lane ask (gate allows) registers the batch and fires ASK_QUESTION", async () => {
    const { deps, send, resolveLaneAskPermission } = makeDeps({
      async getSession() {
        return {
          conversations: [
            conv({ role: "iteration", activeTurnSource: "workflow" }),
          ],
        };
      },
      resolveLaneAskPermission: vi.fn(async () => ({
        allowed: true,
        executionId: "exec-1",
        contextId: "ctx-1",
        lane: "implementer" as const,
      })),
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      questionBatchId: "q_test1234",
    });
    expect(resolveLaneAskPermission).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [projectPath, sessionName, conversationId, event] =
      send.mock.calls[0]!;
    expect(projectPath).toBe("/repos/cc");
    expect(sessionName).toBe("sess");
    expect(conversationId).toBe("conv-1");
    expect(event).toMatchObject({
      type: "ASK_QUESTION",
      questionId: "q_test1234",
    });
  });

  it("mode gate: an enabled validator-lane ask (gate allows) registers the batch and fires ASK_QUESTION", async () => {
    const { deps, send, resolveLaneAskPermission } = makeDeps({
      async getSession() {
        return {
          conversations: [
            conv({ role: "validator", activeTurnSource: "workflow" }),
          ],
        };
      },
      resolveLaneAskPermission: vi.fn(async () => ({
        allowed: true,
        executionId: "exec-1",
        contextId: "ctx-1",
        lane: "context_validator" as const,
      })),
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(200);
    expect(resolveLaneAskPermission).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("mode gate: a planner conversation stays denied (403) and never consults the gate", async () => {
    const { deps, send, resolveLaneAskPermission } = makeDeps({
      async getSession() {
        return { conversations: [conv({ role: "planner" })] };
      },
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "autonomous conversation — proceed with best judgment",
    });
    expect(resolveLaneAskPermission).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("mode gate: a non-lane workflow-driven turn (role null, activeTurnSource workflow) stays denied and never consults the gate", async () => {
    const { deps, send, resolveLaneAskPermission } = makeDeps({
      async getSession() {
        return { conversations: [conv({ activeTurnSource: "workflow" })] };
      },
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "autonomous conversation — proceed with best judgment",
    });
    expect(resolveLaneAskPermission).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("turn gate: 409 when no turn is running", async () => {
    const { deps, send } = makeDeps({
      async getSession() {
        return { conversations: [conv({ status: "awaiting" })] };
      },
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no turn is running");
    expect(send).not.toHaveBeenCalled();
  });

  it("single-batch gate: 409 naming the pending batch id", async () => {
    const { deps, send } = makeDeps({
      async getSession() {
        return {
          conversations: [
            conv({
              status: "waiting_for_input",
              pendingQuestionId: "q_prev99",
            }),
          ],
        };
      },
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("q_prev99");
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 400 with issues for an invalid questions payload", async () => {
    const { deps, send } = makeDeps();
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest({ questions: [] }), { params });

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("happy path: fires ASK_QUESTION with ids assigned where omitted and returns the batch id", async () => {
    const { deps, send } = makeDeps();
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      questionBatchId: "q_test1234",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [projectPath, sessionName, conversationId, event] =
      send.mock.calls[0]!;
    expect(projectPath).toBe("/repos/cc");
    expect(sessionName).toBe("sess");
    expect(conversationId).toBe("conv-1");
    expect(event).toMatchObject({
      type: "ASK_QUESTION",
      questionId: "q_test1234",
    });
    const questions = (
      event as { questions: Array<{ id: string; question: string }> }
    ).questions;
    expect(questions.map((q) => q.id)).toEqual(["0", "named"]);
  });

  it("409 when the machine refuses the event (turn settled between gate and send)", async () => {
    const { deps } = makeDeps({ sendConversationEvent: () => false });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(409);
  });

  it("integration: registers the pending question on a live actor and creates no resolver", async () => {
    setMachineFactory(() =>
      conversationMachine.provide({
        actors: {
          prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
            async () => ({ transcriptPath: "/tmp/t.jsonl" }),
          ),
          // Turn held open for the duration of the test.
          executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
            () => new Promise(() => {}),
          ),
        },
        actions: {
          persistSnapshot: () => {},
          syncDerivedFields: () => {},
          broadcastConversationStatus: () => {},
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: () => {},
          releaseResources: () => {},
          dispatchPushNotification: () => {},
          markUnreadOnFinish: () => {},
          markReadOnUserTurnStart: () => {},
          drainPendingQueue: () => {},
        },
      }),
    );

    const actor = startConversationActor({
      projectPath: "/repos/cc",
      projectName: "cc",
      sessionName: "sess",
      worktreePath: "/repos/cc/.worktrees/sess",
      conversationId: "conv-1",
      createdAt: ts,
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
    });
    actor.send({ type: "SUBMIT_PROMPT", promptText: "hi", streamId: "s1" });
    await vi.waitFor(() => {
      expect(JSON.stringify(actor.getSnapshot().value)).toContain("executing");
    });

    const { deps } = makeDeps({ sendConversationEvent });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(200);
    const snap = actor.getSnapshot();
    expect(snap.context.pendingQuestion).toMatchObject({
      questionId: "q_test1234",
    });
    expect(snap.context.pendingQuestion?.questions.map((q) => q.id)).toEqual([
      "0",
      "named",
    ]);
    expect(snap.context.status).toBe("waiting_for_input");
  });
});
