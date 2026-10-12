import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { getConversationTranscriptProjection } from "@/lib/agent-backends/conversation-policy";
import { FAKE_CLAUDE_HANGING_PROMPT } from "@/lib/agent-backends/testing/fake-claude-sdk-port";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import { createControlPermits } from "@/lib/control/permits";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import {
  createWorkspaceAdmission,
  type WorkspaceAdmission,
} from "@/lib/workspace/admission";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createProductionConversationRecords } from "./production-records";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import {
  applyClaimEnded,
  applyCustodyRow,
  applySegmentUsage,
  applyTurnBegin,
  applyTurnClaimed,
  applyTurnSettlement,
  type ConversationRecordPort,
  type ConversationRow,
  type CustodyRecordPort,
} from "./conversation-record";
import { createRuntimeCustody } from "./custody";
import { createConversationCore, type ConversationCore } from "./executor";
import { createInteractiveTurns } from "./interactive-turns";
import { createConversationRequests } from "./requests";
import { createRuntimeHost } from "./runtime-host";
import { passthroughTurnInput } from "./testing/passthrough-input";
import { createTurnEngine } from "./turn-engine";

// The Claude adapter reads the SDK environment at import; nothing here reaches it.
vi.mock("@/lib/shared/sdk-env", () => ({}));

const PROJECT = "/repo";
const SESSION = "session";
const CHAT = "conv-1";
const WORKTREE = mkdtempSync(path.join(tmpdir(), "cc-core-custody-wt-"));
const now = "2026-10-12T08:00:00.000Z";
const log = createCapturingLogger();

let fixture: PersistenceFixture | undefined;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  fixture?.close();
});

/** The conversation row a turn and its custody write, through the production pure transitions. */
function memoryRow() {
  const row: ConversationRow = {
    status: "awaiting",
    activeTurnSource: null,
    promptCount: 1,
    lastActivityAt: now,
    backendRef: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    contextTokens: null,
    contextWindowMax: null,
    unread: false,
    pendingQuestionId: null,
    pendingQuestions: null,
    agentBackend: "claude",
    debugMode: null,
    turnGeneration: 0,
    owner: null,
  };
  /** Each status the row moved to, in order. */
  const statuses: string[] = [];
  const write = (change: () => void) => {
    const before = row.status;
    change();
    if (row.status !== before) statuses.push(row.status);
  };
  const records: ConversationRecordPort & CustodyRecordPort = {
    async read() {
      return {
        agentBackend: row.agentBackend,
        backendRef: row.backendRef,
        promptCount: row.promptCount,
        transcriptPath: null,
        debugMode: null,
        pendingQuestionId: row.pendingQuestionId,
        owner: null,
        forkedFrom: null,
        checkpointFork: undefined,
      };
    },
    async claimTurn() {
      write(() => applyTurnClaimed(row, now));
    },
    async endClaim() {
      write(() => applyClaimEnded(row));
    },
    async beginTurn(_identity, source) {
      write(() => applyTurnBegin(row, source, now));
    },
    async settleTurn(_identity, settlement, source, custody) {
      write(() => {
        applyTurnSettlement(row, settlement, now, source);
        const shown = custody?.() ?? null;
        if (shown?.status === "running") applyCustodyRow(row, shown, now);
      });
      return { debug: null };
    },
    async recordSegment(_identity, usage, project) {
      write(() => {
        if (usage !== null) applySegmentUsage(row, usage);
        const shown = project();
        if (shown !== null) applyCustodyRow(row, shown, now);
      });
    },
    async admitProfile() {
      return { instructionBlock: null, snapshot: null, lockedAt: null };
    },
    async adoptBackend() {},
    async recordSeenAlignment() {},
    async recordContinuity(_identity, ref) {
      row.backendRef = ref;
    },
    async recordWithdrawn() {},
    async recordInterrupted() {},
    hasPendingQuestion: () => false,
    async withdrawQuestion() {
      return false;
    },
  };
  return { row, statuses, records };
}

