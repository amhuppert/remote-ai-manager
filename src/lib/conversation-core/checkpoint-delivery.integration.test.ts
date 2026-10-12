/**
 * A ready checkpoint's seed carried by a core conversation's next message:
 * the real interactive turns, turn engine, runtime host and Claude adapter
 * (with only its SDK port scripted), the real turn context and seed receipt,
 * over real conversation rows and the real checkpoint repository. Durable
 * outcomes are read back through a store a restarted server would build.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationBackendFactory,
  ConversationBackendCreateInput,
  ConversationBackendTurnInput,
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
import { createCheckpointForkService } from "@/lib/conversation-checkpoints/fork-service";
import { createCheckpointForkTurnAdmission } from "@/lib/conversation-checkpoints/fork-submission";
import { createCheckpointContinuation } from "./checkpoints";
import { createInteractiveTurns } from "./interactive-turns";
import { noCustody, noCustodyOpener } from "./testing/no-custody";
import {
  applyBackendAdoption,
  applyLiveInputAccepted,
  applyTurnBegin,
  applyTurnSettlement,
  type ConversationRecordPort,
  type LiveInputRecordPort,
  type TurnSettled,
} from "./conversation-record";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
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
const FIXTURE_PAYLOAD = checkpointPayload(
  "op-1",
  BASIS,
  "2026-10-03T10:00:00.000Z",
);
/** Hashed as a real checkpoint is, so a checkpoint fork accepts it. */
const PAYLOAD = {
  ...FIXTURE_PAYLOAD,
  seedSha256: createHash("sha256")
    .update(FIXTURE_PAYLOAD.seedText)
    .digest("hex"),
};
const place = {
  conversationId: CHAT,
  projectPath: PROJECT,
  sessionName: SESSION,
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

/**
 * The conversation row as a core turn reads and keeps it: its continuity,
 * backend adoption and turn bookkeeping through the row's own transitions;
 * questions and notices are inert here.
 */
function rowRecords(
  failures: { continuity?: () => boolean } = {},
): ConversationRecordPort & LiveInputRecordPort {
  const mutate = (
    identity: { conversationId: string },
    label: string,
    change: (row: ConversationState) => void,
  ) =>
    fixture.store.mutateConversation(
      PROJECT,
      SESSION,
      identity.conversationId,
      label,
      change,
    );
  return {
    async recordLiveInput(identity) {
      await mutate(identity, "test.live_input", (row) =>
        applyLiveInputAccepted(row, new Date().toISOString()),
      );
    },
    async recordSeenAlignment() {},
    async read(identity) {
      const row = await fixture.store.getConversation(
        PROJECT,
        SESSION,
        identity.conversationId,
      );
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
            forkedFrom: row.forkedFrom,
            checkpointFork: row.checkpointFork,
          };
    },
    async recordContinuity(identity, ref) {
      if (failures.continuity?.() === true)
        throw new Error("the conversation row could not be written");
      await mutate(identity, "test.record_continuity", (row) => {
        row.backendRef = ref;
      });
    },
    async claimTurn() {},
    async endClaim() {},
    async beginTurn(identity, source) {
      await mutate(identity, "test.begin", (row) =>
        applyTurnBegin(row, source, new Date().toISOString()),
      );
    },
    async admitProfile() {
      return { instructionBlock: null, snapshot: null, lockedAt: null };
    },
    async adoptBackend(identity, backend) {
      await mutate(identity, "test.adopt", (row) =>
        applyBackendAdoption(row, backend),
      );
    },
    async recordWithdrawn() {},
    async recordInterrupted() {},
    hasPendingQuestion: () => false,
    async withdrawQuestion() {
      return false;
    },
    async settleTurn(identity, settlement, source) {
      let debug: TurnSettled["debug"] = null;
      await mutate(identity, "test.settle", (row) => {
        debug = applyTurnSettlement(
          row,
          settlement,
          new Date().toISOString(),
          source,
        ).debug;
      });
      return { debug };
    },
  };
}

