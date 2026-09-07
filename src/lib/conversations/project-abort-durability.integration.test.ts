import {
  conversationTargetStoreSessionName,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
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
import {
  getConversationRuntime,
  conversationRuntimeKey,
} from "@/lib/workflows/conversation/runtime-state";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromPromise } from "xstate";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { conversationMachine } from "@/lib/workflows/conversation/machine";
import { applySyncDerivedFields } from "@/lib/workflows/conversation/persistence-adapter";

import { registerAbortController } from "@/lib/conversations/abort-registry";
import { _resetAbortRegistryForTesting } from "@/lib/shared/abort-registry";
import type {
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "@/lib/workflows/conversation/types";
import { createProjectAskQuestionHandlers } from "./ask-route-handlers";
import { createProjectAbortHandlers } from "./abort-route-handlers";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

/**
 * Stopping a project conversation, proved through real persistence (R5.1/R5.2,
 * charter: "Durability claims need real persistence").
 *
 * The unit tests for the project abort adapter stub the registry and the machine
 * seam, so they prove the handler CALLS them — not that the conversation settles
 * or that the pending question is really gone. Both claims are about the
 * sentinel-keyed store path, which is exactly what can silently fail at project
 * scope: a project conversation lives in its own table. So this drives the real
 * handler against a real SQLite fixture through real actors, then RELOADS
 * through the repository.
 *
 * Two conversations run concurrently throughout, because a project cockpit is
 * multi-tab by construction: stopping one must leave the other's turn and its
 * pending question untouched.
 */

const PROJECT_PATH = "/repos/cc";
const STOPPED = "conv-stopped";
const RUNNING = "conv-running";
const ts = "2026-01-01T00:00:00.000Z";

describe("project conversation stop settles and clears durably", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  let syncWrites: Promise<unknown>[];

  beforeEach(async () => {
    fixture = createPersistenceFixture();
    syncWrites = [];
    fixture.seedProject(PROJECT_PATH);
    for (const id of [STOPPED, RUNNING]) {
      await fixture.seedProjectConversation(
        PROJECT_PATH,
        conversationStateSchema.parse({
          id,
          scope: "project",
          status: "idle",
          transcriptPath: null,
          promptCount: 0,
          createdAt: ts,
          lastActivityAt: ts,
          agentBackend: "claude",
        }),
      );
    }

    // The production machine with the prompt actors stubbed (each turn is held
    // open) and PRODUCTION persistence: `applySyncDerivedFields` is the real
    // function the durable adapter calls, writing through the real store, which
    // routes the sentinel key to the project-conversations table.
    machineFactory = () =>
      conversationMachine.provide({
        actors: {
          prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
            async () => ({ transcriptPath: "/tmp/t.jsonl" }),
          ),
          executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
            () => new Promise(() => {}),
          ),
        },
        actions: {
          syncDerivedFields: ({ context }) => {
            syncWrites.push(
              fixture.deps.mutateConversation(
                context.projectPath,
                conversationTargetStoreSessionName(context.target),
                context.target.conversationId,
                "test.syncDerived",
                (c) => applySyncDerivedFields(context, c),
              ),
            );
          },
          // Out of scope here: snapshot codec durability has its own contract.
          persistSnapshot: () => {},
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
  });

  afterEach(() => {
    managerFixture.dispose();

    _resetAbortRegistryForTesting();
    fixture.close();
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

  /** The real project handlers, resolving through the real repository. */
  function askHandlers() {
    return createProjectAskQuestionHandlers({
      auth: authAllows(),
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      getProjectConversation: fixture.store.getProjectConversation,
      registerConversationQuestion:
        managerFixture.manager.registerConversationQuestion,
      generateQuestionBatchId: () => "q_durable1",
      log: createCapturingLogger(),
    });
  }

  function abortHandlers() {
    return createProjectAbortHandlers({
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      getProjectConversation: fixture.store.getProjectConversation,
      requestConversationStop: managerFixture.manager.requestConversationStop,
      log: createCapturingLogger(),
    });
  }

  /** Start a live project-scope turn — keyed by the sentinel, as production is. */
  async function startProjectTurn(conversationId: string) {
    const actor = managerFixture.host.start({
      lastActivityAt: ts,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: PROJECT_PATH,
      target: targetFromStoreSessionName(
        "cc",
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId,
      ),

      worktreePath: PROJECT_PATH,

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
    return actor;
  }

  /**
   * The abort handle a running turn registers. Production registers this from
   * `executePromptStream`, which the stubbed prompt actor does not run.
   */
  function registerTurnHandle(conversationId: string): AbortController {
    const controller = getConversationRuntime(
      conversationRuntimeKey(
        PROJECT_PATH,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId,
      ),
    )!.abortController;
    registerAbortController(conversationId, controller);
    return controller;
  }

  /** Reload from SQLite through the repository — never from an actor. */
  async function reload(conversationId: string) {
    await Promise.all(syncWrites);
    return fixture.store.getProjectConversation(PROJECT_PATH, conversationId);
  }

  const askBody = {
    questions: [
      {
        id: "ship",
        question: "Ship it?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
  };

  function askRequest(conversationId: string) {
    return {
      request: new Request(
        `http://127.0.0.1/api/projects/cc/conversations/${conversationId}/ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(askBody),
        },
      ),
      context: {
        params: Promise.resolve({ name: "cc", conversationId }),
      },
    };
  }

  function abortRequest(conversationId: string) {
    return {
      request: new Request(
        `http://127.0.0.1/api/projects/cc/conversations/${conversationId}/abort`,
        { method: "POST" },
      ),
      context: {
        params: Promise.resolve({ name: "cc", conversationId }),
      },
    };
  }

  it("halts execution and settles the conversation out of its running turn (R5.1)", async () => {
    await startProjectTurn(STOPPED);
    const handle = registerTurnHandle(STOPPED);
    await vi.waitFor(async () => {
      expect((await reload(STOPPED))?.status).toBe("running");
    });

    const { request, context } = abortRequest(STOPPED);
    const res = await abortHandlers().POST(request, context);
    expect(res.status).toBe(200);

    // Backend execution is halted…
    expect(handle.signal.aborted).toBe(true);
    // …and the conversation settled through the machine's own transition, read
    // back from SQLite rather than off the actor.
    await vi.waitFor(async () => {
      expect((await reload(STOPPED))?.status).not.toBe("running");
    });
    expect((await reload(STOPPED))?.activeTurnSource).toBeNull();
  });

  it("clears a stranded pending question, durably (R5.2)", async () => {
    await startProjectTurn(STOPPED);
    registerTurnHandle(STOPPED);

    const ask = askRequest(STOPPED);
    expect((await askHandlers().POST(ask.request, ask.context)).status).toBe(
      200,
    );
    await vi.waitFor(async () => {
      expect((await reload(STOPPED))?.pendingQuestionId).toBe("q_durable1");
    });

    const { request, context } = abortRequest(STOPPED);
    await abortHandlers().POST(request, context);

    // Reloaded from SQLite: a question that survived the stop would be
    // unanswerable — the turn that asked it is gone.
    const reloaded = await vi.waitFor(async () => {
      const row = await reload(STOPPED);
      expect(row?.pendingQuestionId).toBeNull();
      return row;
    });
    expect(reloaded?.pendingQuestions).toBeNull();
    expect(reloaded?.status).not.toBe("waiting_for_input");
  });

  it("stops the addressed conversation only (R5.2)", async () => {
    await startProjectTurn(STOPPED);
    await startProjectTurn(RUNNING);
    const stoppedHandle = registerTurnHandle(STOPPED);
    const runningHandle = registerTurnHandle(RUNNING);

    // Both are parked on their own pending question, so a leak would be visible
    // in both the turn state and the question.
    for (const id of [STOPPED, RUNNING]) {
      const ask = askRequest(id);
      await askHandlers().POST(ask.request, ask.context);
    }
    await vi.waitFor(async () => {
      expect((await reload(RUNNING))?.pendingQuestionId).toBe("q_durable1");
      expect((await reload(STOPPED))?.pendingQuestionId).toBe("q_durable1");
    });

    const { request, context } = abortRequest(STOPPED);
    await abortHandlers().POST(request, context);

    await vi.waitFor(async () => {
      expect((await reload(STOPPED))?.pendingQuestionId).toBeNull();
    });

    expect(stoppedHandle.signal.aborted).toBe(true);
    expect(runningHandle.signal.aborted).toBe(false);
    const untouched = await reload(RUNNING);
    expect(untouched?.pendingQuestionId).toBe("q_durable1");
    expect(untouched?.status).toBe("waiting_for_input");
  });

  it("clears a pending question even when no controller is live (R5.2)", async () => {
    // The realistic stranded case: the asking turn ended, so nothing is
    // registered to signal. The transition is the only thing that can free the
    // conversation, so a handler that skipped it on a 409 would leave the
    // question unanswerable forever.
    await startProjectTurn(STOPPED);
    const ask = askRequest(STOPPED);
    await askHandlers().POST(ask.request, ask.context);
    await vi.waitFor(async () => {
      expect((await reload(STOPPED))?.pendingQuestionId).toBe("q_durable1");
    });

    const { request, context } = abortRequest(STOPPED);
    const res = await abortHandlers().POST(request, context);
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      expect((await reload(STOPPED))?.pendingQuestionId).toBeNull();
    });
  });
});
