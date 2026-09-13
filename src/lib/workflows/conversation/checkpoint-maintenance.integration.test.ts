/**
 * Checkpoint maintenance through the actual provided manager and machine, over
 * real SQLite rows, the real checkpoint repository and the real generator
 * driven by a canned task runner. Only the provider runtime is a fake.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import {
  compactionEnvelopeSchema,
  type CompactionEnvelope,
} from "@/lib/context-artifacts/schemas";
import { withCheckpointPublication } from "@/lib/conversation-checkpoints/publication";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import type { ConversationBackgroundActivity } from "@/lib/conversations/schemas";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import {
  createLifecycleFixture,
  type LifecycleFixtureOptions,
} from "./testing/lifecycle-fixture";
import { checkpointScopeKeyForStoreIdentity } from "./actor-input-loader";
import { seededPrompt } from "./testing/checkpoint-harness";
import { enqueueQueuedMessage } from "@/lib/prompt/queue-operations";
import { toQueuedMessageView } from "@/lib/conversations/message-queue-service";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";

const TRANSCRIPT = "/lifecycle-fixture/transcripts/c.jsonl";
const LIVE_REF = { backend: "claude", ref: "sdk-session-live" } as const;

function text(
  seq: number,
  role: "user" | "assistant",
  body: string,
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-01-01T00:00:00Z",
    content: [{ type: "text", text: body }],
  };
}

const ENTRIES: TranscriptEntryWithSeq[] = [
  text(0, "user", "the deploy key lives in vault path ops/deploy-2026"),
  text(1, "assistant", "acknowledged, using the vault path"),
  text(2, "user", "build the checkpoint seed next"),
  text(3, "assistant", "starting on the builder"),
];

const WORKING_STATE = {
  objective: {
    text: "deliver the bounded checkpoint seed",
    sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
  },
  latestRequest: {
    text: "build the checkpoint seed next",
    sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
  },
  outstandingRequests: [],
  constraints: [],
  decisions: [],
  failedApproaches: [],
  openQuestions: [],
  blockers: [],
  nextActions: [
    {
      text: "freeze the rendered bytes",
      sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
    },
  ],
};

function envelopeFor(
  conversationId: string,
  endSeq: number,
): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "proj",
      sessionName: "sess",
      conversationId,
      coveredStartSeq: 0,
      coveredEndSeq: endSeq,
      messageCount: endSeq + 1,
      sourceHash: "envelope-hash",
    },
    agentBrief: "brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "build the checkpoint seed",
      nextBestActions: ["write the builder"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
  });
}

/** Echo the `source` block the compaction prompt tells the model to copy. */
function envelopeFromPrompt(prompt: string) {
  const marker =
    "## Source metadata (copy `kind` and `source` verbatim)\n```json\n";
  const start = prompt.indexOf(marker);
  if (start === -1) throw new Error("prompt has no source metadata section");
  const jsonStart = start + marker.length;
  const meta = JSON.parse(
    prompt.slice(jsonStart, prompt.indexOf("\n```", jsonStart)),
  ) as { kind: string; source: CompactionEnvelope["source"] };
  return {
    ...envelopeFor(meta.source.conversationId, meta.source.coveredEndSeq),
    source: meta.source,
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
  };
}