function harness(
  options: {
    repo?: ConversationCheckpointsRepo;
    subscriptions?: PassiveSubscriptionContextDependencies;
    /** While it answers true, recording the agent's session fails. */
    continuityFails?: () => boolean;
    /** While it answers true, recording a fork history's acceptance fails. */
    acknowledgementFails?: () => boolean;
  } = {},
) {
  // The real fork admission over the rows; only the configured-model check is answered here.
  const admitCheckpointFork = createCheckpointForkTurnAdmission({
    getConversation: (projectPath, sessionName, conversationId) =>
      fixture.store.getConversation(projectPath, sessionName, conversationId),
    mutateConversation: fixture.store.mutateConversation,
    // The configured default, for a message that names no selection.
    admitSelection: async (_projectPath, _backend, modelSelection) =>
      modelSelection ?? { modelId: "sonnet", parameters: { effort: "low" } },
  });
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
  /** While set, no runtime can be created. */
  const runtimes = { down: false };
  /** Every turn input the provider was sent, in order. */
  const sent: ConversationBackendTurnInput[] = [];
  const factory: ConversationBackendFactory = {
    ...provider.factory,
    async createRuntime(input) {
      if (runtimes.down) throw new Error("the provider could not be started");
      created.push(input);
      const runtime = await provider.factory.createRuntime(input);
      const send = runtime.sendTurn.bind(runtime);
      runtime.sendTurn = async (turn) => {
        sent.push(turn);
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
    readInstructions: async () => ({
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
  const grouped = groupActorFixtureDependencies(
    createActorDependenciesFixture(),
  );
  const contextDeps = {
    ...grouped,
    effects: {
      ...grouped.effects,
      async mutateConversation(
        projectPath: string,
        sessionName: string,
        conversationId: string,
        label: string,
        change: (row: ConversationState) => void,
      ) {
        if (
          label === "acknowledgeSyntheticForkSeed" &&
          options.acknowledgementFails?.() === true
        )
          throw new Error("the fork's acceptance could not be written");
        await fixture.store.mutateConversation(
          projectPath,
          sessionName,
          conversationId,
          label,
          change,
        );
      },
    },
    ...(options.subscriptions !== undefined
      ? { subscriptions: options.subscriptions }
      : {}),
  };
  const turns = createInteractiveTurns({
    engine,
    records: rowRecords({
      ...(options.continuityFails !== undefined
        ? { continuity: options.continuityFails }
        : {}),
    }),
    host,
    custody: noCustody,
    continuation: createCheckpointContinuation({
      repo: () => repo,
      transcript: {
        async readConversationMessages() {
          throw new Error("every fork here carries its seed");
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
    admitCheckpointFork,
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
    runtimes,
    created,
    phaseAtSend,
    sent,
    provider,
    send(
      text: string,
      attemptId: string,
      signal = new AbortController().signal,
      conversationId = CHAT,
      backend?: AgentBackendId,
    ) {
      return turns.run({
        conversationId,
        place: { ...place, conversationId },
        request: {
          kind: "user_message",
          text,
          inputOrigin: "user",
          ...(backend !== undefined ? { backend } : {}),
        },
        attemptId,
        signal,
        stream: null,
        custody: noCustodyOpener,
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

describe("a fork the core runs", () => {
  const FORK = "6f1c2a4e-8b7d-4c3e-9a1f-2d5e8b7c4a10";
  const SONNET = { modelId: "sonnet", parameters: { effort: "medium" } };

  it("sends a synthetic fork's history with its first message, once the agent accepts it never again", async () => {
    await seedSyntheticFork();
    const h = harness();

    await h.send("Carry on", "attempt-f1", undefined, FORK);
    await h.send("And then?", "attempt-f2", undefined, FORK);

    expect(h.sent.map((turn) => turn.syntheticForkSeed ?? null)).toEqual([
      "Earlier, the user asked for the notice to fire once.",
      null,
    ]);
    const row = await fixture
      .recreateStore()
      .getConversation(PROJECT, SESSION, FORK);
    expect(row?.forkedFrom?.syntheticSeedAcceptedRef).toEqual({
      backend: "claude",
      ref: FAKE_CLAUDE_SESSION_ID,
    });
  });

  async function forkCheckpoint(modelSelection: {
    modelId: string;
    parameters: Record<string, string>;
  }) {
    const forks = createCheckpointForkService({
      repo: () => realRepo,
      load: (projectPath, target) =>
        fixture.store.getConversation(
          projectPath,
          SESSION,
          target.conversationId,
        ),
      admit: async (_projectPath, _backend, model) => model,
      resolveWork: async () => {},
      profile: async () => ({
        tier: "builtin",
        id: "standard-agent",
        name: "Standard agent",
        revision: 1,
        sourceContentHash: `sha256:${"a".repeat(64)}`,
        instructions: "Work carefully.",
        renderedInstructionBlock: "Work carefully.",
        resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      }),
      publish: () => {},
      now: () => new Date().toISOString(),
    });
    await forks.create({
      projectPath: PROJECT,
      source: {
        scope: "session",
        projectName: "repo",
        sessionName: SESSION,
        conversationId: CHAT,
      },
      operationId: "op-1",
      request: {
        requestId: FORK,
        name: "Notice fork",
        task: "",
        relatedWork: null,
        backend: "claude",
        modelSelection,
      },
    });
  }

  async function seedSyntheticFork() {
    await fixture.seedConversation(
      PROJECT,
      SESSION,
      makeConversationState({
        id: FORK,
        promptCount: 0,
        transcriptPath: "/t/fork-1.jsonl",
        backendRef: null,
        forkedFrom: {
          sourceConversationId: CHAT,
          messageIndex: 3,
          sourceBackend: "cursor",
          sourceBackendRef: { backend: "cursor", ref: "cursor-source" },
          forkLocator: null,
          forkMode: "synthetic",
          forkPending: false,
          syntheticSeed: "Earlier, the user asked for the notice to fire once.",
        },
      }),
    );
  }

  it("acknowledges a fork's history against the session that took it, even when that session could not be recorded", async () => {
    await seedSyntheticFork();
    const h = harness({ continuityFails: () => true });

    await h.send("Carry on", "attempt-f1", undefined, FORK);

    const row = await fixture
      .recreateStore()
      .getConversation(PROJECT, SESSION, FORK);
    expect(row?.forkedFrom?.syntheticSeedAcceptedRef).toEqual({
      backend: "claude",
      ref: FAKE_CLAUDE_SESSION_ID,
    });
  });

  it("does not send a fork's history again once a retried acknowledgment records it before the next message", async () => {
    await seedSyntheticFork();
    const writes = { failing: true };
    const h = harness({ acknowledgementFails: () => writes.failing });

    await h.send("Carry on", "attempt-f1", undefined, FORK);
    writes.failing = false;
    await h.send("And then?", "attempt-f2", undefined, FORK);

    expect(h.sent.map((turn) => turn.syntheticForkSeed ?? null)).toEqual([
      "Earlier, the user asked for the notice to fire once.",
      null,
    ]);
  });

  it("lets a ready checkpoint carry a fork's history, and never sends the history once that checkpoint is accepted", async () => {
    await seedSyntheticFork();
    const forkKey = { ...KEY, conversationId: FORK };
    const at = new Date().toISOString();
    unwrap(
      await realRepo.admitOperation({
        key: forkKey,
        requestId: "op-fork",
        sourceBasis: BASIS,
        priorBackendRef: null,
        requestedAt: at,
      }),
    );
    unwrap(
      await realRepo.freezePayload({
        key: forkKey,
        operationId: "op-fork",
        payload: { ...PAYLOAD, id: "op-fork" },
        at,
      }),
    );
    unwrap(
      await realRepo.commitReady({ key: forkKey, operationId: "op-fork", at }),
    );
    const h = harness();

    await h.send("Carry on", "attempt-f1", undefined, FORK);
    await h.send("And then?", "attempt-f2", undefined, FORK);

    expect(h.sent.map((turn) => turn.syntheticForkSeed ?? null)).toEqual([
      null,
      null,
    ]);
    expect(h.sent[0]?.promptText).toContain(PAYLOAD.seedText.trim());
    expect((await realRepo.getOperation(forkKey, "op-fork"))?.phase).toBe(
      "applied",
    );
  });

  it("frames a checkpoint fork's seed as its source's history on its first message", async () => {
    await forkCheckpoint(SONNET);
    const h = harness();

    await h.send("Pick up from the checkpoint", "attempt-c1", undefined, FORK);

    expect(h.sent[0]?.promptText).toContain(
      `This is conversation ${FORK}, forked from conversation ${CHAT}, checkpoint op-1`,
    );
  });

  it("keeps a checkpoint fork on the backend its first submission fixed, even when that message never started", async () => {
    await forkCheckpoint(SONNET);
    const h = harness();
    h.runtimes.down = true;
    await h.send("Pick up from the checkpoint", "attempt-c1", undefined, FORK);
    h.runtimes.down = false;

    const moved = await h.send(
      "Try on Codex",
      "attempt-c2",
      undefined,
      FORK,
      "codex",
    );

    expect(moved).toMatchObject({ status: "failed" });
    const row = await fixture
      .recreateStore()
      .getConversation(PROJECT, SESSION, FORK);
    expect(row?.agentBackend).toBe("claude");
    expect(row?.checkpointFork?.submission?.backend).toBe("claude");
  });

  it("runs a checkpoint fork's later messages on the conversation's own selection, not the configured default", async () => {
    const opus = { modelId: "opus", parameters: { effort: "high" } };
    await forkCheckpoint(opus);
    const h = harness();

    await h.send("Pick up from the checkpoint", "attempt-c1", undefined, FORK);
    await h.send("Continue", "attempt-c2", undefined, FORK);

    // The harness resolves an omitted selection to the conversation's own (Sonnet, medium).
    expect(h.sent.map((turn) => turn.modelSelection)).toEqual([
      opus,
      { modelId: "sonnet", parameters: { effort: "medium" } },
    ]);
  });

  it("runs a checkpoint fork's first message on the selection it was forked with, and fixes its backend", async () => {
    const opus = { modelId: "opus", parameters: { effort: "high" } };
    await forkCheckpoint(opus);
    const h = harness();

    await h.send("Pick up from the checkpoint", "attempt-c1", undefined, FORK);

    expect(h.sent[0]?.modelSelection).toEqual(opus);
    const row = await fixture
      .recreateStore()
      .getConversation(PROJECT, SESSION, FORK);
    expect(row?.checkpointFork?.submission?.backend).toBe("claude");
  });
});
