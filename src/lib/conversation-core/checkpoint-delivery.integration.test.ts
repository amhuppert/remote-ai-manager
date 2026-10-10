/**
 * A ready checkpoint's seed carried by a core conversation's next message:
 * the real interactive turns, turn engine, runtime host and Claude adapter
 * (with only its SDK port scripted), the real turn context and seed receipt,
 * over real conversation rows and the real checkpoint repository. Durable
 * outcomes are read back through a store a restarted server would build.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationBackendFactory,
  ConversationBackendCreateInput,
} from "@/lib/agent-backends/conversation";
import { getConversationTranscriptProjection } from "@/lib/agent-backends/conversation-policy";
import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import {
  FAKE_CLAUDE_HANGING_PROMPT,
  FAKE_CLAUDE_SESSION_ID,
} from "@/lib/agent-backends/testing/fake-claude-sdk-port";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import {
  createConversationCheckpointsRepo,
  type ConversationCheckpointsRepo,
} from "@/lib/conversation-checkpoints/repo";
import type {
  CheckpointPhase,
  CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { checkpointPayload } from "@/lib/supervision/testing/supervision-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createActorDependenciesFixture,
  groupActorFixtureDependencies,
} from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { prepareTurnInput } from "./turn-input";
import type { PassiveSubscriptionContextDependencies } from "@/lib/conversation-core/contributions/passive-subscription-context";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { createCheckpointContinuation } from "./checkpoints";
import { createInteractiveTurns } from "./interactive-turns";
import type { ConversationRecordPort } from "./conversation-record";
import { createRuntimeHost } from "./runtime-host";
import { createTurnEngine } from "./turn-engine";

// `sdk-env` deletes an env var at load — an infrastructure module with an import-time side effect.
vi.mock("@/lib/shared/sdk-env", () => ({}));

const PROJECT = "/repo";
const SESSION = "session";
const CHAT = "chat-1";
const KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: PROJECT,
  sessionName: SESSION,
  conversationId: CHAT,
};
const BASIS = { capturedThroughSeq: 4, sourceHash: "sha256:source" };
const PAYLOAD = checkpointPayload("op-1", BASIS, "2026-10-03T10:00:00.000Z");
const enrollment = {
  conversationId: CHAT,
  projectPath: PROJECT,
  sessionName: SESSION,
  enrolledAt: "2026-10-03T10:00:00.000Z",
};

let fixture: PersistenceFixture;
let realRepo: ConversationCheckpointsRepo;
let closeProvider = () => {};

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; refusal: { code: string } },
): T {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  return result.value;
}

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION);
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({
      id: CHAT,
      promptCount: 2,
      transcriptPath: "/t/chat-1.jsonl",
      backendRef: { backend: "claude", ref: "sdk-retired" },
    }),
  );
  realRepo = createConversationCheckpointsRepo(
    fixture.db,
    createWriteQueue(),
    fixture.store.checkpointContinuation,
  );
  const at = new Date().toISOString();
  unwrap(
    await realRepo.admitOperation({
      key: KEY,
      requestId: "op-1",
      sourceBasis: BASIS,
      priorBackendRef: "sdk-retired",
      requestedAt: at,
    }),
  );
  unwrap(
    await realRepo.freezePayload({
      key: KEY,
      operationId: "op-1",
      payload: PAYLOAD,
      at,
    }),
  );
  unwrap(await realRepo.commitReady({ key: KEY, operationId: "op-1", at }));
});
afterEach(() => {
  closeProvider();
  fixture.close();
});

/** What a restarted server reads. */
function reloaded() {
  const store = fixture.recreateStore();
  return {
    operation: () =>
      createConversationCheckpointsRepo(
        fixture.db,
        createWriteQueue(),
        store.checkpointContinuation,
      ).getOperation(KEY, "op-1"),
    row: () => store.getConversation(PROJECT, SESSION, CHAT),
  };
}