/** Points where a test pauses or fails a turn: after admission, at receipt settlement, at the row's reads and writes. */
interface TurnHooks {
  /** After the turn's admission, before its prompt is sent. */
  beforeSend(): Promise<void> | void;
  /** As the turn prepares its input, after a handover's drift check. */
  prepare(): Promise<void> | void;
  /** As the turn settles its input's receipts, after its result. */
  settle(): Promise<void> | void;
  read(): Promise<void> | void;
  begin(): Promise<void> | void;
  afterSettleTurn(): void;
}

/**
 * The core as production composes it (executor, interactive turns, turn
 * engine through AgentCall, runtime host and custody) over a persistence
 * fixture, with the provider in memory. The conversation row is the
 * production records over SQLite, or a memory row through the production
 * transitions.
 */
function compose(
  factory: ConversationBackendFactory,
  options: { rows?: "memory" | "production"; order?: string[] } = {},
) {
  const persistence = createPersistenceFixture();
  fixture = persistence;
  persistence.seedProject(PROJECT);
  persistence.seedSession(PROJECT, SESSION, { worktreePath: WORKTREE });
  const seeded = persistence.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({ id: CHAT, role: null, agentBackend: "claude" }),
  );
  const memory = memoryRow();
  const { row, statuses } = memory;
  const order = options.order ?? [];
  const turnHooks: TurnHooks = {
    beforeSend() {},
    prepare() {},
    settle() {},
    read() {},
    begin() {},
    afterSettleTurn() {},
  };
  const base: ConversationRecordPort & CustodyRecordPort =
    options.rows === "production"
      ? {
          ...createProductionConversationRecords({
            db: () => persistence.db,
            getConversation: persistence.store.getConversation,
            mutateConversation: persistence.store.mutateConversation,
            queue: createMessageQueueService({
              mutateConversation: persistence.store.mutateConversation,
              getConversation: persistence.store.getConversation,
              getProjectDisplayName: () => "repo",
              broadcast: () => {},
              now: () => now,
              newId: () => "queued-1",
            }),
          }),
          admitProfile: async () => ({
            instructionBlock: null,
            snapshot: null,
            lockedAt: null,
          }),
        }
      : memory.records;
  const records: ConversationRecordPort & CustodyRecordPort = {
    ...base,
    async read(identity) {
      await turnHooks.read();
      return base.read(identity);
    },
    async beginTurn(identity, source) {
      await turnHooks.begin();
      return base.beginTurn(identity, source);
    },
    async settleTurn(identity, settlement, source, custody) {
      const settled = await base.settleTurn(
        identity,
        settlement,
        source,
        custody,
      );
      turnHooks.afterSettleTurn();
      return settled;
    },
  };
  /** The row as a restarted server reads it. */
  const storedRow = async () =>
    persistence.recreateStore().getConversation(PROJECT, SESSION, CHAT);
  const frames: string[] = [];
  const losses: string[] = [];
  const instructions = { lines: ["Work carefully."] };
  const slots = { free: 2, waiting: [] as Array<() => void> };
  const releaseSlot = () => {
    const next = slots.waiting.shift();
    if (next !== undefined) next();
    else slots.free += 1;
  };

  const host = createRuntimeHost({
    factory: () => factory,
    instructions: async () => ({
      sessionInstructions: [...instructions.lines],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    tooling: async () => ({ overrides: {} }),
    beginSeed: async () => ({ async commit() {} }),
    callbacks: (conversation, track) =>
      conversation.executionClass === "ordinary-conversation"
        ? custody.callbacks(conversation, track)
        : {},
    index: { register: () => {}, unregister: () => {} },
    log,
  });
  const appendFrame = async (
    _conversationId: string,
    entry: TranscriptEntry,
  ) => {
    for (const block of entry.content ?? [])
      if (block.type === "text") frames.push(block.text);
  };
  const custody = createRuntimeCustody({
    host,
    records,
    appendFrame,
    applyStagedCapabilities: async () => {},
    recordLoss: async ({ key, end }) => {
      losses.push(`${key}:${end}`);
    },
    log,
  });
  const engine = createTurnEngine({
    host,
    executeAgentCall,
    transcript: {
      safeAppendTranscriptEntry: appendFrame,
      safeAppendTranscriptEntryOnce: appendFrame,
    },
    projection: getConversationTranscriptProjection,
    timeouts: async () => ({ timeoutMs: 0, stallTimeoutMs: 0 }),
    log,
  });
  const interactiveTurns = createInteractiveTurns({
    engine,
    records,
    host,
    custody,
    worktreeOf: async () => WORKTREE,
    admitCheckpointFork: async () => null,
    async resolveModelSelection() {
      await turnHooks.beforeSend();
      return { modelId: "sonnet", parameters: { effort: "medium" } };
    },
    continuation: async () => ({
      continuation: { kind: "ordinary" },
      seed: null,
    }),
    async prepareInput(request) {
      await turnHooks.prepare();
      const prepared = passthroughTurnInput(request);
      return {
        ...prepared,
        async settle() {
          await turnHooks.settle();
          return prepared.settle();
        },
      };
    },
    nameConversation: () => {},
    requestUserQuestion: async () => ({
      status: "answered" as const,
      answers: {},
    }),
    persistImages: async ({ promptText }) => ({ promptText, imageRefs: [] }),
    queuedDelivery: () => {
      throw new Error("a direct message has no queued delivery");
    },
    failQueued: async () => {},
    returnQueued: async () => {},
    transcript: { async appendTranscriptEntryOnce() {} },
    getProjectDisplayName: () => "repo",
    startDebugVerification: () => {},
    log,
  });
  const repo = createConversationCoreRepo(persistence.db);
  const workspace = createWorkspaceAdmission();
  // Grant releases join the order log, so a test can see what was collected before a worktree was let go.
  const admission: WorkspaceAdmission = {
    ...workspace,
    release(grant) {
      order.push(`release:${grant.holder}`);
      workspace.release(grant);
    },
  };
  const core: ConversationCore = createConversationCore({
    transaction: (fn) => persistence.db.transaction(fn)(),
    repo,
    permits: createControlPermits(createControlPermitsRepo(persistence.db)),
    admission,
    interactiveWorktree: async () => WORKTREE,
    async createSeatConversation() {
      throw new Error("no seats here");
    },
    turns: {
      async run() {
        throw new Error("no seats here");
      },
    },
    userTurns: interactiveTurns,
    taskTurns: {
      async run() {
        throw new Error("no tasks here");
      },
    },
    records,
    async custodyLoss({ attemptId, end }) {
      losses.push(`${attemptId}:${end}`);
    },
    uptimeMs: () => 60_000,
    slots: {
      acquire(_label, signal) {
        if (slots.free > 0) {
          slots.free -= 1;
          return Promise.resolve(releaseSlot);
        }
        return new Promise((resolve, reject) => {
          const waiter = () => resolve(releaseSlot);
          slots.waiting.push(waiter);
          signal.addEventListener(
            "abort",
            () => {
              slots.waiting = slots.waiting.filter((w) => w !== waiter);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    },
    questions: createConversationRequests({
      transaction: (fn) => persistence.db.transaction(fn)(),
      repo,
      touchRequester: () => {},
      now: () => now,
    }),
    touchRequester: () => {},
    now: () => now,
    permitPollMs: 5,
    log,
  });
  cleanups.push(() => void core.shutdown());

  const custodyAttempts = () =>
    [
      ...repo.attemptsInState("admitted"),
      ...repo.attemptsInState("settled"),
    ].filter((attempt) => attempt.cause.startsWith("custody:"));

  return {
    seeded,
    core,
    host,
    admission,
    row,
    statuses,
    frames,
    losses,
    turnHooks,
    instructions,
    order,
    storedRow,
    slots,
    releaseSlot,
    custodyAttempts,
    async send(text: string) {
      await seeded;
      const sent = await core.sendUserMessage({
        conversationId: CHAT,
        text,
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      return sent;
    },
  };
}

/** A Claude-shaped runtime the test drives along the probe timelines (handover.jsonl): owed work, continuations, takeover. */
interface DrivenRuntime extends ConversationBackendRuntime {
  readonly input: ConversationBackendCreateInput;
  closed: boolean;
  /** The adapter's owed-work answer changes, reported only on a change. */
  owe(next: boolean): void;
  /** The CLI starts a continuation: announced by its first frame, not yet finished. */
  startContinuation(text: string): void;
  finishContinuation(costUsd: number): void;
}

function drivenClaude(
  turns: Array<{ costUsd: number; owesAfter: boolean }>,
  options: { order?: string[]; closeFailure?: string } = {},
) {
  const created: DrivenRuntime[] = [];
  const result = (costUsd: number | null): ConversationBackendTurnResult => ({
    backendRef: { backend: "claude", ref: "sdk-1" },
    costUsd,
    durationMs: costUsd === null ? null : 1_000,
    numTurns: costUsd === null ? null : 1,
    contextTokens: null,
    contextWindowMax: null,
    contentBlocks: [],
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
  });
  const factory: ConversationBackendFactory = {
    backend: "claude",
    async createRuntime(input) {
      let status: "alive" | "dead" = "alive";
      let owing = false;
      let continuing = false;
      const owe = (next: boolean) => {
        if (owing === next) return;
        owing = next;
        input.onOwedWorkChanged?.(next);
      };
      const frame = (text: string) =>
        input.onExternalTurnEvent?.({
          type: "transcript_entry",
          entry: {
            seq: 0,
            backend: "claude",
            type: "assistant",
            raw: {
              timestamp: now,
              type: "assistant",
              role: "assistant",
              content: [{ type: "text", text }],
            },
          },
        });
      const runtime: DrivenRuntime = {
        backend: "claude",
        get status() {
          return status;
        },
        modelSelection: input.modelSelection,
        input,
        closed: false,
        owesWork: () => status === "alive" && owing,
        owe,
        startContinuation(text) {
          continuing = true;
          owe(true);
          input.onExternalTurnEvent?.({ type: "external_turn_started" });
          frame(text);
        },
        finishContinuation(costUsd) {
          continuing = false;
          input.onExternalTurnEvent?.({
            type: "external_turn_completed",
            result: result(costUsd),
          });
          owe(false);
        },
        async sendTurn(turnInput) {
          // A caller's prompt takes the stream over: the provider turn completes on what it streamed.
          if (continuing) {
            continuing = false;
            input.onExternalTurnEvent?.({
              type: "external_turn_completed",
              result: result(null),
            });
          }
          await turnInput.onEvent({ type: "input_accepted" });
          const next = turns.shift() ?? { costUsd: 0, owesAfter: false };
          owe(next.owesAfter);
          return { ...result(next.costUsd), finalText: "Done." };
        },
        async close() {
          options.order?.push("close");
          if (options.closeFailure !== undefined)
            throw new Error(options.closeFailure);
          runtime.closed = true;
          if (continuing) {
            continuing = false;
            input.onExternalTurnEvent?.({
              type: "external_turn_completed",
              result: { ...result(null), aborted: true },
            });
          }
          status = "dead";
          owing = false;
          input.onTerminated?.({ reason: "closed" });
        },
      };
      created.push(runtime);
      return runtime;
    },
  };
  return {
    factory,
    get runtime(): DrivenRuntime {
      const latest = created.at(-1);
      if (latest === undefined) throw new Error("no runtime yet");
      return latest;
    },
    created,
  };
}

/** A point a turn waits at until the test opens it; `reached` resolves once the turn is there. */
function gate() {
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  return {
    reached,
    open: () => open(),
    wait(): Promise<void> {
      arrive();
      return opened;
    },
  };
}

describe("custody on the conversation core (design C5b, slice 3)", () => {
  it("runs the continuation of the last background task in custody after the turn ends, then lets the runtime go (Claude adapter)", async () => {
    const provider = createScriptedConversationBackend({
      backend: "claude",
      responseText: JSON.stringify({ done: true }),
    });
    cleanups.push(() => provider.close());
    const sdk = provider.claudeSdk;
    const h = compose(provider.factory);

    const sent = await h.send(
      `Run the suite in the background. ${FAKE_CLAUDE_HANGING_PROMPT}`,
    );
    await vi.waitFor(() =>
      expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
    );
    // The turn starts background work, then answers.
    sdk.startBackgroundTask();
    sdk.pushExternalTurn();
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);

    expect(h.custodyAttempts()).toMatchObject([{ state: "admitted" }]);
    expect(h.host.runtime(CHAT)?.status).toBe("alive");
    expect(h.row).toMatchObject({ status: "awaiting", promptCount: 2 });
    const turnsBefore = h.row.totalTurns ?? 0;

    sdk.endBackgroundTask();
    sdk.runContinuation();
    await vi.waitFor(() =>
      expect(h.custodyAttempts()).toMatchObject([
        { state: "settled", outcome: { kind: "custody", end: "settled" } },
      ]),
    );

    expect(h.host.runtime(CHAT)).toBeNull();
    expect(h.admission.held()).toEqual([]);
    expect(h.frames).toContain("Background task completed.");
    // A provider turn shows on the row, is told to the person, and is no prompt.
    expect(h.statuses.slice(-2)).toEqual(["running", "awaiting"]);
    expect(h.row).toMatchObject({
      status: "awaiting",
      unread: true,
      promptCount: 2,
    });
    expect(h.row.totalTurns).toBe(turnsBefore + 1);
    expect(h.losses).toEqual([]);
  });

  it("stops custody's background work on request: the runtime closes, the loss is recorded, the row stays idle (Claude adapter)", async () => {
    const provider = createScriptedConversationBackend({
      backend: "claude",
      responseText: JSON.stringify({ done: true }),
    });
    cleanups.push(() => provider.close());
    const sdk = provider.claudeSdk;
    const h = compose(provider.factory);
    const sent = await h.send(`Watch the logs. ${FAKE_CLAUDE_HANGING_PROMPT}`);
    await vi.waitFor(() =>
      expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
    );
    sdk.startBackgroundTask();
    sdk.pushExternalTurn();
    await sent.settled;
    await h.core.conversationIdle(CHAT);
    const [custody] = h.custodyAttempts();

    const stop = h.core.stopConversation(CHAT);
    expect(stop.requested).toBe(true);
    await stop.settled;

    expect(h.custodyAttempts()).toMatchObject([
      { state: "settled", outcome: { kind: "custody", end: "stopped" } },
    ]);
    expect(h.losses).toEqual([`${custody?.attemptId}:stopped`]);
    expect(h.host.runtime(CHAT)).toBeNull();
    expect(h.row.status).toBe("awaiting");
    expect(h.core.stopConversation(CHAT).requested).toBe(false);
  });

  it("when a continuation is already running, a message takes the runtime over at its admission: the row stays the turn's and the turn is charged", async () => {
    const provider = drivenClaude([
      { costUsd: 0.25, owesAfter: true },
      { costUsd: 0.5, owesAfter: false },
    ]);
    const h = compose(provider.factory);
    await (
      await h.send("Start the build in the background")
    ).settled;
    await h.core.conversationIdle(CHAT);

    provider.runtime.startContinuation("The build finished; checking it.");
    await vi.waitFor(() => expect(h.row.status).toBe("running"));
    h.statuses.length = 0;

    const second = await h.send("And the lint?");
    expect(await second.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);

    expect(h.custodyAttempts()).toMatchObject([
      { outcome: { kind: "custody", end: "handed_over" } },
    ]);
    // One runtime throughout: the turn ran on the one custody kept.
    expect(provider.created).toHaveLength(1);
    expect(provider.runtime.closed).toBe(true);
    // Running from the provider turn's start to the turn's end: the displaced provider turn moved nothing.
    expect(h.statuses).toEqual(["awaiting"]);
    expect(h.frames).toContain("The build finished; checking it.");
    expect(h.row).toMatchObject({ promptCount: 3, totalCostUsd: 0.75 });
  });

  it("when a message is admitted first, a continuation that starts before its prompt belongs to the message's turn and moves nothing on the row", async () => {
    const provider = drivenClaude([
      { costUsd: 0.25, owesAfter: true },
      { costUsd: 0.5, owesAfter: false },
    ]);
    const h = compose(provider.factory);
    await (
      await h.send("Start the build in the background")
    ).settled;
    await h.core.conversationIdle(CHAT);
    h.statuses.length = 0;

    h.turnHooks.beforeSend = () => {
      h.turnHooks.beforeSend = () => {};
      provider.runtime.startContinuation("The build finished.");
    };
    const second = await h.send("Ship it");
    expect(await second.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);

    expect(h.custodyAttempts()).toMatchObject([
      { outcome: { kind: "custody", end: "handed_over" } },
    ]);
    expect(h.frames).toContain("The build finished.");
    // Running from the claim to the turn's end: the provider turn the turn owned showed nothing of its own.
    expect(h.statuses).toEqual(["running", "awaiting"]);
    expect(h.row).toMatchObject({ promptCount: 3, totalCostUsd: 0.75 });
  });

  it("a message waiting for a model slot while a continuation starts keeps the row running, and Stop ends both without leaving it running", async () => {
    const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }]);
    const h = compose(provider.factory);
    await (
      await h.send("Start the build in the background")
    ).settled;
    await h.core.conversationIdle(CHAT);
    const [custody] = h.custodyAttempts();

    h.slots.free = 0;
    const waiting = await h.send("Then deploy");
    provider.runtime.startContinuation("Deploying.");
    await vi.waitFor(() => expect(h.row.activeTurnSource).toBe("user"));
    expect(h.row.status).toBe("running");

    const stop = h.core.stopConversation(CHAT);
    await stop.settled;
    expect(await waiting.settled).toMatchObject({ status: "cancelled" });
    await h.core.conversationIdle(CHAT);

    expect(h.custodyAttempts()).toMatchObject([
      { outcome: { kind: "custody", end: "stopped" } },
    ]);
    expect(h.losses).toEqual([`${custody?.attemptId}:stopped`]);
    expect(provider.runtime.closed).toBe(true);
    expect(h.row).toMatchObject({ status: "awaiting", activeTurnSource: null });
  });
  describe("review fixes", () => {
    it("Stop while a message that took the runtime over is still preparing collects the runtime instead of keeping it in a new custody", async () => {
      const order: string[] = [];
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }], {
        order,
      });
      const h = compose(provider.factory, { order });
      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      const paused = gate();
      h.turnHooks.beforeSend = () => paused.wait();

      const second = await h.send("Then deploy");
      await paused.reached;
      const stop = h.core.stopConversation(CHAT);
      expect(stop.requested).toBe(true);
      paused.open();
      await stop.settled;
      expect(await second.settled).toMatchObject({ status: "cancelled" });
      await h.core.conversationIdle(CHAT);

      expect(h.custodyAttempts()).toMatchObject([
        { outcome: { kind: "custody", end: "handed_over" } },
      ]);
      expect(provider.runtime.closed).toBe(true);
      expect(h.admission.held()).toEqual([]);
      expect(order.indexOf("close")).toBeLessThan(
        order.indexOf(`release:${second.cause}`),
      );
    });

    it("Stop after the result, while the turn settles its receipts, collects the runtime instead of keeping it in custody", async () => {
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }]);
      const h = compose(provider.factory);
      const paused = gate();
      h.turnHooks.settle = () => paused.wait();

      const first = await h.send("Start the build in the background");
      await paused.reached;
      const stop = h.core.stopConversation(CHAT);
      paused.open();
      await stop.settled;
      await first.settled;
      await h.core.conversationIdle(CHAT);

      expect(h.custodyAttempts()).toEqual([]);
      expect(provider.runtime.closed).toBe(true);
      expect(h.admission.held()).toEqual([]);
    });

    it("a message that took the runtime over and cannot read its row gives the runtime back to custody while it still owes work", async () => {
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }]);
      const h = compose(provider.factory);
      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      h.turnHooks.read = () => {
        h.turnHooks.read = () => {};
        throw new Error("the conversation store is unavailable");
      };

      const second = await h.send("Then deploy");
      expect(await second.settled).toMatchObject({ status: "failed" });
      await h.core.conversationIdle(CHAT);

      const kept = h.custodyAttempts().filter((a) => a.state === "admitted");
      expect(kept).toHaveLength(1);
      expect(provider.runtime.closed).toBe(false);
      expect(h.admission.held().map((grant) => grant.holder)).toEqual([
        kept[0]?.cause,
      ]);
    });

    it("a message that took the runtime over and cannot begin its turn collects a runtime that owes nothing more before letting its worktree go", async () => {
      const order: string[] = [];
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }], {
        order,
      });
      const h = compose(provider.factory, { order });
      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      h.turnHooks.begin = () => {
        h.turnHooks.begin = () => {};
        provider.runtime.owe(false);
        throw new Error("the conversation store is unavailable");
      };

      const second = await h.send("Then deploy");
      expect(await second.settled).toMatchObject({ status: "failed" });
      await h.core.conversationIdle(CHAT);

      expect(provider.runtime.closed).toBe(true);
      expect(order.indexOf("close")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("close")).toBeLessThan(
        order.indexOf(`release:${second.cause}`),
      );
      expect(h.custodyAttempts().filter((a) => a.state === "admitted")).toEqual(
        [],
      );
    });

    it("keeps the turn's worktree grant when the runtime such a failed turn inherited cannot be collected", async () => {
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }], {
        closeFailure: "the CLI did not exit",
      });
      const h = compose(provider.factory);
      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      h.turnHooks.read = () => {
        h.turnHooks.read = () => {};
        provider.runtime.owe(false);
        throw new Error("the conversation store is unavailable");
      };

      const second = await h.send("Then deploy");
      expect(await second.settled).toMatchObject({ status: "failed" });
      await h.core.conversationIdle(CHAT);

      expect(
        h.admission.tryAcquire({
          worktree: WORKTREE,
          kind: "git",
          holder: "publish",
        }),
      ).toBeNull();
    });

    it("keeps the stored row running when a turn ends with a continuation already running in custody", async () => {
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }]);
      const h = compose(provider.factory, { rows: "production" });
      h.turnHooks.settle = () => {
        h.turnHooks.settle = () => {};
        provider.runtime.startContinuation("Checking the build.");
      };

      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await h.storedRow())?.status).toBe("running");

      provider.runtime.finishContinuation(0.1);
      await vi.waitFor(async () =>
        expect((await h.storedRow())?.status).toBe("awaiting"),
      );
    });

    it("keeps the stored row running when the continuation starts between the turn's settlement and the end of its claim", async () => {
      const provider = drivenClaude([{ costUsd: 0.25, owesAfter: true }]);
      const h = compose(provider.factory, { rows: "production" });
      h.turnHooks.afterSettleTurn = () => {
        h.turnHooks.afterSettleTurn = () => {};
        provider.runtime.startContinuation("Checking the build.");
      };

      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await h.storedRow())?.status).toBe("running");
    });

    it("decides a handed-over runtime's reuse once: a configuration saved while the turn prepares its input applies next time", async () => {
      const provider = drivenClaude([
        { costUsd: 0.25, owesAfter: true },
        { costUsd: 0.5, owesAfter: false },
      ]);
      const h = compose(provider.factory);
      await (
        await h.send("Start the build in the background")
      ).settled;
      await h.core.conversationIdle(CHAT);
      h.turnHooks.prepare = () => {
        h.turnHooks.prepare = () => {};
        h.instructions.lines = ["Work carefully.", "A new reference document."];
      };

      const second = await h.send("Then deploy");
      expect(await second.settled).toMatchObject({ status: "succeeded" });
      expect(provider.created).toHaveLength(1);
      expect(h.losses).toEqual([]);
    });

    it("ends custody lost, with its loss recorded, when a finished background task's continuation never starts (Claude adapter)", async () => {
      const provider = createScriptedConversationBackend({
        backend: "claude",
        responseText: JSON.stringify({ done: true }),
        continuationDeadlineMs: 50,
      });
      cleanups.push(() => provider.close());
      const sdk = provider.claudeSdk;
      const h = compose(provider.factory);
      const sent = await h.send(
        `Run the suite in the background. ${FAKE_CLAUDE_HANGING_PROMPT}`,
      );
      await vi.waitFor(() =>
        expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
      );
      sdk.startBackgroundTask();
      sdk.pushExternalTurn();
      await sent.settled;
      await h.core.conversationIdle(CHAT);
      const [custody] = h.custodyAttempts();

      sdk.endBackgroundTask();
      await vi.waitFor(() =>
        expect(h.custodyAttempts()).toMatchObject([
          { state: "settled", outcome: { kind: "custody", end: "lost" } },
        ]),
      );
      expect(h.losses).toEqual([`${custody?.attemptId}:lost`]);
      expect(h.host.runtime(CHAT)).toBeNull();
    });
  });
});
