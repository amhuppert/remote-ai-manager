import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";

let machineFactory: NonNullable<
  Parameters<typeof createConversationManagerFixture>[0]
>["machine"];
import { admitConversationProfileForTurn as admitFixtureProfile } from "@/lib/conversations/profile-admission";
const managerFixture: ReturnType<typeof createConversationManagerFixture> =
  createConversationManagerFixture({
    machine: (adapter, deps) =>
      machineFactory
        ? machineFactory(adapter, deps)
        : managerFixture.providedMachine(adapter),
    dependencies: {
      admitProfileForTurn: (identity) => admitFixtureProfile(identity),
    },
  });
import { describe, expect, it, vi, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { fromPromise } from "xstate";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { type ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { conversationMachine } from "@/lib/workflows/conversation/machine";

import type {
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "@/lib/workflows/conversation/types";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createAskQuestionHandlers,
  createProjectAskQuestionHandlers,
  type AskRouteDeps,
  type ProjectAskRouteDeps,
} from "./ask-route-handlers";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

const ts = "2025-01-01T00:00:00.000Z";

function conv(overrides: Partial<ConversationState> = {}): ConversationState {
  return makeConversationState({
    id: "conv-1",
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
  const send = vi.fn(async () => true);
  const resolveLaneAskPermission = vi.fn(async () => ({ allowed: false }));
  const deps: AskRouteDeps = {
    auth: authAllows(),
    async resolveProjectPath() {
      return "/repos/cc";
    },
    async getSession() {
      return { conversations: [conv()] };
    },
    registerConversationQuestion: send,
    resolveLaneAskPermission,
    generateQuestionBatchId: () => "q_test1234",
    log: createCapturingLogger(),
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
  managerFixture.dispose();
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
      questionId: "q_test1234",
    });
    const questions = (
      event as { questions: Array<{ id: string; question: string }> }
    ).questions;
    expect(questions.map((q) => q.id)).toEqual(["0", "named"]);
  });

  it("409 when the machine refuses the event (turn settled between gate and send)", async () => {
    const { deps } = makeDeps({
      registerConversationQuestion: async () => false,
    });
    const { POST } = createAskQuestionHandlers(deps);

    const res = await POST(makeRequest(validBody), { params });

    expect(res.status).toBe(409);
  });

  it("integration: registers the pending question on a live actor and creates no resolver", async () => {
    machineFactory = () =>
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
      });

    const actor = managerFixture.host.start({
      lastActivityAt: ts,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: "/repos/cc",
      target: targetFromStoreSessionName("cc", "sess", "conv-1"),

      worktreePath: "/repos/cc/.worktrees/sess",

      createdAt: ts,
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      persistence: "durable",
    });
    actor.send({ type: "SUBMIT_PROMPT", promptText: "hi", streamId: "s1" });
    await vi.waitFor(() => {
      expect(JSON.stringify(actor.getSnapshot().value)).toContain("executing");
    });

    const { deps } = makeDeps({
      registerConversationQuestion:
        managerFixture.manager.registerConversationQuestion,
    });
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

describe("createProjectAskQuestionHandlers (R2.4 / R1.1)", () => {
  function projectDeps(
    conversation: ConversationState = conv({ scope: "project" }),
  ) {
    const send = vi.fn(async () => true);
    const getProjectConversation = vi.fn(async () => conversation);
    const log = createCapturingLogger();
    return {
      send,
      getProjectConversation,
      log,
      deps: {
        auth: authAllows(),
        async resolveProjectPath() {
          return "/repos/cc";
        },
        getProjectConversation,
        registerConversationQuestion: send,
        generateQuestionBatchId: () => "q_proj1234",
        log,
      },
    };
  }

  function projectRequest(body: unknown): Request {
    return new Request(
      "http://127.0.0.1/api/projects/cc/conversations/conv-1/ask",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  const projectParams = Promise.resolve({
    name: "cc",
    conversationId: "conv-1",
  });

  it("registers a batch without any session record existing", async () => {
    const { deps, send, getProjectConversation } = projectDeps();
    const handlers = createProjectAskQuestionHandlers(deps);

    const res = await handlers.POST(
      projectRequest({
        questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }],
      }),
      { params: projectParams },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      questionBatchId: "q_proj1234",
    });
    // Resolved through the project conversation repo — no getSession dep exists.
    expect(getProjectConversation).toHaveBeenCalledWith("/repos/cc", "conv-1");
    // Reaches the same shared registration core the session adapter uses.
    expect(send).toHaveBeenCalledWith(
      "/repos/cc",
      PROJECT_CONVERSATION_SESSION_SENTINEL,
      "conv-1",
      expect.objectContaining({
        questionId: "q_proj1234",
      }),
    );
  });

  it("applies the same single-batch gate as the session adapter", async () => {
    const { deps, send } = projectDeps(
      conv({ scope: "project", pendingQuestionId: "q_existing" }),
    );
    const handlers = createProjectAskQuestionHandlers(deps);

    const res = await handlers.POST(
      projectRequest({
        questions: [{ question: "Again?", options: [{ label: "Yes" }] }],
      }),
      { params: projectParams },
    );

    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("404s an unknown project conversation instead of reporting a missing session", async () => {
    const { deps } = projectDeps();
    const handlers = createProjectAskQuestionHandlers({
      ...deps,
      getProjectConversation: async () => null,
    });

    const res = await handlers.POST(
      projectRequest({
        questions: [{ question: "Hi?", options: [{ label: "Yes" }] }],
      }),
      { params: projectParams },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "Conversation not found",
    });
  });

  // R4.6: graph workflow execution at project scope is a spec non-goal, and the
  // guarantee is structural rather than a policy check — the project adapter has
  // no lane branch and no gate dependency to reach one with. These pin that: a
  // lane branch grown here would have to make one of them fail.
  describe("never enters the graph-workflow lane path (R4.6)", () => {
    for (const role of ["iteration", "validator"] as const) {
      it(`denies a ${role}-role project conversation as autonomous instead of consulting a lane gate`, async () => {
        const { deps, send } = projectDeps(conv({ scope: "project", role }));
        // A gate the project adapter must never call. It is not part of
        // `ProjectAskRouteDeps`, so reaching it would require adding the
        // dependency back — spreading it in here is how the test can observe
        // that it stays unreached.
        const resolveLaneAskPermission = vi.fn(async () => ({
          allowed: true as const,
        }));
        const handlers = createProjectAskQuestionHandlers({
          ...deps,
          resolveLaneAskPermission,
        } as ProjectAskRouteDeps);

        const res = await handlers.POST(
          projectRequest({
            questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }],
          }),
          { params: projectParams },
        );

        // The session adapter would have let this through (the gate allows).
        // The project adapter treats every roled conversation as autonomous.
        expect(res.status).toBe(403);
        expect(resolveLaneAskPermission).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      });
    }

    it("the session adapter still reaches the lane gate on the same conversation", async () => {
      // Contrast, so the assertions above cannot pass because lane asks are
      // broken everywhere: the same role, through the session route, consults
      // the gate and registers the batch.
      const { deps, send, resolveLaneAskPermission } = makeDeps({
        async getSession() {
          return { conversations: [conv({ role: "iteration" })] };
        },
        resolveLaneAskPermission: vi.fn(async () => ({ allowed: true })),
      });
      const handlers = createAskQuestionHandlers(deps);

      const res = await handlers.POST(makeRequest(validBody), { params });

      expect(res.status).toBe(200);
      expect(resolveLaneAskPermission).toHaveBeenCalled();
      expect(send).toHaveBeenCalled();
    });
  });

  // R1.3: structured-log fields are a public identity surface. The project
  // adapter hands the shared core a scope ref, so no log line can report the
  // sentinel as a `sessionName` — previously every one of these sites did.
  describe("diagnostics never carry the sentinel (R1.3)", () => {
    /** Drive a project ask and return what the handler actually logged. */
    async function logsFor(
      conversation: ConversationState,
      body: unknown,
      depsOverrides: Partial<ProjectAskRouteDeps> = {},
    ) {
      const { deps, log } = projectDeps(conversation);
      const handlers = createProjectAskQuestionHandlers({
        ...deps,
        ...depsOverrides,
      });
      const res = await handlers.POST(projectRequest(body), {
        params: projectParams,
      });
      return { log, status: res.status };
    }

    const questions = [{ question: "Ship it?", options: [{ label: "Yes" }] }];

    it("emits scope:project and no sessionName key on successful registration", async () => {
      const { log, status } = await logsFor(conv({ scope: "project" }), {
        questions,
      });

      expect(status).toBe(200);
      const registered = log.entries.find(
        (e) => e.message === "ask.registered",
      );
      expect(registered?.fields).toMatchObject({
        scope: "project",
        conversationId: "conv-1",
        questionBatchId: "q_proj1234",
      });
      // Absent, not merely non-sentinel: a `sessionName` key at project scope
      // has no correct value to hold.
      expect(registered?.fields).not.toHaveProperty("sessionName");
    });

    it.each([
      {
        name: "no running turn",
        conversation: conv({ scope: "project", status: "awaiting" }),
        overrides: {},
        event: "ask.no_running_turn",
      },
      {
        name: "batch already pending",
        conversation: conv({
          scope: "project",
          pendingQuestionId: "q_existing",
        }),
        overrides: {},
        event: "ask.batch_already_pending",
      },
      {
        name: "event rejected",
        conversation: conv({ scope: "project" }),
        overrides: { registerConversationQuestion: async () => false },
        event: "ask.event_rejected",
      },
      {
        name: "autonomous denial",
        conversation: conv({ scope: "project", role: "validator" }),
        overrides: {},
        event: "ask.denied_autonomous",
      },
    ])(
      "emits no sentinel on the $name path",
      async ({ conversation, overrides, event }) => {
        const { log } = await logsFor(conversation, { questions }, overrides);

        const entry = log.entries.find((e) => e.message === event);
        expect(entry?.fields).toMatchObject({ scope: "project" });
        expect(entry?.fields).not.toHaveProperty("sessionName");
      },
    );

    it("emits the sentinel in no field of any entry, whatever the path", async () => {
      for (const { conversation, overrides } of [
        { conversation: conv({ scope: "project" }), overrides: {} },
        {
          conversation: conv({ scope: "project", status: "awaiting" }),
          overrides: {},
        },
        {
          conversation: conv({ scope: "project" }),
          overrides: { registerConversationQuestion: async () => false },
        },
        {
          conversation: conv({ scope: "project", role: "validator" }),
          overrides: {},
        },
      ]) {
        const { log } = await logsFor(conversation, { questions }, overrides);

        expect(log.entries.length).toBeGreaterThan(0);
        expect(log.allFieldValues()).not.toContain(
          PROJECT_CONVERSATION_SESSION_SENTINEL,
        );
      }
    });

    it("still reports the real session name at session scope (not over-scrubbed)", async () => {
      // The fix must remove the sentinel, not the diagnostic itself: a session
      // ask still has to be attributable to its session.
      const log = createCapturingLogger();
      const { deps } = makeDeps({ log });
      const handlers = createAskQuestionHandlers(deps);

      await handlers.POST(makeRequest({ questions }), { params });

      const registered = log.entries.find(
        (e) => e.message === "ask.registered",
      );
      expect(registered?.fields).toMatchObject({
        scope: "session",
        sessionName: "sess",
      });
    });
  });
});