/** The conversation row as a core turn reads it and records its continuity; the rest of its bookkeeping is inert here. */
function rowRecords(): ConversationRecordPort {
  return {
    async recordSeenAlignment() {},
    async read() {
      const row = await fixture.store.getConversation(PROJECT, SESSION, CHAT);
      return row === null
        ? null
        : {
            agentBackend: row.agentBackend,
            backendRef: row.backendRef,
            promptCount: row.promptCount,
            transcriptPath: row.transcriptPath,
            debugMode: null,
            pendingQuestionId: row.pendingQuestionId,
            owner: row.owner,
          };
    },
    async recordContinuity(_identity, ref) {
      await fixture.store.mutateConversation(
        PROJECT,
        SESSION,
        CHAT,
        "test.record_continuity",
        (row) => {
          row.backendRef = ref;
        },
      );
    },
    async claimTurn() {},
    async endClaim() {},
    async beginTurn() {},
    async admitProfile() {
      return { instructionBlock: null, snapshot: null, lockedAt: null };
    },
    async adoptBackend() {},
    async recordWithdrawn() {},
    async recordInterrupted() {},
    hasPendingQuestion: () => false,
    async withdrawQuestion() {
      return false;
    },
    async settleTurn() {
      return { debug: null };
    },
  };
}