/** The generation lane's model: envelope for the compaction pass, working state for the seed pass. */
function cannedRunner(calls: AgentTaskRequest[]) {
  return {
    backend: "claude" as const,
    async run(request: AgentTaskRequest): Promise<AgentTaskResult> {
      calls.push(request);
      const output = request.prompt.includes("checkpoint working state")
        ? WORKING_STATE
        : envelopeFromPrompt(request.prompt);
      return {
        text: JSON.stringify(output),
        structuredOutput: output,
        usage: { inputTokens: 800, outputTokens: 200, costUsd: 0.5 },
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    },
  };
}

const TURN_RESULT: ConversationBackendTurnResult = {
  backendRef: LIVE_REF,
  costUsd: 0.01,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Wraps the real generator behind a gate so a test can hold the build. The
 * gate yields to the owned cancel signal the way a real lane would.
 */
function gatedGenerator() {
  const started = deferred();
  const gate = deferred();
  const generate: typeof generateCheckpoint = async (input, deps) => {
    started.resolve();
    await Promise.race([
      gate.promise,
      new Promise<void>((resolve) => {
        if (deps.signal?.aborted) resolve();
        deps.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return generateCheckpoint(input, deps);
  };
  return { generate, started, release: () => gate.resolve() };
}

const BACKGROUND: ConversationBackgroundActivity = {
  tasks: [
    {
      taskId: "task-1",
      description: "long test run",
      taskType: "bash",
      workflowName: null,
      subagentType: null,
      lastToolName: null,
      totalTokens: null,
      toolUses: null,
      startedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:01Z",
    },
  ],
  updatedAt: "2026-01-01T00:00:01Z",
};

let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
let releaseHeld: (() => void) | undefined;

afterEach(async () => {
  releaseHeld?.();
  releaseHeld = undefined;
  await fixture?.close();
  fixture = undefined;
});

interface Harness {
  runtime: ConversationBackendRuntime;
  dispatches: string[];
  laneCalls: AgentTaskRequest[];
  closeRejects: boolean;
  /** The external-turn handler the actor wired into the live runtime. */
  externalEvents?: (event: ConversationBackendEvent) => void;
}

type CheckpointSeams = NonNullable<LifecycleFixtureOptions["checkpoint"]>;

async function createHarness(
  options: {
    generate?: typeof generateCheckpoint;
    conversation?: LifecycleFixtureOptions["conversation"];
    backendSupportsCheckpoint?: () => boolean;
    closeRejects?: boolean;
    scope?: "session" | "project";
    readEntries?: CheckpointSeams["readEntries"];
    readConversation?: CheckpointSeams["readConversation"];
    repo?: CheckpointSeams["repo"];
    queue?: LifecycleFixtureOptions["queue"];
  } = {},
): Promise<Harness> {
  const harness: Harness = {
    runtime: undefined as never,
    dispatches: [],
    laneCalls: [],
    closeRejects: options.closeRejects === true,
  };
  harness.runtime = createMockBackendRuntime({
    sendTurn: async (input) => {
      harness.dispatches.push(input.promptText);
      await input.onEvent({ type: "input_accepted" });
      await input.onEvent({ type: "backend_init", backendRef: LIVE_REF });
      return TURN_RESULT;
    },
    close: vi.fn(async () => {
      if (harness.closeRejects) throw new Error("provider teardown hung");
    }),
  });
  fixture = await createLifecycleFixture({
    ...(options.scope === "project"
      ? {
          address: {
            projectPath: "/lifecycle-fixture",
            target: {
              scope: "project",
              projectName: "lifecycle-fixture",
              conversationId: "c",
            },
          },
        }
      : {}),
    conversation: {
      transcriptPath: TRANSCRIPT,
      promptCount: 2,
      backendRef: LIVE_REF,
      ...options.conversation,
    },
    actorDeps: {
      // The actor re-resolves the transcript path at every turn; keep it on
      // the archive this suite seeds so a build after a turn reads history.
      getTranscriptPath: async () => TRANSCRIPT,
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        createRuntime: async (input) => {
          harness.externalEvents = input.onExternalTurnEvent;
          return harness.runtime;
        },
      }),
      getTaskRunner: () => cannedRunner(harness.laneCalls),
    },
    checkpoint: {
      ...(options.generate ? { generate: options.generate } : {}),
      ...(options.backendSupportsCheckpoint
        ? { backendSupportsCheckpoint: options.backendSupportsCheckpoint }
        : {}),
      ...(options.readEntries ? { readEntries: options.readEntries } : {}),
      ...(options.readConversation
        ? { readConversation: options.readConversation }
        : {}),
      ...(options.repo ? { repo: options.repo } : {}),
    },
    ...(options.queue ? { queue: options.queue } : {}),
  });
  fixture.transcripts.set(TRANSCRIPT, [...ENTRIES]);
  return harness;
}

function hosted() {
  if (!fixture) throw new Error("fixture missing");
  const identity = fixture.identity;
  return {
    key: conversationRuntimeKey(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    ),
    actor: fixture.actor(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    ),
    runtime: getConversationRuntime(
      conversationRuntimeKey(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      ),
    ),
  };
}

/** Run one ordinary turn so the host holds a live provider runtime and reference. */
async function runOrdinaryTurn(prompt = "first"): Promise<void> {
  if (!fixture) throw new Error("fixture missing");
  const admission = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: { promptText: prompt },
  });
  if (admission.kind !== "accepted") throw new Error(admission.message);
  const settled = await admission.turn.completed;
  expect(settled.outcome.kind).toBe("call_result");
}

async function readRow() {
  if (!fixture) throw new Error("fixture missing");
  const row = await fixture.persistence
    .recreateStore()
    .getConversation(
      fixture.identity.projectPath,
      fixture.identity.sessionName,
      fixture.identity.conversationId,
    );
  if (!row) throw new Error("row missing");
  return row;
}

async function start(requestId = randomUUID()) {
  if (!fixture) throw new Error("fixture missing");
  return fixture.manager.startConversationCheckpoint({
    address: fixture.binding.address,
    requestId,
  });
}

function admittedOr(result: Awaited<ReturnType<typeof start>>) {
  if (result.kind === "refused")
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.reason}`);
  return result;
}

function scopeKey() {
  if (!fixture) throw new Error("fixture missing");
  return checkpointScopeKeyForStoreIdentity(fixture.identity);
}

async function nudge(): Promise<void> {
  if (!fixture) throw new Error("fixture missing");
  await fixture.manager.ensureConversationActorAndDrain(
    fixture.identity.projectPath,
    fixture.identity.sessionName,
    fixture.identity.conversationId,
  );
}

async function claimCollaboration(): Promise<void> {
  if (!fixture) throw new Error("fixture missing");
  await fixture.persistence.store.mutateConversation(
    fixture.identity.projectPath,
    fixture.identity.sessionName,
    fixture.identity.conversationId,
    "test.collaboration_claim",
    (record) => {
      record.owner = {
        kind: "collaboration",
        workflowId: "wf",
        attemptEpoch: 0,
      };
    },
  );
}

describe("checkpoint admission through the manager", () => {
  it.each([
    ["archived", { archived: true }, "conversation_archived"],
    ["workflow-owned", { role: "iteration" as const }, "conversation_owned"],
    [
      "collaboration-owned",
      {
        owner: {
          kind: "collaboration" as const,
          workflowId: "wf",
          attemptEpoch: 0,
        },
      },
      "conversation_owned",
    ],
    [
      "debug",
      {
        debugMode: {
          active: true,
          recording: false,
          logFilePath: "/lifecycle-fixture/debug.log",
          enteredAt: "2026-01-01T00:00:00Z",
          hypotheses: [],
          reproductionSteps: [],
          fixSummary: null,
          verificationSteps: [],
          instructionsDelivered: false,
          phase: "hypothesizing" as const,
          lastTurnFailed: false,
          debugSessionId: "dbg",
          cleanupVerificationAttempt: 0,
        },
      },
      "debug_mode",
    ],
    ["question-parked", { pendingQuestionId: "q-1" }, "question_pending"],
    [
      "history-less",
      { promptCount: 0, transcriptPath: null },
      "no_recorded_history",
    ],
  ])(
    "refuses a %s conversation before any allocation or continuation change",
    async (_label, conversation, code) => {
      const harness = await createHarness({ conversation });
      const createRuntime = vi.fn();
      const result = await start();
      expect(result).toMatchObject({ kind: "refused", refusal: { code } });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(harness.laneCalls).toEqual([]);
      expect((await readRow()).backendRef).toEqual(LIVE_REF);
      expect(
        (
          await fixture!.checkpoints.listReceipts({
            scope: "session",
            projectPath: fixture!.identity.projectPath,
            sessionName: fixture!.identity.sessionName,
            conversationId: fixture!.identity.conversationId,
          })
        ).receipts,
      ).toEqual([]);
    },
  );

  it("refuses an uncertified backend by capability, not by name", async () => {
    await createHarness({ backendSupportsCheckpoint: () => false });
    expect(await start()).toMatchObject({
      kind: "refused",
      refusal: { code: "backend_unsupported" },
    });
  });

  it("refuses live background work and an active turn without cancelling either", async () => {
    const harness = await createHarness();
    fixture!.setBackgroundActivity(BACKGROUND);
    expect(await start()).toMatchObject({
      kind: "refused",
      refusal: { code: "background_work" },
    });
    fixture!.setBackgroundActivity(null);

    const holdTurn = deferred<ConversationBackendTurnResult>();
    harness.runtime = createMockBackendRuntime({
      sendTurn: async (input) => {
        await input.onEvent({ type: "input_accepted" });
        return holdTurn.promise;
      },
    });
    const admission = await fixture!.manager.submitConversationTurn({
      binding: fixture!.binding,
      turn: { promptText: "long" },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    expect(await start()).toMatchObject({
      kind: "refused",
      refusal: { code: "turn_active" },
    });
    holdTurn.resolve(TURN_RESULT);
    expect((await admission.turn.completed).outcome).toMatchObject({
      kind: "call_result",
    });
  });

  it("returns the existing operation for a repeated request id and refuses a different one", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    await createHarness({ generate: gate.generate });
    const requestId = randomUUID();
    const first = admittedOr(await start(requestId));
    expect(first.kind).toBe("admitted");
    await gate.started.promise;
    const repeat = admittedOr(await start(requestId));
    expect(repeat.kind).toBe("reused");
    expect(repeat.operation.id).toBe(first.operation.id);
    expect(await start(randomUUID())).toMatchObject({
      kind: "refused",
      refusal: {
        code: "checkpoint_pending",
        operationId: first.operation.id,
        phase: "building",
      },
    });
    gate.release();
    await first.completion;
  });

  it("checks eligibility read-only: no actor, no operation, no drain", async () => {
    await createHarness();
    const entry = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "queued while dormant" }],
    });
    const check = await fixture!.manager.checkConversationCheckpoint(
      fixture!.binding.address,
    );
    expect(check).toEqual({
      eligible: true,
      refusals: [],
      active: null,
      hosted: false,
    });
    expect(hosted().actor).toBeUndefined();
    expect((await readRow()).pendingQueue).toMatchObject([
      { id: entry.id, status: "pending" },
    ]);
    const blocked = await fixture!.manager.checkConversationCheckpoint(
      fixture!.binding.address,
      { recover: "op-missing" },
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.refusals.map((r) => r.code)).toEqual([
      "recovery_target_mismatch",
    ]);
  });
});

describe("checkpoint reservation races", () => {
  it("holds a dormant host's startup drain and delivers the queue only after the outcome is durable", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    const queued = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "queued before checkpoint" }],
    });
    const started = admittedOr(await start());
    await gate.started.promise;
    expect(hosted().actor).toBeDefined();
    expect(hosted().runtime?.maintenance?.operationId).toBe(
      started.operation.id,
    );
    expect(harness.dispatches).toEqual([]);
    expect((await readRow()).pendingQueue).toMatchObject([
      { id: queued.id, status: "pending" },
    ]);

    const late = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "queued during build" }],
    });
    expect(
      (await readRow()).pendingQueue.map((row) => [row.id, row.status]),
    ).toEqual([
      [queued.id, "pending"],
      [late.id, "pending"],
    ]);

    const cancelled = await fixture!.manager.cancelConversationCheckpoint({
      address: fixture!.binding.address,
      operationId: started.operation.id,
    });
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      operation: { phase: "cancelled" },
    });
    // Both rows drain as one coalesced batch, in enqueue order, with their
    // identities intact — nothing was consumed or reordered by the hold.
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual([
        "queued before checkpoint\nqueued during build",
      ]),
    );
    expect((await readRow()).pendingQueue).toEqual([]);
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("refuses or waits out a competing send, keeps the continuation, and admits after release", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;

    const refused = await fixture!.manager.submitConversationTurn({
      binding: fixture!.binding,
      turn: { promptText: "during build" },
    });
    expect(refused).toMatchObject({ kind: "refused", code: "busy" });

    const waiting = fixture!.manager.submitConversationTurn({
      binding: fixture!.binding,
      turn: { promptText: "after build" },
      waitUntilReady: true,
    });
    let waitingSettled = false;
    void waiting.then(() => {
      waitingSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waitingSettled).toBe(false);
    expect(harness.dispatches).toEqual(["first"]);

    gate.release();
    const operation = await started.completion;
    expect({ phase: operation.phase, failure: operation.failure }).toEqual({
      phase: "ready",
      failure: null,
    });
    const admission = await waiting;
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await admission.turn.completed;
    expect(harness.dispatches).toEqual(["first", seededPrompt("after build")]);
  });

  it("refuses rebind, stop and commands while maintenance owns the host", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;

    const rebind = await fixture!.manager.submitConversationTurn({
      binding: {
        ...fixture!.binding,
        worktreePath: "/lifecycle-fixture/elsewhere",
      },
      turn: { promptText: "rebound" },
    });
    expect(rebind).toMatchObject({ kind: "refused", code: "busy" });

    const stop = fixture!.manager.requestConversationStop(
      fixture!.binding.address,
      "user",
    );
    expect(stop.requested).toBe(false);
    expect(harness.runtime.close).not.toHaveBeenCalled();

    const command = await fixture!.manager.executeConversationCommand(
      fixture!.binding.address,
      {
        kind: "enter",
        logFilePath: "/lifecycle-fixture/debug.log",
        debugSessionId: "dbg-1",
      },
    );
    expect(command).toMatchObject({ kind: "refused", code: "busy" });

    gate.release();
    await stop.settled;
    expect(await started.completion).toMatchObject({ phase: "ready" });
  });
});

describe("checkpoint retirement", () => {
  it.each([
    ["session", "building"],
    ["project", "building"],
    ["session", "ready"],
    ["project", "ready"],
  ] as const)(
    "admits %s HTTP queue input at %s and drains only after readiness",
    async (scope, phase) => {
      const gate = gatedGenerator();
      releaseHeld = gate.release;
      const harness = await createHarness({ scope, generate: gate.generate });
      await runOrdinaryTurn();
      const started = admittedOr(await start());
      await gate.started.promise;
      if (phase === "ready") {
        gate.release();
        await started.completion;
      }
      const row = await readRow();
      expect(row.status).not.toBe("running");
      const response = await enqueueQueuedMessage(
        {
          admitCheckpointForkSelection: async ({ modelSelection }) =>
            modelSelection ?? { modelId: "claude-opus-5", parameters: {} },
          checkpointAcceptsQueuedInput:
            fixture!.manager.checkpointAcceptsQueuedInput,
          admitModelSelection: async ({ modelSelection }) => ({
            ok: true,
            modelSelection,
          }),
          getProjectDisplayName: () => fixture!.projectName,
          queueMessage: async (input) => {
            expect(input.deliveryPolicy).toBe("next_turn");
            return {
              entry: await fixture!.queue.enqueue({
                ...fixture!.identity,
                content: [{ type: "text", text: input.text! }],
              }),
              deliveryTiming: "next_turn",
            };
          },
          queueCapabilityForBackend: () => ({
            acceptsWhileRunning: true,
            deliveryTiming: "in_turn",
          }),
          toQueuedMessageView,
          clearConversationPendingPromptTextIfMatches: async () => false,
          ensureConversationActorAndDrain:
            fixture!.manager.ensureConversationActorAndDrain,
          resolveDelivery: fixture!.queue.resolveDelivery,
          cancel: fixture!.queue.cancel,
        },
        {
          projectPath: fixture!.identity.projectPath,
          scope:
            scope === "session"
              ? { scope, sessionName: fixture!.identity.sessionName }
              : { scope },
          conversationId: row.id,
          conversation: row,
        },
        { text: "queued through the HTTP policy" },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        queued: true,
        deliveryTiming: "next_turn",
      });
      if (phase === "building") {
        expect((await readRow()).pendingQueue).toMatchObject([
          { status: "pending" },
        ]);
        expect(harness.dispatches).toEqual(["first"]);
      }
      gate.release();
      await started.completion;
      await vi.waitFor(() =>
        expect(harness.dispatches).toEqual([
          "first",
          seededPrompt("queued through the HTTP policy"),
        ]),
      );
      expect((await readRow()).pendingQueue).toEqual([]);
    },
  );

  it("freezes, closes the runtime, clears the continuation atomically and drains the queue only after receipts", async () => {
    const harness = await createHarness();
    await runOrdinaryTurn();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    const beforePrompts = (await readRow()).promptCount;
    const queued = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "next ordinary turn" }],
    });

    const started = admittedOr(await start());
    expect(started.kind).toBe("admitted");
    expect(started.receipt).toMatchObject({
      phase: "building",
      mechanism: "cc_checkpoint",
      checkpoint: null,
    });
    const operation = await started.completion;
    expect(operation).toMatchObject({ phase: "ready" });
    expect(operation.payloadId).toBe(operation.id);
    expect(operation.protectedReferences.priorBackendRef).toBe(LIVE_REF.ref);
    expect(operation.usage.inputTokens).toBeGreaterThan(0);

    // The synthetic lane never touched the source conversation; the queued
    // message became the next ordinary turn only after readiness.
    expect(harness.laneCalls.length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual([
        "first",
        seededPrompt("next ordinary turn"),
      ]),
    );
    const row = await readRow();
    expect(row.promptCount).toBe(beforePrompts + 1);
    expect(row.pendingQueue.find((r) => r.id === queued.id)).toBeUndefined();
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);

    const key = {
      scope: fixture!.binding.address.target.scope,
      projectPath: fixture!.identity.projectPath,
      sessionName:
        fixture!.binding.address.target.scope === "session"
          ? fixture!.identity.sessionName
          : null,
      conversationId: fixture!.identity.conversationId,
    } as const;
    const payload = await fixture!.checkpoints.getPayload(key, operation.id);
    expect(payload?.seedText).toContain("vault path ops/deploy-2026");
    const receipt = await fixture!.checkpoints.getReceipt(key, operation.id);
    expect(JSON.stringify(receipt)).not.toContain(LIVE_REF.ref);
  });

  it("publishes ready only after the row and snapshot receipts are durable", async () => {
    const harness = await createHarness();
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    const operation = await started.completion;
    expect(operation.phase).toBe("ready");
    const row = await readRow();
    expect(row.backendRef).toBeNull();
    const snapshot = fixture!.persistence
      .recreateStore()
      .getConversationMachineSnapshot(
        "session",
        fixture!.identity.conversationId,
      ) as {
      context?: { backendRef?: unknown };
    } | null;
    expect(snapshot?.context?.backendRef).toBeNull();
    expect(hosted().actor?.getSnapshot().context.backendRef).toBeNull();
    expect(hosted().runtime?.managed.backend).toBeUndefined();
    expect(hosted().runtime?.maintenance).toBeUndefined();
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("fails a build whose archive changed and preserves the runtime and reference", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;
    fixture!.transcripts
      .get(TRANSCRIPT)!
      .push(text(4, "user", "one more thing"));
    gate.release();
    const operation = await started.completion;
    expect(operation).toMatchObject({
      phase: "failed",
      failure: { code: "source_changed" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    expect(hosted().runtime?.managed.backend).toBe(harness.runtime);
    expect(hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
    const next = await fixture!.manager.submitConversationTurn({
      binding: fixture!.binding,
      turn: { promptText: "after failure" },
    });
    expect(next.kind).toBe("accepted");
  });

  it("fails a build when background work appears late", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;
    fixture!.setBackgroundActivity(BACKGROUND);
    gate.release();
    const operation = await started.completion;
    expect(operation).toMatchObject({
      phase: "failed",
      failure: { code: "late_activity" },
    });
    expect(operation.failure?.message).toContain("background_work");
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("keeps a failed close owned: no readiness, no reference clear, no admission", async () => {
    const harness = await createHarness({ closeRejects: true });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    const operation = await started.completion;
    expect(operation).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
      failure: { code: "runtime_close_failed" },
    });
    expect(operation.payloadId).toBe(operation.id);
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    expect(hosted().runtime?.maintenance?.phase).toBe("needs_reconciliation");
    expect(hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: operation.id,
      phase: "needs_reconciliation",
    });
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);
    const next = await fixture!.manager.submitConversationTurn({
      binding: fixture!.binding,
      turn: { promptText: "blocked" },
    });
    expect(next).toMatchObject({ kind: "refused", code: "busy" });
    expect(harness.dispatches).toEqual(["first"]);
    expect(
      await fixture!.manager.cancelConversationCheckpoint({
        address: fixture!.binding.address,
        operationId: operation.id,
      }),
    ).toMatchObject({ kind: "refused", refusal: { code: "not_cancellable" } });
    // Cleanup: let the provider close so disposal can evict the host.
    harness.closeRejects = false;
    hosted().runtime?.managed.reconcileClose();
  });

  it("holds retirement when the required readiness receipts fail", async () => {
    await createHarness();
    await runOrdinaryTurn();
    const original =
      fixture!.persistence.store.upsertConversationMachineSnapshot;
    let failSnapshots = false;
    const { setPersistenceDeps } = await import("./persistence");
    setPersistenceDeps({
      getConversationMachineSnapshot:
        fixture!.persistence.store.getConversationMachineSnapshot,
      upsertConversationMachineSnapshot: (owner, conversationId, snapshot) => {
        // The readiness projection is the first snapshot with cleared continuity.
        const cleared =
          (snapshot as { context?: { backendRef?: unknown } }).context
            ?.backendRef === null;
        if (failSnapshots && cleared)
          throw new Error("snapshot disk unavailable");
        return original(owner, conversationId, snapshot);
      },
      deleteConversationMachineSnapshot:
        fixture!.persistence.store.deleteConversationMachineSnapshot,
    });
    const started = admittedOr(await start());
    failSnapshots = true;
    const operation = await started.completion;
    failSnapshots = false;
    expect(operation).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
      failure: { code: "readiness_receipts_failed" },
    });
    expect(hosted().runtime?.durabilityFailure).toBeDefined();
    expect(hosted().runtime?.maintenance?.phase).toBe("needs_reconciliation");
    // The actor row is cleared, but failed snapshot durability keeps retirement held.
    expect((await readRow()).backendRef).toBeNull();
    const next = await fixture!.manager.submitConversationTurn({
      binding: fixture!.binding,
      turn: { promptText: "blocked" },
    });
    expect(next).toMatchObject({ kind: "refused", code: "busy" });
    const repaired = await fixture!.manager.reconcileConversationCheckpoint({
      address: fixture!.binding.address,
      operationId: operation.id,
    });
    expect(repaired).toMatchObject({
      kind: "repaired",
      operation: { phase: "ready" },
    });
  });

  it("cancels a build, keeps everything, and finishes forward once frozen", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;
    const cancelled = await fixture!.manager.cancelConversationCheckpoint({
      address: fixture!.binding.address,
      operationId: started.operation.id,
    });
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      operation: { phase: "cancelled", failure: { code: "cancelled" } },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);

    // A fresh operation after cancellation runs to readiness; once frozen it
    // can no longer be cancelled.
    gate.release();
    const second = admittedOr(await start());
    const done = await second.completion;
    expect(done.phase).toBe("ready");
    expect(
      await fixture!.manager.cancelConversationCheckpoint({
        address: fixture!.binding.address,
        operationId: second.operation.id,
      }),
    ).toMatchObject({
      kind: "refused",
      refusal: { code: "not_cancellable", phase: "ready" },
    });
  });

  it("is not a turn: no prompt count, no source transcript entry, no queued consumption, synthetic lane only", async () => {
    const appended: string[] = [];
    const harness = await createHarness();
    await runOrdinaryTurn();
    const before = await readRow();
    const queued = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "held" }],
    });
    const originalRunner = harness.laneCalls;
    const started = admittedOr(await start());
    // Observe queue and prompt count while the build runs on the lane.
    const operation = await started.completion;
    expect(operation.phase).toBe("ready");
    expect(originalRunner.every((call) => call.prompt.length > 0)).toBe(true);
    expect(appended).toEqual([]);
    // The queued message became the NEXT ordinary turn, delivered after readiness.
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual(["first", seededPrompt("held")]),
    );
    const after = await readRow();
    expect(after.promptCount).toBe(before.promptCount + 1);
    expect(after.pendingQueue.find((r) => r.id === queued.id)).toBeUndefined();
  });

  it("retires a project-scoped conversation through the project row", async () => {
    const harness = await createHarness({ scope: "project" });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    const operation = await started.completion;
    expect(operation.phase).toBe("ready");
    expect(operation.scope).toBe("project");
    expect((await readRow()).backendRef).toBeNull();
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);
  });
});

describe("checkpoint reservation coherence", () => {
  it("reports checkpoint_pending from check and a competing start while a dormant host is being reserved", async () => {
    const gate = deferred();
    let reads = 0;
    await createHarness({
      readConversation: async (identity, read) => {
        if (reads++ === 0) await gate.promise;
        return read(identity);
      },
    });
    const first = start();
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(hosted().actor).toBeUndefined();

    const check = await fixture!.manager.checkConversationCheckpoint(
      fixture!.binding.address,
    );
    expect(check.eligible).toBe(false);
    expect(check.refusals[0]).toMatchObject({
      code: "checkpoint_pending",
      operationId: null,
    });
    expect(await start(randomUUID())).toMatchObject({
      kind: "refused",
      refusal: { code: "checkpoint_pending" },
    });

    gate.resolve();
    const admitted = admittedOr(await first);
    expect(admitted.kind).toBe("admitted");
    expect(await admitted.completion).toMatchObject({ phase: "ready" });
  });

  /**
   * Gate exactly one claim: the one the next nudge makes. Idle-entry drains
   * claim too (against an empty queue), so counting claims is not enough.
   */
  function gatedClaim() {
    const gate = deferred();
    let armed = false;
    let held = 0;
    return {
      arm: () => {
        armed = true;
      },
      release: () => gate.resolve(),
      heldCount: () => held,
      claimNextTurnBatch: async (
        input: Parameters<
          NonNullable<typeof fixture>["queue"]["claimNextTurnBatch"]
        >[0],
      ) => {
        if (armed) {
          armed = false;
          held += 1;
          await gate.promise;
        }
        return fixture!.queue.claimNextTurnBatch(input);
      },
    };
  }

  it("lets a drain that claimed before the reservation finish, then refuses the checkpoint as turn_active", async () => {
    const claim = gatedClaim();
    const harness = await createHarness({
      queue: { claimNextTurnBatch: claim.claimNextTurnBatch },
    });
    await runOrdinaryTurn();
    await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "claimed first" }],
    });
    claim.arm();
    await nudge();
    expect(claim.heldCount()).toBe(1);

    const starting = start();
    let startSettled = false;
    void starting.then(() => {
      startSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startSettled).toBe(false);

    claim.release();
    expect(await starting).toMatchObject({
      kind: "refused",
      refusal: { code: "turn_active" },
    });
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual(["first", "claimed first"]),
    );
    expect((await readRow()).pendingQueue).toEqual([]);
    expect(
      (await fixture!.checkpoints.listReceipts(scopeKey())).receipts,
    ).toEqual([]);
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("runs a queued command claimed before the reservation to completion before the checkpoint is admitted", async () => {
    const claim = gatedClaim();
    let receiptsWhenCommandRan: number | null = null;
    const harness = await createHarness({
      queue: {
        claimNextTurnBatch: claim.claimNextTurnBatch,
        runConversationCommand: async () => {
          receiptsWhenCommandRan = (
            await fixture!.checkpoints.listReceipts(scopeKey())
          ).receipts.length;
          return { status: "dispatched", jobId: "job-1", usedFallback: false };
        },
      },
    });
    await runOrdinaryTurn();
    await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "/commit" }],
    });
    claim.arm();
    await nudge();
    expect(claim.heldCount()).toBe(1);

    const starting = start();
    let startSettled = false;
    void starting.then(() => {
      startSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startSettled).toBe(false);
    claim.release();
    const started = admittedOr(await starting);
    expect(receiptsWhenCommandRan).toBe(0);
    expect((await readRow()).pendingQueue).toEqual([]);
    expect(await started.completion).toMatchObject({ phase: "ready" });
    expect(harness.dispatches).toEqual(["first"]);
  });

  it("re-drains a nudge suppressed during a reservation that ends in refusal", async () => {
    const captureGate = deferred();
    let reads = 0;
    const harness = await createHarness({
      readEntries: async (path, read) => {
        if (reads++ === 0) await captureGate.promise;
        return read(path);
      },
    });
    const starting = start();
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(hosted().actor).toBeDefined();

    await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "queued during reservation" }],
    });
    await nudge();
    expect(harness.dispatches).toEqual([]);

    fixture!.setBackgroundActivity(BACKGROUND);
    captureGate.resolve();
    expect(await starting).toMatchObject({
      kind: "refused",
      refusal: { code: "background_work" },
    });
    fixture!.setBackgroundActivity(null);
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual(["queued during reservation"]),
    );
    expect(
      (await fixture!.checkpoints.listReceipts(scopeKey())).receipts,
    ).toEqual([]);
  });
});

describe("checkpoint freeze fence", () => {
  /** A build held at its pre-freeze recapture, after the host was observed. */
  async function heldAtRecapture() {
    const recaptureGate = deferred();
    let reads = 0;
    const harness = await createHarness({
      readEntries: async (path, read) => {
        if (++reads === 2) await recaptureGate.promise;
        return read(path);
      },
    });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await vi.waitFor(() => expect(reads).toBe(2));
    return { harness, started, release: () => recaptureGate.resolve() };
  }

  it("honours a cancel that lands during the pre-freeze settle", async () => {
    const { harness, started, release } = await heldAtRecapture();
    const cancelling = fixture!.manager.cancelConversationCheckpoint({
      address: fixture!.binding.address,
      operationId: started.operation.id,
    });
    release();
    expect(await cancelling).toMatchObject({
      kind: "cancelled",
      operation: { phase: "cancelled", failure: { code: "cancelled" } },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("refuses the freeze when an external turn starts after the host was observed", async () => {
    const { harness, started, release } = await heldAtRecapture();
    harness.externalEvents!({ type: "external_turn_started" });
    release();
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "late_activity" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    harness.externalEvents!({
      type: "external_turn_completed",
      result: TURN_RESULT,
    });
  });

  it("refuses the freeze when background work appears after the host was observed", async () => {
    const { harness, started, release } = await heldAtRecapture();
    fixture!.setBackgroundActivity(BACKGROUND);
    release();
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "late_activity" },
    });
    fixture!.setBackgroundActivity(null);
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("fails a build whose conversation a collaboration claimed during generation", async () => {
    const { harness, started, release } = await heldAtRecapture();
    await claimCollaboration();
    release();
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "conversation_owned" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("fails a build when an external turn starts during generation without emitting frames", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;
    harness.externalEvents!({ type: "external_turn_started" });
    gate.release();
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "late_activity" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    harness.externalEvents!({
      type: "external_turn_completed",
      result: TURN_RESULT,
    });
  });
});

describe("checkpoint build failures", () => {
  it("records a thrown generation as a durable failed build and releases the queue", async () => {
    const harness = await createHarness({
      generate: async () => {
        throw new Error("lane exploded");
      },
    });
    await runOrdinaryTurn();
    await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "after failure" }],
    });
    const started = admittedOr(await start());
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "build_error" },
    });
    expect(
      (
        await fixture!.checkpoints.getOperation(
          scopeKey(),
          started.operation.id,
        )
      )?.phase,
    ).toBe("failed");
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual(["first", "after failure"]),
    );
  });

  it("records a thrown recapture as a durable failed build", async () => {
    let reads = 0;
    const harness = await createHarness({
      readEntries: async (path, read) => {
        if (++reads === 2) throw new Error("archive unreadable");
        return read(path);
      },
    });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "build_error" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });
});

describe("undurable checkpoint outcomes", () => {
  it("keeps the host owned when the outcome write fails: cancel reports recovery, stop is refused, nothing closes", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    let failWrites = false;
    const harness = await createHarness({
      generate: gate.generate,
      repo: (repo) => ({
        ...repo,
        recordOutcome: async (input) => {
          if (failWrites) throw new Error("disk full");
          return repo.recordOutcome(input);
        },
      }),
    });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;

    failWrites = true;
    const cancelled = await fixture!.manager.cancelConversationCheckpoint({
      address: fixture!.binding.address,
      operationId: started.operation.id,
    });
    expect(cancelled).toMatchObject({
      kind: "refused",
      refusal: {
        code: "recovery_required",
        operationId: started.operation.id,
        phase: "building",
      },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();

    const stop = fixture!.manager.requestConversationStop(
      fixture!.binding.address,
      "user",
    );
    expect(stop.requested).toBe(false);
    await stop.settled;
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    expect(
      (
        await fixture!.checkpoints.getOperation(
          scopeKey(),
          started.operation.id,
        )
      )?.phase,
    ).toBe("building");
    expect(await start(randomUUID())).toMatchObject({
      kind: "refused",
      refusal: { code: "checkpoint_pending" },
    });
    expect(
      await fixture!.manager.submitConversationTurn({
        binding: fixture!.binding,
        turn: { promptText: "held" },
      }),
    ).toMatchObject({ kind: "refused", code: "busy" });
    failWrites = false;
  });
});

describe("overlapping queue drains", () => {
  it("waits for an earlier drain still dispatching a command when a later nudge found nothing to claim", async () => {
    const commandGate = deferred();
    const commandEntered = deferred();
    let receiptsWhenCommandRan: number | null = null;
    const harness = await createHarness({
      queue: {
        runConversationCommand: async () => {
          commandEntered.resolve();
          await commandGate.promise;
          receiptsWhenCommandRan = (
            await fixture!.checkpoints.listReceipts(scopeKey())
          ).receipts.length;
          return { status: "dispatched", jobId: "job-1", usedFallback: false };
        },
      },
    });
    await runOrdinaryTurn();
    await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "/commit" }],
    });
    await nudge();
    await commandEntered.promise;
    // The batch is delivering, so this drain claims nothing and finishes at
    // once; the first drain is still dispatching.
    await nudge();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const starting = start();
    let startSettled = false;
    void starting.then(() => {
      startSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startSettled).toBe(false);

    commandGate.resolve();
    const started = admittedOr(await starting);
    expect(receiptsWhenCommandRan).toBe(0);
    expect((await readRow()).pendingQueue).toEqual([]);
    expect(await started.completion).toMatchObject({ phase: "ready" });
    expect(harness.dispatches).toEqual(["first"]);
  });
});

describe("freeze fence evidence", () => {
  it("fails a build when background work appeared and cleared during generation", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;
    fixture!.setBackgroundActivity(BACKGROUND);
    fixture!.setBackgroundActivity(null);
    gate.release();
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "late_activity" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });

  it("fences a collaboration claim that lands after every asynchronous recheck, inside the freeze", async () => {
    const harness = await createHarness({
      repo: (repo) => ({
        ...repo,
        freezePayload: async (input) => {
          await claimCollaboration();
          return repo.freezePayload(input);
        },
      }),
    });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "conversation_owned" },
    });
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
  });
});

describe("external turn ownership after a yielded build", () => {
  it("keeps ordinary admission held after a build yields to an external turn, until that turn settles", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    const harness = await createHarness({ generate: gate.generate });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    await gate.started.promise;
    harness.externalEvents!({ type: "external_turn_started" });
    gate.release();
    expect(await started.completion).toMatchObject({
      phase: "failed",
      failure: { code: "late_activity" },
    });
    await vi.waitFor(() =>
      expect(hosted().actor?.getSnapshot().value).toBe("externalExecuting"),
    );
    expect(hosted().actor?.getSnapshot().context.checkpoint).toBeNull();

    const queued = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "after external" }],
    });
    await nudge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.dispatches).toEqual(["first"]);
    expect((await readRow()).pendingQueue).toMatchObject([
      { id: queued.id, status: "pending" },
    ]);
    expect(
      await fixture!.manager.submitConversationTurn({
        binding: fixture!.binding,
        turn: { promptText: "direct" },
      }),
    ).toMatchObject({ kind: "refused", code: "busy" });

    harness.externalEvents!({
      type: "external_turn_completed",
      result: TURN_RESULT,
    });
    await vi.waitFor(() =>
      expect(harness.dispatches).toEqual(["first", "after external"]),
    );
    expect(harness.runtime.close).not.toHaveBeenCalled();
  });
});

describe("disposal under a held checkpoint", () => {
  function dispose() {
    return fixture!.manager.stopConversationActor(
      fixture!.identity.projectPath,
      fixture!.identity.sessionName,
      fixture!.identity.conversationId,
      "shutdown",
    );
  }

  it("refuses to evict a host whose outcome never became durable: nothing closes and the hold stays", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    let failWrites = false;
    const harness = await createHarness({
      generate: gate.generate,
      repo: (repo) => ({
        ...repo,
        recordOutcome: async (input) => {
          if (failWrites) throw new Error("disk full");
          return repo.recordOutcome(input);
        },
      }),
    });
    await runOrdinaryTurn();
    const queued = await fixture!.queue.enqueue({
      ...fixture!.identity,
      content: [{ type: "text", text: "queued under hold" }],
    });
    const started = admittedOr(await start());
    await gate.started.promise;
    failWrites = true;
    await fixture!.manager.cancelConversationCheckpoint({
      address: fixture!.binding.address,
      operationId: started.operation.id,
    });
    expect(hosted().runtime?.maintenance?.outcome).toBe("undurable");

    // Eviction is not settlement: the runtime the build would have retired
    // stays owned, unclosed and referenced until the reconcile owner records
    // a durable outcome.
    await expect(dispose()).rejects.toThrow(/checkpoint/);
    expect(hosted().actor).toBeDefined();
    expect(hosted().runtime?.maintenance?.outcome).toBe("undurable");
    expect(hosted().runtime?.managed.backend).toBe(harness.runtime);
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(
      (
        await fixture!.checkpoints.getOperation(
          scopeKey(),
          started.operation.id,
        )
      )?.phase,
    ).toBe("building");
    const row = await readRow();
    expect(row.backendRef).toEqual(LIVE_REF);
    expect(row.pendingQueue).toMatchObject([
      { id: queued.id, status: "pending" },
    ]);
    expect(harness.dispatches).toEqual(["first"]);
    expect(
      await fixture!.manager.submitConversationTurn({
        binding: fixture!.binding,
        turn: { promptText: "held" },
      }),
    ).toMatchObject({ kind: "refused", code: "busy" });
    const check = await fixture!.manager.checkConversationCheckpoint(
      fixture!.binding.address,
    );
    expect(check.refusals).toContainEqual(
      expect.objectContaining({
        code: "checkpoint_pending",
        operationId: started.operation.id,
        phase: "building",
      }),
    );
    failWrites = false;
  });

  it("refuses to evict a host held after a failed close and keeps the runtime it could not close", async () => {
    const harness = await createHarness({ closeRejects: true });
    await runOrdinaryTurn();
    const started = admittedOr(await start());
    expect(await started.completion).toMatchObject({
      phase: "needs_reconciliation",
    });

    await expect(dispose()).rejects.toThrow(/checkpoint/);
    expect(hosted().actor).toBeDefined();
    expect(hosted().runtime?.managed.backend).toBe(harness.runtime);
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);
    expect(
      (
        await fixture!.checkpoints.getOperation(
          scopeKey(),
          started.operation.id,
        )
      )?.phase,
    ).toBe("needs_reconciliation");
    expect((await readRow()).backendRef).toEqual(LIVE_REF);
    expect(
      await fixture!.manager.submitConversationTurn({
        binding: fixture!.binding,
        turn: { promptText: "held" },
      }),
    ).toMatchObject({ kind: "refused", code: "busy" });
    harness.closeRejects = false;
  });
});

describe.each(["session", "project"] as const)(
  "%s readiness visibility",
  (scope) => {
    it.each(["start", "reconcile"] as const)(
      "keeps GET and SSE unready while %s snapshot persistence is pending",
      async (mode) => {
        const phases: string[] = [];
        const harness = await createHarness({
          scope,
          closeRejects: mode === "reconcile",
          repo: (repo) =>
            withCheckpointPublication(repo, {
              projectName: () => "lifecycle-fixture",
              publish: (event) => {
                if (event.type === "conversation-checkpoint-updated")
                  phases.push(event.receipt.phase);
                return { delivered: true };
              },
            }),
        });
        await runOrdinaryTurn();
        const interrupted =
          mode === "reconcile" ? admittedOr(await start()) : null;
        await interrupted?.completion;
        harness.closeRejects = false;
        const entered = deferred();
        const gate = deferred();
        let hold = true;
        releaseHeld = () => {
          hold = false;
          gate.resolve();
        };
        const store = fixture!.persistence.store;
        const { setPersistenceDeps } = await import("./persistence");
        setPersistenceDeps({
          getConversationMachineSnapshot: store.getConversationMachineSnapshot,
          deleteConversationMachineSnapshot:
            store.deleteConversationMachineSnapshot,
          async upsertConversationMachineSnapshot(
            owner,
            conversationId,
            snapshot,
          ) {
            if (
              hold &&
              (snapshot as { context?: { backendRef?: unknown } }).context
                ?.backendRef === null
            ) {
              entered.resolve();
              await gate.promise;
            }
            return store.upsertConversationMachineSnapshot(
              owner,
              conversationId,
              snapshot,
            );
          },
        });
        const started = interrupted ?? admittedOr(await start());
        const completed =
          mode === "start"
            ? started.completion
            : fixture!.manager.reconcileConversationCheckpoint({
                address: fixture!.binding.address,
                operationId: started.operation.id,
              });
        await entered.promise;
        const key = checkpointScopeKeyForStoreIdentity(fixture!.identity);
        const pending = await fixture!.checkpoints.getReceipt(
          key,
          started.operation.id,
        );
        expect(pending?.phase).toBe(
          mode === "start" ? "retiring" : "needs_reconciliation",
        );
        expect(phases).not.toContain("ready");
        releaseHeld();
        await completed;
        expect(
          (await fixture!.checkpoints.getReceipt(key, started.operation.id))
            ?.phase,
        ).toBe("ready");
        expect(phases.filter((phase) => phase === "ready")).toHaveLength(1);
      },
    );
  },
);
