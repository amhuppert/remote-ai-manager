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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromPromise } from "xstate";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  setPublicationBroadcastForTesting,
  _resetPublicationForTesting,
} from "@/lib/events/publication";
import { applySyncDerivedFields } from "@/lib/workflows/conversation/persistence-adapter";

import type {
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "@/lib/workflows/conversation/types";
import { createProjectAskQuestionHandlers } from "./ask-route-handlers";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

/**
 * Durability of a project conversation's pending question (charter: "Durability
 * claims need real persistence").
 *
 * The unit tests for the project Ask adapter stub `registerConversationQuestion`, so
 * they prove the handler CALLS the store seam — not that the pending batch
 * survives. The sentinel-aware store path is exactly what could silently fail
 * here: a project conversation lives in its own table, and the write is keyed by
 * the sentinel. So this drives the real route handler against a real SQLite
 * fixture through a real actor, then RELOADS through the repository.
 */

const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-1";
const ts = "2026-01-01T00:00:00.000Z";

describe("project ask persists the pending question (R1.1 / R2.4)", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  let syncWrites: Promise<unknown>[];
  let published: SSEEvent[];

  beforeEach(async () => {
    fixture = createPersistenceFixture();
    syncWrites = [];
    published = [];
    setPublicationBroadcastForTesting((event) => published.push(event));
    fixture.seedProject(PROJECT_PATH);
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      conversationStateSchema.parse({
        id: CONVERSATION_ID,
        scope: "project",
        status: "idle",
        transcriptPath: null,
        promptCount: 0,
        createdAt: ts,
        lastActivityAt: ts,
        agentBackend: "claude",
      }),
    );

    // The exact machine production starts actors with (`createProvidedMachine`)
    // with the prompt actors stubbed (the turn is held open). PRODUCTION
    // persistence: `applySyncDerivedFields` is the real function the durable
    // adapter calls, writing through the real store, which routes the sentinel
    // key to the project-conversations table. `broadcastAskQuestion` is left
    // PRODUCTION too — the scope-discriminated SSE it emits is the other half of
    // R4.1, and stubbing it would leave the request's last hop unproven.
    machineFactory = (adapter) =>
      managerFixture.providedMachine(adapter).provide({
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
          // Out of scope here: snapshot codec durability has its own contract,
          // and status/push/queue behaviour is owned by other requirements.
          persistSnapshot: () => {},
          broadcastConversationStatus: () => {},
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

    _resetPublicationForTesting();
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

  /** The real project Ask handler, resolving through the real repository. */
  function projectHandlers() {
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

  /** Start a live project-scope turn — keyed by the sentinel, as production is. */
  async function startProjectTurn() {
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
        CONVERSATION_ID,
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

  /** Reload from SQLite through the repository — never from the actor. */
  async function reload() {
    await Promise.all(syncWrites);
    return fixture.store.getProjectConversation(PROJECT_PATH, CONVERSATION_ID);
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

  function askRequest(body: unknown): Request {
    return new Request(
      `http://127.0.0.1/api/projects/cc/conversations/${CONVERSATION_ID}/ask`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  const params = Promise.resolve({
    name: "cc",
    conversationId: CONVERSATION_ID,
  });

  it("writes the pending batch to the project-conversations table, surviving reload", async () => {
    await startProjectTurn();

    const res = await projectHandlers().POST(askRequest(askBody), { params });
    expect(res.status).toBe(200);

    const reloaded = await vi.waitFor(async () => {
      const row = await reload();
      expect(row?.pendingQuestionId).toBe("q_durable1");
      return row;
    });

    // Reloaded from SQLite, not read off the actor: the batch itself must be
    // durable, or a restart would leave the user an unanswerable question.
    expect(reloaded?.pendingQuestions).toMatchObject([
      { id: "ship", question: "Ship it?" },
    ]);
    expect(reloaded?.status).toBe("waiting_for_input");
  });

  it("broadcasts the PROJECT-scoped ask-question event (R4.1)", async () => {
    await startProjectTurn();

    const res = await projectHandlers().POST(askRequest(askBody), { params });
    expect(res.status).toBe(200);

    // Publication is fire-and-forget behind a dynamic import.
    const event = await vi.waitFor(() => {
      const found = published.find((e) => e.type === "ask-question");
      expect(found).toBeDefined();
      return found;
    });

    // The scope discriminator is what routes this to the project cockpit. A
    // session-shaped variant would carry `sessionName: "__project__"` and no
    // project client would ever see it.
    expect(event).toMatchObject({
      type: "ask-question",
      scope: "project",
      projectName: "cc",
      conversationId: CONVERSATION_ID,
      questionId: "q_durable1",
      questions: [expect.objectContaining({ id: "ship" })],
    });
    expect(event).not.toHaveProperty("sessionName");
  });

  it("recovers the pending question after the actor is gone (restart)", async () => {
    await startProjectTurn();
    await projectHandlers().POST(askRequest(askBody), { params });
    await vi.waitFor(async () => {
      expect((await reload())?.pendingQuestionId).toBe("q_durable1");
    });

    // Drop every live actor — the state a restarted server would come up with.
    managerFixture.dispose();

    const recovered = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      CONVERSATION_ID,
    );
    expect(recovered?.pendingQuestionId).toBe("q_durable1");
    expect(recovered?.status).toBe("waiting_for_input");

    // And the recovered row still drives the single-batch gate, so a re-ask
    // after restart is refused rather than silently replacing the batch.
    const second = await projectHandlers().POST(askRequest(askBody), {
      params,
    });
    expect(second.status).toBe(409);
  });

  it("persists nothing when the turn is not running", async () => {
    // No actor started: the turn gate rejects before any write, so a stray ask
    // cannot leave a pending batch nobody can answer.
    const res = await projectHandlers().POST(askRequest(askBody), { params });

    expect(res.status).toBe(409);
    expect((await reload())?.pendingQuestionId).toBeNull();
  });
});