function harness(
  options: {
    repo?: ConversationCheckpointsRepo;
    subscriptions?: PassiveSubscriptionContextDependencies;
  } = {},
) {
  const repo = options.repo ?? realRepo;
  const log = createCapturingLogger();
  const provider = createScriptedConversationBackend({
    backend: "claude",
    responseText: JSON.stringify({ done: true }),
  });
  closeProvider = () => provider.close();
  const created: ConversationBackendCreateInput[] = [];
  /** The operation's phase as each send reached the provider. */
  const phaseAtSend: (CheckpointPhase | null)[] = [];
  /** While set, every send fails as provably never written to the provider. */
  const transport = { down: false };
  const factory: ConversationBackendFactory = {
    ...provider.factory,
    async createRuntime(input) {
      created.push(input);
      const runtime = await provider.factory.createRuntime(input);
      const send = runtime.sendTurn.bind(runtime);
      runtime.sendTurn = async (turn) => {
        phaseAtSend.push((await repo.getOperation(KEY, "op-1"))?.phase ?? null);
        if (transport.down) {
          throw markPromptNotDelivered(
            new Error(
              "the provider socket closed before the prompt was written",
            ),
          );
        }
        return send(turn);
      };
      return runtime;
    },
  };
  const host = createRuntimeHost({
    factory: () => factory,
    instructions: async () => ({
      sessionInstructions: ["Work carefully."],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    tooling: async () => ({ overrides: { portableMcp: { servers: [] } } }),
    beginSeed: async () => ({ commit: async () => {} }),
    callbacks: () => ({}),
    index: { register: () => {}, unregister: () => {} },
    log,
  });
  const engine = createTurnEngine({
    host,
    executeAgentCall,
    transcript: {
      async safeAppendTranscriptEntry() {},
      async safeAppendTranscriptEntryOnce() {},
    },
    projection: getConversationTranscriptProjection,
    timeouts: async () => ({ timeoutMs: 0, stallTimeoutMs: 0 }),
    log,
  });
  const contextDeps = {
    ...groupActorFixtureDependencies(createActorDependenciesFixture()),
    ...(options.subscriptions !== undefined
      ? { subscriptions: options.subscriptions }
      : {}),
  };
  const turns = createInteractiveTurns({
    engine,
    records: rowRecords(),
    host,
    continuation: createCheckpointContinuation({
      repo: () => repo,
      transcript: {
        async readConversationMessages() {
          throw new Error("a conversation the core runs is never a fork");
        },
      },
      release: (conversationId) => host.release(conversationId),
      now: () => new Date().toISOString(),
      log,
    }),
    worktreeOf: async () => `${PROJECT}/.worktrees/${SESSION}`,
    resolveModelSelection: async () => ({
      modelId: "sonnet",
      parameters: { effort: "medium" },
    }),
    prepareInput: (request) => prepareTurnInput(contextDeps, request),
    nameConversation: () => {},
    requestUserQuestion: async () => ({
      status: "answered" as const,
      answers: {},
    }),
    persistImages: async ({ promptText }) => ({ promptText, imageRefs: [] }),
    queuedDelivery: () => {
      throw new Error("these messages are sent directly");
    },
    failQueued: async () => {},
    returnQueued: async () => {},
    transcript: { async appendTranscriptEntryOnce() {} },
    getProjectDisplayName: () => "repo",
    startDebugVerification: () => {},
    log,
  });
  return {
    turns,
    transport,
    created,
    phaseAtSend,
    provider,
    send(
      text: string,
      attemptId: string,
      signal = new AbortController().signal,
    ) {
      return turns.run({
        conversationId: CHAT,
        enrollment,
        request: { kind: "user_message", text, inputOrigin: "user" },
        attemptId,
        signal,
        stream: null,
      });
    },
  };
}

describe("a ready checkpoint carried by a core conversation's next message", () => {
  it("is bound before the send, seeds a fresh runtime, and is applied with the fresh reference", async () => {
    const h = harness();
    expect(await h.send("What next?", "attempt-1")).toMatchObject({
      status: "succeeded",
    });

    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.persistedRef).toBeNull();
    expect(h.phaseAtSend).toEqual(["delivering"]);
    expect(h.provider.userPrompt.startsWith(PAYLOAD.seedText)).toBe(true);
    expect(h.provider.userPrompt).toContain("What next?");

    const after = reloaded();
    expect(await after.operation()).toMatchObject({
      phase: "applied",
      delivery: { attemptId: "attempt-1" },
      acceptance: { attemptId: "attempt-1", seedHash: PAYLOAD.seedSha256 },
      protectedReferences: { acceptedBackendRef: FAKE_CLAUDE_SESSION_ID },
    });
    expect((await after.row())?.backendRef).toEqual({
      backend: "claude",
      ref: FAKE_CLAUDE_SESSION_ID,
    });

    expect(await h.send("And then?", "attempt-2")).toMatchObject({
      status: "succeeded",
    });
    expect(h.created[1]?.persistedRef).toEqual({
      backend: "claude",
      ref: FAKE_CLAUDE_SESSION_ID,
    });
    expect(h.provider.userPrompt).not.toContain(PAYLOAD.seedText);
  });

  it("returns to ready when the send never reached the provider, and the next message delivers it", async () => {
    const h = harness();
    h.transport.down = true;
    expect(await h.send("What next?", "attempt-1")).toMatchObject({
      status: "failed",
    });
    expect(await reloaded().operation()).toMatchObject({ phase: "ready" });

    h.transport.down = false;
    expect(await h.send("What next?", "attempt-2")).toMatchObject({
      status: "succeeded",
    });
    expect(await reloaded().operation()).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: "attempt-2" },
    });
  });

  it("holds the operation for reconciliation when the turn is stopped after its send", async () => {
    const h = harness();
    const stop = new AbortController();
    const sent = h.send(FAKE_CLAUDE_HANGING_PROMPT, "attempt-1", stop.signal);
    await vi.waitFor(() => expect(h.phaseAtSend).toEqual(["delivering"]));
    stop.abort("user");
    expect(await sent).toMatchObject({ status: "cancelled" });

    expect(await reloaded().operation()).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
    });
  });

  it("keeps an acceptance it could not record, and records it before the conversation's next turn", async () => {
    let failures = 2;
    const repo: ConversationCheckpointsRepo = {
      ...realRepo,
      async recordAcceptance(input) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("database is locked");
        }
        return realRepo.recordAcceptance(input);
      },
    };
    const h = harness({ repo });
    expect(await h.send("What next?", "attempt-1")).toMatchObject({
      status: "succeeded",
    });
    expect(await reloaded().operation()).toMatchObject({ phase: "delivering" });

    await h.turns.settleRetained(CHAT);
    expect(await reloaded().operation()).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: "attempt-1" },
    });
  });

  it("writes a receipt that failed after the checkpoint's acceptance was recorded, at the turn's settlement", async () => {
    let failures = 1;
    const written: string[] = [];
    const h = harness({
      subscriptions: {
        prepareBriefing: async () => ({
          block: "<briefing/>",
          async onInputAccepted() {
            if (failures > 0) {
              failures -= 1;
              throw new Error("database is locked");
            }
            written.push("briefing");
          },
          async finish() {},
        }),
      },
    });
    expect(await h.send("What next?", "attempt-1")).toMatchObject({
      status: "succeeded",
    });

    expect(await reloaded().operation()).toMatchObject({ phase: "applied" });
    expect(written).toEqual(["briefing"]);
  });
});
