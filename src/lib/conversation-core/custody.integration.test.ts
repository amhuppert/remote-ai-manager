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
import {
  FAKE_CLAUDE_BACKGROUND_TASK_ID,
  FAKE_CLAUDE_HANGING_PROMPT,
  FAKE_CLAUDE_QUEUE_HOLD_PROMPT,
  FAKE_CLAUDE_QUEUE_LATER_PROMPT,
} from "@/lib/agent-backends/testing/fake-claude-sdk-port";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import { createControlPermits } from "@/lib/control/permits";
import { createBackgroundActivityChannel } from "@/lib/conversations/background-activity";
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
import type { RecordSubscriptionNoticeInput } from "@/lib/subscriptions/service";
import {
  createBackgroundTasksLostHandler,
  createLostTasksCallback,
} from "./contributions/background-tasks-lost";
import { createCustodyLossRecorder } from "./contributions/custody-loss";
import { createQueuedDeliveryAccounting } from "./contributions/queued-delivery-accounting";
import { createProductionConversationRecords } from "./production-records";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import {
  applyClaimEnded,
  applyCustodyRow,
  applyLiveInputAccepted,
  applySegmentUsage,
  applyTurnBegin,
  applyTurnClaimed,
  applyTurnSettlement,
  type ConversationRecordPort,
  type ConversationRow,
  type CustodyRecordPort,
  type LiveInputRecordPort,
} from "./conversation-record";
import { createRuntimeCustody } from "./custody";
import { createConversationCore, type ConversationCore } from "./executor";
import { createInteractiveTurns } from "./interactive-turns";
import { createConversationRequests } from "./requests";
import { createRuntimeHost } from "./runtime-host";
import type { UserTurnRequest } from "./schemas";
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
  const records: ConversationRecordPort &
    CustodyRecordPort &
    LiveInputRecordPort = {
    async recordLiveInput() {
      write(() => applyLiveInputAccepted(row, now));
    },
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
  options: {
    rows?: "memory" | "production";
    order?: string[];
    /** The custody attempt a closed scope's refusal inserts cannot be written. */
    custodyInsertFails?: boolean;
  } = {},
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
  const base: ConversationRecordPort & CustodyRecordPort & LiveInputRecordPort =
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
  const records: ConversationRecordPort &
    CustodyRecordPort &
    LiveInputRecordPort = {
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
  /** While set, transcript frame appends wait for it, stalling custody's event chain. */
  const frameHold: { until: Promise<void> | null } = { until: null };
  /** The background-activity indicator, as production's channel keeps it; a throttled publish never fires. */
  const activity = createBackgroundActivityChannel({
    publish: () => ({ delivered: true }),
    nowMs: () => Date.now(),
    setTimer: () => null,
    clearTimer: () => {},
  });
  const losses: string[] = [];
  /** The person's loss notices in the transcript and the runtime-loss facts the next turn's input carries, as production records them. */
  const lossNotices: TranscriptEntry[] = [];
  const lossFacts: RecordSubscriptionNoticeInput[] = [];
  const recordRuntimeLossNotice = async (
    input: RecordSubscriptionNoticeInput,
  ) => {
    lossFacts.push(input);
    return true;
  };
  const recordCustodyLoss = createCustodyLossRecorder({
    recordRuntimeLossNotice,
    async appendTranscriptEntryOnce(_identity, entry) {
      if (!lossNotices.some((kept) => kept.id === entry.id))
        lossNotices.push(entry);
    },
    log,
  });
  /** The conversation's message queue, which live input is claimed from and released to. */
  let queuedIds = 0;
  const liveQueue = createMessageQueueService({
    mutateConversation: persistence.store.mutateConversation,
    getConversation: persistence.store.getConversation,
    getProjectDisplayName: () => "repo",
    broadcast: () => {},
    now: () => now,
    newId: () => `live-${++queuedIds}`,
  });
  const queueKey = {
    projectPath: PROJECT,
    sessionName: SESSION,
    conversationId: CHAT,
  };
  /** User entries the transcript archived for queued input, once each. */
  const userEntries: TranscriptEntry[] = [];
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
    readInstructions: async () => ({
      sessionInstructions: [...instructions.lines],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    tooling: async () => ({ overrides: {} }),
    beginSeed: async () => ({ async commit() {} }),
    callbacks: (conversation, track) =>
      conversation.executionClass === "ordinary-conversation"
        ? {
            ...custody.callbacks(conversation, track),
            onBackgroundActivity: (snapshot) =>
              activity.record(
                {
                  projectName: "repo",
                  sessionName: SESSION,
                  conversationId: conversation.conversationId,
                },
                snapshot,
              ),
            onBackgroundTasksLost: createLostTasksCallback({
              custody,
              conversationId: conversation.conversationId,
              clearIndicator: () =>
                activity.record(
                  {
                    projectName: "repo",
                    sessionName: SESSION,
                    conversationId: conversation.conversationId,
                  },
                  null,
                ),
              record: createBackgroundTasksLostHandler(
                { recordRuntimeLossNotice, log },
                {
                  projectPath: PROJECT,
                  sessionName: SESSION,
                  conversationId: conversation.conversationId,
                  async appendTranscriptEntry(_conversationId, entry) {
                    lossNotices.push(entry);
                  },
                },
              ),
              track,
            }),
          }
        : {},
    index: { register: () => {}, unregister: () => {} },
    log,
  });
  const appendFrame = async (
    _conversationId: string,
    entry: TranscriptEntry,
  ) => {
    if (frameHold.until !== null) await frameHold.until;
    for (const block of entry.content ?? [])
      if (block.type === "text") frames.push(block.text);
  };
  const custody = createRuntimeCustody({
    host,
    records,
    appendFrame,
    applyStagedCapabilities: async () => {},
    recordLoss: async (input) => {
      losses.push(`${input.key}:${input.end}`);
      await recordCustodyLoss(input);
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
    queuedDelivery: ({ delivery, appendUserEntry }) =>
      createQueuedDeliveryAccounting(
        {
          markQueuedUncertain: (input) => liveQueue.markUncertain(input),
          confirmQueuedDelivery: (input) => liveQueue.confirmDelivery(input),
        },
        { ...queueKey, queuedDelivery: delivery, appendUserEntry },
      ),
    failQueued: ({ delivery, error }) =>
      liveQueue.markFailed({
        ...queueKey,
        ids: delivery.messageIds,
        deliveryAttemptId: delivery.deliveryAttemptId,
        error,
      }),
    returnQueued: ({ delivery, error }) =>
      liveQueue.markPending({
        ...queueKey,
        ids: delivery.messageIds,
        deliveryAttemptId: delivery.deliveryAttemptId,
        error,
      }),
    transcript: {
      async appendTranscriptEntryOnce(_conversationId, entry) {
        if (!userEntries.some((kept) => kept.id === entry.id))
          userEntries.push(entry);
      },
    },
    getProjectDisplayName: () => "repo",
    startDebugVerification: () => {},
    log,
  });
  const repo = createConversationCoreRepo(persistence.db);
  const coreRepo: typeof repo = {
    ...repo,
    insertAttempt(record) {
      if (options.custodyInsertFails && record.cause.startsWith("custody:"))
        throw new Error("the database is locked");
      repo.insertAttempt(record);
    },
  };
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
    repo: coreRepo,
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
    async custodyLoss({ place, attemptId, end, collected, tasks }) {
      losses.push(`${attemptId}:${end}`);
      await recordCustodyLoss({
        identity: {
          projectPath: place.projectPath,
          storeSessionName: place.sessionName,
          conversationId: place.conversationId,
        },
        key: attemptId,
        end,
        collected,
        tasks,
      });
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
    lossNotices,
    lossFacts,
    activity,
    frameHold,
    turnHooks,
    instructions,
    order,
    storedRow,
    slots,
    releaseSlot,
    custodyAttempts,
    interactiveTurns,
    liveQueue,
    userEntries,
    identity: {
      projectPath: PROJECT,
      storeSessionName: SESSION,
      conversationId: CHAT,
    },
    /** The rows the conversation's queue still holds, as the store keeps them. */
    async pendingQueue() {
      return (await persistence.store.getConversation(PROJECT, SESSION, CHAT))
        ?.pendingQueue;
    },
    /** A message queued while the agent works, claimed for live delivery as the queue claims it. */
    async queueLive(text: string): Promise<UserTurnRequest> {
      await seeded;
      const entry = await liveQueue.enqueue({
        ...queueKey,
        inputOrigin: "user",
        content: [{ type: "text", text }],
      });
      const claimed = await liveQueue.claimLiveDelivery({
        ...queueKey,
        id: entry.id,
      });
      if (claimed?.deliveryAttemptId == null)
        throw new Error("the queue did not claim the message");
      return {
        kind: "user_message",
        text,
        inputOrigin: "user",
        queuedDelivery: {
          messageIds: [entry.id],
          deliveryAttemptId: claimed.deliveryAttemptId,
        },
      };
    },
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
  /** The CLI dies with these tasks running: the adapter reports them lost at once, its death only on `terminate`. */
  die(tasks: Array<{ taskId: string; description: string | null }>): void;
  /** The runtime's death reaches its host. */
  terminate(): void;
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
        die(tasks) {
          status = "dead";
          owing = false;
          input.onBackgroundTasksLost?.({ tasks, reason: "pump_completed" });
        },
        terminate() {
          input.onTerminated?.({ reason: "pump_completed" });
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

describe("live input into a retaining Claude runtime (design C5b §4.2, slice 4)", () => {
  /** The real Claude adapter over the scripted SDK port, as production composes it. */
  function claude() {
    const provider = createScriptedConversationBackend({
      backend: "claude",
      responseText: JSON.stringify({ done: true }),
    });
    cleanups.push(() => provider.close());
    return { factory: provider.factory, sdk: provider.claudeSdk };
  }

  it("folds live input into the running turn: one result names both inputs, the input counts as a prompt, and nothing is kept (Claude adapter)", async () => {
    const { factory, sdk } = claude();
    const h = compose(factory);
    const sent = await h.send(
      `Check the build. ${FAKE_CLAUDE_QUEUE_HOLD_PROMPT}`,
    );
    await vi.waitFor(async () =>
      expect(await h.interactiveTurns.acceptsLive(CHAT)).toBe(true),
    );

    const live = await h.queueLive("Also check the docs.");
    expect(await h.interactiveTurns.deliverLive(h.identity, live)).toBe(
      "accepted",
    );
    expect(sdk.lastPromptText).toContain("Also check the docs.");
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);

    expect(h.custodyAttempts()).toEqual([]);
    expect(h.host.runtime(CHAT)).toBeNull();
    expect(h.row).toMatchObject({ status: "awaiting", promptCount: 3 });
    expect(h.userEntries.map((entry) => entry.id)).toEqual(
      live.queuedDelivery?.messageIds,
    );
    expect(await h.pendingQueue()).toEqual([]);
  });

  it("answers live input the turn's result left unanswered in custody's first provider turn: the turn ends without waiting, the row shows the answer running, and its frames and cost are recorded (Claude adapter)", async () => {
    const { factory, sdk } = claude();
    const h = compose(factory);
    const sent = await h.send(
      `Check the build. ${FAKE_CLAUDE_QUEUE_LATER_PROMPT}`,
    );
    await vi.waitFor(async () =>
      expect(await h.interactiveTurns.acceptsLive(CHAT)).toBe(true),
    );
    const live = await h.queueLive("Also check the docs.");
    expect(await h.interactiveTurns.deliverLive(h.identity, live)).toBe(
      "accepted",
    );

    // The turn's own result names only its prompt: the turn ends on it.
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);
    expect(h.custodyAttempts()).toMatchObject([{ state: "admitted" }]);
    expect(h.host.runtime(CHAT)?.status).toBe("alive");
    expect(h.row).toMatchObject({ status: "awaiting", promptCount: 3 });
    expect(await h.pendingQueue()).toEqual([]);
    const costBefore = h.row.totalCostUsd ?? 0;
    const turnsBefore = h.row.totalTurns ?? 0;
    h.statuses.length = 0;

    sdk.answerQueuedInputs({ totalCostUsd: 0.05 });
    await vi.waitFor(() =>
      expect(h.custodyAttempts()).toMatchObject([
        { state: "settled", outcome: { kind: "custody", end: "settled" } },
      ]),
    );

    expect(h.statuses).toEqual(["running", "awaiting"]);
    expect(h.frames).toContain("Answered the queued input.");
    expect(h.row.totalCostUsd).toBeCloseTo(costBefore + 0.04);
    expect(h.row.totalTurns).toBe(turnsBefore + 1);
    // The answer is no prompt of its own: the input was counted when it was accepted.
    expect(h.row).toMatchObject({
      status: "awaiting",
      unread: true,
      promptCount: 3,
    });
    expect(h.host.runtime(CHAT)).toBeNull();
    expect(h.admission.held()).toEqual([]);
    expect(h.losses).toEqual([]);
  });

  it("takes live input into the provider turn custody holds, which owns it until the provider turn's result answers it (Claude adapter)", async () => {
    const { factory, sdk } = claude();
    const h = compose(factory);
    const sent = await h.send(
      `Run the suite in the background. ${FAKE_CLAUDE_HANGING_PROMPT}`,
    );
    await vi.waitFor(() =>
      expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
    );
    sdk.startBackgroundTask();
    sdk.pushExternalTurn();
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);
    expect(h.custodyAttempts()).toMatchObject([{ state: "admitted" }]);
    expect(h.row.promptCount).toBe(2);

    sdk.endBackgroundTask();
    sdk.startContinuation();
    await vi.waitFor(async () =>
      expect(await h.interactiveTurns.acceptsLive(CHAT)).toBe(true),
    );
    expect(h.row.status).toBe("running");
    const live = await h.queueLive("Also rerun the flaky test.");
    expect(await h.interactiveTurns.deliverLive(h.identity, live)).toBe(
      "accepted",
    );
    // Receipts settle at acceptance, before the provider turn's result.
    expect(h.userEntries.map((entry) => entry.id)).toEqual(
      live.queuedDelivery?.messageIds,
    );
    expect(await h.pendingQueue()).toEqual([]);
    expect(h.row.promptCount).toBe(3);

    sdk.finishContinuation({ totalCostUsd: 0.03 });
    await vi.waitFor(() =>
      expect(h.custodyAttempts()).toMatchObject([
        { state: "settled", outcome: { kind: "custody", end: "settled" } },
      ]),
    );
    expect(h.row).toMatchObject({ status: "awaiting", promptCount: 3 });
    expect(h.host.runtime(CHAT)).toBeNull();
    expect(h.losses).toEqual([]);
  });

  it("keeps custody for live input a provider turn's result left unanswered, until the CLI answers it in a provider turn of its own (Claude adapter)", async () => {
    const { factory, sdk } = claude();
    const h = compose(factory);
    const sent = await h.send(
      `Run the suite in the background. ${FAKE_CLAUDE_HANGING_PROMPT}`,
    );
    await vi.waitFor(() =>
      expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
    );
    sdk.startBackgroundTask();
    sdk.pushExternalTurn();
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);

    sdk.endBackgroundTask();
    sdk.startContinuation();
    await vi.waitFor(async () =>
      expect(await h.interactiveTurns.acceptsLive(CHAT)).toBe(true),
    );
    const live = await h.queueLive("Also rerun the flaky test.");
    expect(await h.interactiveTurns.deliverLive(h.identity, live)).toBe(
      "accepted",
    );
    expect(h.row.promptCount).toBe(3);

    // The continuation's result names no input: the input is still owed.
    sdk.finishContinuation({ totalCostUsd: 0.03, leaveInputs: true });
    await vi.waitFor(() => expect(h.row.status).toBe("awaiting"));
    expect(h.custodyAttempts()).toMatchObject([{ state: "admitted" }]);

    sdk.answerQueuedInputs({ totalCostUsd: 0.04 });
    await vi.waitFor(() =>
      expect(h.custodyAttempts()).toMatchObject([
        { state: "settled", outcome: { kind: "custody", end: "settled" } },
      ]),
    );
    expect(h.row).toMatchObject({ status: "awaiting", promptCount: 3 });
    expect(h.host.runtime(CHAT)).toBeNull();
    expect(h.losses).toEqual([]);
  });

  it("refuses live input in idle custody: the message stays queued and drains as a turn that takes the runtime over (Claude adapter)", async () => {
    const { factory, sdk } = claude();
    const h = compose(factory);
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

    expect(await h.interactiveTurns.acceptsLive(CHAT)).toBe(false);
    const live = await h.queueLive("Next, fix the lint.");
    expect(await h.interactiveTurns.deliverLive(h.identity, live)).toBe(
      "not_sent",
    );
    expect(sdk.lastPromptText).not.toContain("Next, fix the lint.");
    expect(await h.pendingQueue()).toMatchObject([
      { id: live.queuedDelivery?.messageIds[0], status: "pending" },
    ]);
    expect(h.row.promptCount).toBe(2);

    // The queue drains it as the conversation's next turn.
    const batch = await h.liveQueue.claimNextTurnBatch({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CHAT,
    });
    if (batch === null) throw new Error("nothing to drain");
    const drained = await h.core.sendUserMessage({
      conversationId: CHAT,
      text: "Next, fix the lint.",
      inputOrigin: "user",
      queuedDelivery: {
        messageIds: batch.messageIds,
        deliveryAttemptId: batch.deliveryAttemptId,
      },
    });
    if (drained.kind !== "accepted") throw new Error(drained.message);
    expect(await drained.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);

    expect(sdk.lastPromptText).toContain("Next, fix the lint.");
    expect(
      h
        .custodyAttempts()
        .find((attempt) => attempt.attemptId === custody?.attemptId),
    ).toMatchObject({ outcome: { kind: "custody", end: "handed_over" } });
    expect(await h.pendingQueue()).toEqual([]);
    expect(h.row.promptCount).toBe(3);
  });
});

describe("one record of each loss of work kept between turns (design C5b §6)", () => {
  /** The real Claude adapter over the scripted SDK port, as production composes it. */
  function claude() {
    const provider = createScriptedConversationBackend({
      backend: "claude",
      responseText: JSON.stringify({ done: true }),
    });
    cleanups.push(() => provider.close());
    return { factory: provider.factory, sdk: provider.claudeSdk };
  }

  /** A turn that leaves a background task running ends, and custody keeps its runtime. */
  async function keptInCustody() {
    const { factory, sdk } = claude();
    const h = compose(factory);
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
    if (custody === undefined) throw new Error("custody did not open");
    return { h, sdk, custody };
  }

  it("Stop in idle custody tells the person and the next turn once, through custody (Claude adapter)", async () => {
    const { h, custody } = await keptInCustody();

    await h.core.stopConversation(CHAT).settled;

    expect(h.lossNotices.map((notice) => notice.id)).toEqual([
      `custody-loss:${custody.attemptId}`,
    ]);
    expect(h.lossFacts.map((fact) => fact.fact.occurrenceId)).toEqual([
      `custody-loss:${custody.attemptId}`,
    ]);
  });

  it("a handover whose configuration drifted records the work its close cut short once, as reconfigured (Claude adapter)", async () => {
    const { h } = await keptInCustody();
    h.instructions.lines = ["Work carefully.", "A new reference document."];

    const second = await h.send("Then deploy");
    expect(await second.settled).toMatchObject({ status: "succeeded" });

    expect(h.lossNotices).toHaveLength(1);
    expect(h.lossFacts).toHaveLength(1);
    expect(h.lossFacts[0]?.fact.sourceText).toContain(
      "the conversation's configuration changed",
    );
  });

  it("the death of a runtime custody holds is recorded once, as lost (Claude adapter)", async () => {
    const { h, sdk, custody } = await keptInCustody();

    sdk.endProvider();
    await vi.waitFor(() =>
      expect(h.custodyAttempts()).toMatchObject([
        { state: "settled", outcome: { kind: "custody", end: "lost" } },
      ]),
    );

    expect(h.lossNotices.map((notice) => notice.id)).toEqual([
      `custody-loss:${custody.attemptId}`,
    ]);
    expect(h.lossFacts).toHaveLength(1);
  });

  it("an ordinary turn stopped with a background task running keeps the adapter's one record (Claude adapter)", async () => {
    const { factory, sdk } = claude();
    const h = compose(factory);
    const sent = await h.send(
      `Run the suite in the background. ${FAKE_CLAUDE_HANGING_PROMPT}`,
    );
    await vi.waitFor(() =>
      expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
    );
    sdk.startBackgroundTask();
    await vi.waitFor(() =>
      expect(h.host.runtime(CHAT)?.owesWork?.()).toBe(true),
    );

    await h.core.stopConversation(CHAT).settled;
    await sent.settled;
    await h.core.conversationIdle(CHAT);

    expect(h.custodyAttempts()).toEqual([]);
    expect(h.lossNotices).toHaveLength(1);
    expect(h.lossFacts.map((fact) => fact.reason)).toEqual([
      "Background tasks lost",
    ]);
  });

  /** A turn ends owing work while its session is closed to background work, without a stop: custody is refused. */
  async function endsOwingWhileClosed(
    end: "merging" | "archived",
    options: { custodyInsertFails?: boolean } = {},
  ) {
    const { factory, sdk } = claude();
    const h = compose(factory, options);
    const sent = await h.send(
      `Run the suite in the background. ${FAKE_CLAUDE_HANGING_PROMPT}`,
    );
    await vi.waitFor(() =>
      expect(sdk.lastPromptText).toContain(FAKE_CLAUDE_HANGING_PROMPT),
    );
    sdk.startBackgroundTask();
    const committed = gate();
    const closing = h.core.closeBackgroundWork(
      { projectPath: PROJECT, sessionName: SESSION },
      () => committed.wait(),
      { end, stop: false },
    );
    sdk.pushExternalTurn();
    await sent.settled;
    await h.core.conversationIdle(CHAT);
    committed.open();
    await closing;
    expect(h.host.runtime(CHAT)).toBeNull();
    return h;
  }

  it.each(["merging", "archived"] as const)(
    "a turn that ends owing work while its session is closed to it (%s) records the loss once, through the refused custody (Claude adapter)",
    async (end) => {
      const h = await endsOwingWhileClosed(end);

      const [refused] = h.custodyAttempts();
      expect(refused).toMatchObject({
        state: "settled",
        outcome: { kind: "custody", end: "refused" },
      });
      expect(h.lossNotices.map((notice) => notice.id)).toEqual([
        `custody-loss:${refused?.attemptId}`,
      ]);
      expect(h.lossFacts).toHaveLength(1);
    },
  );

  it("keeps the adapter's record as the one record when the refused custody's attempt cannot be written (Claude adapter)", async () => {
    const h = await endsOwingWhileClosed("merging", {
      custodyInsertFails: true,
    });

    expect(h.custodyAttempts()).toEqual([]);
    expect(h.lossNotices).toHaveLength(1);
    expect(h.lossFacts.map((fact) => fact.reason)).toEqual([
      "Background tasks lost",
    ]);
  });

  /** The text of the person's one loss notice. */
  function noticeText(h: { lossNotices: TranscriptEntry[] }): string {
    return (h.lossNotices[0]?.content ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }

  it("names each task the closed runtime cut short in the one notice and the one fact (Claude adapter)", async () => {
    const { h, sdk } = await keptInCustody();
    sdk.startBackgroundTask({ taskId: "task-b", description: "npm run build" });
    await vi.waitFor(() =>
      expect(h.activity.get(CHAT)?.tasks.map((task) => task.taskId)).toEqual([
        FAKE_CLAUDE_BACKGROUND_TASK_ID,
        "task-b",
      ]),
    );

    await h.core.stopConversation(CHAT).settled;

    expect(h.lossNotices).toHaveLength(1);
    expect(h.lossFacts).toHaveLength(1);
    for (const named of [
      FAKE_CLAUDE_BACKGROUND_TASK_ID,
      "task-b (npm run build)",
    ]) {
      expect(noticeText(h)).toContain(named);
      expect(h.lossFacts[0]?.fact.sourceText).toContain(named);
    }
  });

  it("clears the background-activity indicator when custody claims the loss (Claude adapter)", async () => {
    const { h } = await keptInCustody();
    await vi.waitFor(() => expect(h.activity.get(CHAT)).not.toBeNull());

    await h.core.stopConversation(CHAT).settled;

    expect(h.activity.get(CHAT)).toBeNull();
    expect(h.lossNotices).toHaveLength(1);
  });

  it("a death the adapter reports before custody hears of it ends custody lost at once: a message admitted meanwhile waits for it, and the loss is recorded once", async () => {
    const provider = drivenClaude([
      { costUsd: 0.25, owesAfter: true },
      { costUsd: 0.5, owesAfter: false },
    ]);
    const h = compose(provider.factory);
    await (
      await h.send("Start the build in the background")
    ).settled;
    await h.core.conversationIdle(CHAT);
    const [custody] = h.custodyAttempts();
    const dying = provider.runtime;

    dying.die([{ taskId: "build-1", description: "npm run build" }]);
    const second = await h.send("And the lint?");
    expect(await second.settled).toMatchObject({ status: "succeeded" });
    await h.core.conversationIdle(CHAT);
    dying.terminate();

    expect(h.custodyAttempts()).toMatchObject([
      {
        attemptId: custody?.attemptId,
        outcome: { kind: "custody", end: "lost" },
      },
    ]);
    expect(h.losses).toEqual([`${custody?.attemptId}:lost`]);
    expect(h.lossNotices).toHaveLength(1);
    expect(h.lossFacts).toHaveLength(1);
    expect(provider.created).toHaveLength(2);
  });

  it("a runtime that dies after a stale 'owes nothing', with another task started meanwhile, ends custody lost with one record (Claude adapter)", async () => {
    const { h, sdk, custody } = await keptInCustody();
    let release: () => void = () => {};
    h.frameHold.until = new Promise<void>((resolve) => (release = resolve));
    // The continuation answers the finished task, but its frame's append is still pending when nothing is owed.
    sdk.endBackgroundTask();
    sdk.runContinuation();
    sdk.startBackgroundTask({ taskId: "task-b", description: "npm run build" });
    await vi.waitFor(() =>
      expect(h.activity.get(CHAT)?.tasks.map((task) => task.taskId)).toEqual([
        "task-b",
      ]),
    );

    sdk.endProvider();
    h.frameHold.until = null;
    release();
    await vi.waitFor(() =>
      expect(h.custodyAttempts()).toMatchObject([
        { state: "settled", outcome: { kind: "custody", end: "lost" } },
      ]),
    );

    expect(h.lossNotices.map((notice) => notice.id)).toEqual([
      `custody-loss:${custody.attemptId}`,
    ]);
    expect(h.lossFacts).toHaveLength(1);
    expect(noticeText(h)).toContain("task-b (npm run build)");
  });
});
