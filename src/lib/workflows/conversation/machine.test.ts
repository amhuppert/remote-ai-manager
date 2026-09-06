import { describe, it, expect, vi, afterEach } from "vitest";
import { createActor, fromPromise, type AnyActorRef } from "xstate";
import { conversationMachine } from "./machine";
import { runDebugCleanupVerification } from "@/lib/workflows/debug/cleanup-verification";
import type {
  ConversationContext,
  ConversationInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
  VerifyCleanupOutput,
} from "./types";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

// ============================================================
// Helpers
// ============================================================

const activeActors: AnyActorRef[] = [];

afterEach(() => {
  for (const a of activeActors) {
    try {
      a.stop();
    } catch {
      /* already stopped */
    }
  }
  activeActors.length = 0;
});

const defaultInput: ConversationInput = {
  projectPath: "/repo",
  projectName: "my-project",
  sessionName: "sess-1",
  worktreePath: "/repo/.worktrees/sess-1",
  conversationId: "conv-123",
  createdAt: "2024-01-01T00:00:00Z",
  forkedFrom: null,
  role: null,
  transcriptPath: null,
  agentBackend: "claude" as const,
  backendRef: null,
  promptCount: 0,
  persistence: "durable" as const,
};

function successResult(
  overrides: Partial<PromptActorResult> = {},
): PromptActorResult {
  return {
    backendRef: null,
    costUsd: 0.01,
    durationMs: 500,
    numTurns: 1,
    contextTokens: 1000,
    contextWindow: 200000,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    contentBlocks: [{ type: "text", text: "Hello" }],
    aborted: false,
    compacted: false,
    error: null,
    continuationDisposition: "retain",
    // Non-null sentinel so the debug phase-advancement gate passes by
    // default. Tests that exercise the failure path override this with
    // `structuredOutput: undefined` (or set `error`).
    structuredOutput: {},
    ...overrides,
  };
}

function makeMockPrepareTurn(result?: Partial<PrepareTurnOutput>) {
  return fromPromise<PrepareTurnOutput, PrepareTurnInput>(async () => {
    await new Promise((r) => setTimeout(r, 0));
    return {
      transcriptPath: "/tmp/transcript.jsonl",
      ...result,
    };
  });
}

function makeMockExecutePrompt(result?: Partial<PromptActorResult>) {
  return fromPromise<PromptActorResult, ExecutePromptInput>(async () => {
    await new Promise((r) => setTimeout(r, 0));
    return successResult(result);
  });
}

/** executePrompt mock returning one queued result per call (the last result
 *  repeats once the sequence is exhausted). */
function makeSequencedExecutePrompt(
  results: Array<Partial<PromptActorResult>>,
) {
  let callCount = 0;
  return fromPromise<PromptActorResult, ExecutePromptInput>(async () => {
    const result = results[Math.min(callCount, results.length - 1)] ?? {};
    callCount += 1;
    await new Promise((r) => setTimeout(r, 0));
    return successResult(result);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeTestMachine(overrides?: {
  prepareTurn?: any;
  executePrompt?: any;
  runTaskRun?: any;
  verifyCleanup?: () => Promise<VerifyCleanupOutput>;
  drainPendingQueue?: () => void;
  persistSnapshot?: (args: { context: ConversationContext }) => void;
  syncDerivedFields?: (args: { context: ConversationContext }) => void;
}) {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const fakeVerifyCleanup =
    overrides?.verifyCleanup ??
    (async (): Promise<VerifyCleanupOutput> => ({
      ok: true,
      failedConditions: [],
      missingFiles: [],
      remediationPrompt: null,
    }));
  return conversationMachine.provide({
    actors: {
      prepareTurn: overrides?.prepareTurn ?? makeMockPrepareTurn(),
      executePrompt: overrides?.executePrompt ?? makeMockExecutePrompt(),
      ...(overrides?.runTaskRun ? { runTaskRun: overrides.runTaskRun } : {}),
    },
    actions: {
      persistSnapshot: overrides?.persistSnapshot ?? (() => {}),
      syncDerivedFields: overrides?.syncDerivedFields ?? (() => {}),
      broadcastConversationStatus: () => {},
      broadcastAskQuestion: () => {},
      broadcastDebugModeStatus: () => {},
      releaseResources: () => {},
      dispatchPushNotification: () => {},
      // Production wiring (real runner + reducer) with a fake verifier.
      startDebugCleanupVerification: ({ context, self }) => {
        void runDebugCleanupVerification(
          {
            worktreePath: context.worktreePath,
            conversationId: context.conversationId,
            structuredOutput: context.lastResult?.structuredOutput,
            debugSessionId:
              context.debugMode?.debugSessionId ?? "debug-session-test",
            attempt: context.debugMode?.cleanupVerificationAttempt ?? 0,
          },
          { verifyCleanup: fakeVerifyCleanup },
        ).then((command) => {
          if (!command) return;
          self.send({ type: "DEBUG_COMMAND", command });
        });
      },
      ...(overrides?.drainPendingQueue
        ? { drainPendingQueue: overrides.drainPendingQueue }
        : {}),
    },
  });
}

function waitForState(
  actor: AnyActorRef,
  stateName: string,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for state "${stateName}", current: ${JSON.stringify(actor.getSnapshot().value)}`,
          ),
        ),
      timeoutMs,
    );

    const check = (value: unknown) => {
      const flat = typeof value === "string" ? value : JSON.stringify(value);
      return flat.includes(stateName);
    };

    if (check(actor.getSnapshot().value)) {
      clearTimeout(timer);
      resolve();
      return;
    }

    const sub = actor.subscribe((s) => {
      if (check(s.value)) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

// ============================================================
// Tests
// ============================================================

describe("conversationMachine", () => {
  describe("initial state", () => {
    it("starts in idle with correct context", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.conversationId).toBe("conv-123");
      expect(snap.context.status).toBe("new");
      expect(snap.context.promptCount).toBe(0);
      expect(snap.context.activeTurn).toBeNull();
      expect(snap.context.debugMode).toBeNull();
    });
  });

  describe("prompt lifecycle", () => {
    it("transitions idle → acquiringResources → executing → finalizingTurn → idle", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "stream-1",
      });

      await waitForState(actor, "idle");

      // After full cycle, should be back at idle with updated status
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.status).toBe("awaiting");
      expect(snap.context.promptCount).toBe(1);
      expect(snap.context.activeTurn).toBeNull();
      expect(snap.context.lastResult).toBeTruthy();
      expect(snap.context.lastResult?.backendRef).toBeNull();
    });

    it("stores transcriptPath from prepareTurn", async () => {
      const machine = makeTestMachine({
        prepareTurn: makeMockPrepareTurn({
          transcriptPath: "/custom/path.jsonl",
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "stream-1",
      });

      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.transcriptPath).toBe(
        "/custom/path.jsonl",
      );
    });

    it("accumulates totals across multiple prompts", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          costUsd: 0.05,
          durationMs: 1000,
          numTurns: 2,
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // First prompt
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "First",
        streamId: "s1",
      });
      await waitForState(actor, "idle");

      // Second prompt
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Second",
        streamId: "s2",
      });
      await waitForState(actor, "idle");

      const totals = actor.getSnapshot().context.totals;
      expect(totals.totalCostUsd).toBe(0.1);
      expect(totals.totalDurationMs).toBe(2000);
      expect(totals.totalTurns).toBe(4);
      expect(actor.getSnapshot().context.promptCount).toBe(2);
    });
  });

  describe("external turn lifecycle", () => {
    it("settles to idle and re-accepts SUBMIT_PROMPT after EXTERNAL_TURN_COMPLETED carries an error", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // A stray between-turns message drove the machine into externalExecuting
      // and persisted status 'running'.
      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      expect(actor.getSnapshot().value).toBe("externalExecuting");
      expect(actor.getSnapshot().context.status).toBe("running");

      // The SDK subprocess died mid virtual turn; the rejected turn is delivered
      // as a completion carrying the error.
      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: successResult({
          error: "QuerySession ended before the turn completed",
          structuredOutput: undefined,
        }),
      });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.status).toBe("awaiting");
      expect(snap.context.activeTurn).toBeNull();
      expect(
        snap.can({
          type: "SUBMIT_PROMPT",
          promptText: "next prompt",
          streamId: "s2",
        }),
      ).toBe(true);
    });
  });

  describe("error handling", () => {
    it("handles prepareTurn failure", async () => {
      const machine = makeTestMachine({
        prepareTurn: fromPromise(async () => {
          throw new Error("lock unavailable");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.context.lastError).toContain("lock unavailable");
      expect(snap.context.activeTurn).toBeNull();
    });

    it("handles executePrompt failure", async () => {
      const machine = makeTestMachine({
        executePrompt: fromPromise(async () => {
          throw new Error("SDK error");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.context.lastError).toContain("SDK error");
    });

    it("clears Codex backendRef when prompt returns with error", async () => {
      // Equivalence pin: the codex adapter reports a failed turn with a
      // "clear" disposition (its threadId is unrecoverable when `codex exec`
      // exits non-zero) and the machine must drop the persisted ref.
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "Codex Exec exited with code 1: Reading prompt from stdin...",
          backendRef: null,
          continuationDisposition: "clear",
        }),
      });

      // Start with an existing Codex backendRef (simulating BACKEND_INIT
      // from a prior turn or mid-turn event that persisted a threadId)
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "codex" as const,
          backendRef: {
            backend: "codex" as const,
            ref: "thread-dead",
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      // backendRef should be cleared so the next prompt starts a fresh thread
      expect(snap.context.backendRef).toBeNull();
    });

    it("preserves Claude backendRef when prompt returns with error and no fresher sessionId", async () => {
      // Equivalence pin: the claude adapter reports failed turns with a
      // "retain" disposition (session IDs are server-side at Anthropic and
      // survive a transient QuerySession failure).
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "QuerySession closed while turn was in progress",
          backendRef: null,
          continuationDisposition: "retain",
        }),
      });

      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "claude" as const,
          backendRef: {
            backend: "claude" as const,
            ref: "sess-abc-123",
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      // Keep the prior sessionId so the next turn can attempt `resume:` —
      // wiping it would force a brand-new SDK session with no memory of the
      // earlier turns even though the transcript is intact.
      expect(snap.context.backendRef).toEqual({
        backend: "claude",
        ref: "sess-abc-123",
      });
    });

    it("clears the ref on a 'clear' disposition regardless of backend identity", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "runtime reported the continuation unusable",
          backendRef: null,
          continuationDisposition: "clear",
        }),
      });

      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "claude" as const,
          backendRef: {
            backend: "claude" as const,
            ref: "sess-abc-123",
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.backendRef).toBeNull();
    });

    it("retains the prior ref on a 'retain' disposition even when a codex turn errored", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "schema validation failed after a completed turn",
          backendRef: null,
          continuationDisposition: "retain",
        }),
      });

      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "codex" as const,
          backendRef: {
            backend: "codex" as const,
            ref: "thread-live",
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.backendRef).toEqual({
        backend: "codex",
        ref: "thread-live",
      });
    });

    it("clears the prior ref when PROMPT_COMPLETED carries a 'clear' disposition", async () => {
      // Direct completion event (manager-sent) must route through the same
      // disposition resolver as the invoke onDone path.
      const machine = makeTestMachine({
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          () => new Promise(() => {}),
        ),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "codex" as const,
          backendRef: { backend: "codex" as const, ref: "thread-stale" },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "conversationTurn");

      actor.send({
        type: "PROMPT_COMPLETED",
        result: successResult({
          error: "resume failed",
          backendRef: null,
          continuationDisposition: "clear",
        }),
      });
      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.backendRef).toBeNull();
    });

    it("clears the prior ref when EXTERNAL_TURN_COMPLETED carries a 'clear' disposition", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "codex" as const,
          backendRef: { backend: "codex" as const, ref: "thread-stale" },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      await waitForState(actor, "externalExecuting");

      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: successResult({
          error: "external turn invalidated the continuation",
          backendRef: null,
          continuationDisposition: "clear",
        }),
      });
      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.backendRef).toBeNull();
    });

    it("task-run completion follows the result's disposition, not the conversation backend", async () => {
      const runTaskRun = fromPromise<PromptActorResult, unknown>(async () =>
        successResult({
          error: "task run failed",
          backendRef: null,
          structuredOutput: undefined,
          continuationDisposition: "clear",
        }),
      );
      const machine = makeTestMachine({ runTaskRun });

      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "claude" as const,
          backendRef: {
            backend: "claude" as const,
            ref: "sess-abc-123",
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        executionClass: "nongoverned-task" as const,
        type: "SUBMIT_TASK_RUN",
        promptText: "run task",
        backend: "codex",
      });

      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.backendRef).toBeNull();
    });

    it("adopts fresher Claude sessionId from a failed turn over the prior one", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "QuerySession ended before the turn completed",
          backendRef: { backend: "claude", ref: "sess-xyz-789" },
        }),
      });

      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          agentBackend: "claude" as const,
          backendRef: {
            backend: "claude" as const,
            ref: "sess-abc-123",
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.backendRef).toEqual({
        backend: "claude",
        ref: "sess-xyz-789",
      });
    });
  });

  describe("BACKEND_INIT durability", () => {
    // The SDK announces its session id in the init message seconds into the
    // turn, but the turn may run for many minutes. If the server dies mid-turn
    // before the ref is durable, the next turn cannot `resume:` and the agent
    // silently loses all prior context — so BACKEND_INIT must persist
    // immediately, not wait for turn completion.
    it("persists backendRef durably the moment BACKEND_INIT arrives mid-turn", async () => {
      const spies = {
        persistSnapshot: vi.fn(),
        syncDerivedFields: vi.fn(),
      };
      let resolveTurn: ((result: PromptActorResult) => void) | null = null;
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
            () =>
              new Promise<PromptActorResult>((resolve) => {
                resolveTurn = resolve;
              }),
          ),
        },
        actions: {
          persistSnapshot: spies.persistSnapshot,
          syncDerivedFields: spies.syncDerivedFields,
          broadcastConversationStatus: () => {},
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: () => {},
          releaseResources: () => {},
          dispatchPushNotification: () => {},
        },
      });

      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "executing");
      spies.persistSnapshot.mockClear();
      spies.syncDerivedFields.mockClear();

      actor.send({
        type: "BACKEND_INIT",
        backendRef: { backend: "claude", ref: "sdk-sess-live" },
      });

      expect(actor.getSnapshot().context.backendRef).toEqual({
        backend: "claude",
        ref: "sdk-sess-live",
      });
      expect(spies.syncDerivedFields).toHaveBeenCalled();
      expect(spies.persistSnapshot).toHaveBeenCalled();

      resolveTurn!(successResult());
      await waitForState(actor, "idle");
    });
  });

  describe("AskUserQuestion async flow", () => {
    /** Deferred executePrompt so a test can hold a turn open past ASK_QUESTION. */
    function makeDeferredExecutePrompt() {
      let invocationCount = 0;
      let resolvePrompt: ((result: PromptActorResult) => void) | null = null;
      const actorLogic = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => {
          invocationCount++;
          return new Promise<PromptActorResult>((resolve) => {
            resolvePrompt = resolve;
          });
        },
      );
      return {
        actorLogic,
        get invocationCount() {
          return invocationCount;
        },
        resolve(result: PromptActorResult) {
          resolvePrompt!(result);
        },
      };
    }

    /** Drive a fresh actor through prompt → ASK_QUESTION → turn end, landing
     *  it in the top-level waitingForInput state. */
    async function driveToWaitingForInput(
      overrides?: Parameters<typeof makeTestMachine>[0],
    ) {
      const deferred = makeDeferredExecutePrompt();
      const machine = makeTestMachine({
        executePrompt: deferred.actorLogic,
        ...overrides,
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));

      actor.send({ type: "ASK_QUESTION", questionId: "q1", questions: [] });
      deferred.resolve(successResult());
      await waitForState(actor, "waitingForInput");
      return { actor, deferred };
    }

    it("stays in executing when ASK_QUESTION arrives mid-turn (stream not torn down)", async () => {
      const deferred = makeDeferredExecutePrompt();
      const machine = makeTestMachine({ executePrompt: deferred.actorLogic });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));
      expect(deferred.invocationCount).toBe(1);

      actor.send({ type: "ASK_QUESTION", questionId: "q1", questions: [] });
      await new Promise((r) => setTimeout(r, 10));

      const snap = actor.getSnapshot();
      // The turn keeps running: ASK_QUESTION only records the pending question.
      expect(JSON.stringify(snap.value)).toContain("executing");
      expect(snap.context.status).toBe("waiting_for_input");
      expect(snap.context.pendingQuestion).toEqual({
        questionId: "q1",
        questions: [],
      });
      expect(deferred.invocationCount).toBe(1);

      deferred.resolve(successResult());
      await waitForState(actor, "waitingForInput");
      expect(deferred.invocationCount).toBe(1);
    });

    it("finalizingTurn targets waitingForInput when a question pends, preserving status", async () => {
      const { actor } = await driveToWaitingForInput();

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("waitingForInput");
      expect(snap.context.status).toBe("waiting_for_input");
      expect(snap.context.pendingQuestion).toEqual({
        questionId: "q1",
        questions: [],
      });
      // The turn itself finalized: metadata settled, no active turn.
      expect(snap.context.activeTurn).toBeNull();
      expect(snap.context.promptCount).toBe(1);
    });

    it("finalizingTurn targets idle when no question pends", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.status).toBe("awaiting");
      expect(snap.context.pendingQuestion).toBeNull();
    });

    it("drains the pending queue on waitingForInput entry, like idle", async () => {
      const drainPendingQueue = vi.fn();
      const { actor } = await driveToWaitingForInput({ drainPendingQueue });

      expect(actor.getSnapshot().value).toBe("waitingForInput");
      // Once for the initial idle entry, once for waitingForInput entry.
      expect(drainPendingQueue).toHaveBeenCalledTimes(2);
    });

    it("claiming a conversation turn from waitingForInput clears pendingQuestion (supersede)", async () => {
      const { actor, deferred } = await driveToWaitingForInput();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "different topic",
        streamId: "s2",
      });

      expect(actor.getSnapshot().context.pendingQuestion).toBeNull();
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));
      deferred.resolve(successResult());
      await waitForState(actor, "idle");
      const snap = actor.getSnapshot();
      expect(snap.context.pendingQuestion).toBeNull();
      expect(snap.context.promptCount).toBe(2);
    });

    it("claiming a task run from waitingForInput clears pendingQuestion", async () => {
      const runTaskRun = fromPromise<PromptActorResult, unknown>(async () =>
        successResult(),
      );
      const { actor } = await driveToWaitingForInput({ runTaskRun });

      actor.send({
        executionClass: "nongoverned-task" as const,
        type: "SUBMIT_TASK_RUN",
        promptText: "workflow task",
      });

      expect(actor.getSnapshot().context.pendingQuestion).toBeNull();
      await waitForState(actor, "idle");
      expect(actor.getSnapshot().context.pendingQuestion).toBeNull();
    });

    it("CLEAR_PENDING_QUESTION mid-turn consumes the question so finalize settles to idle", async () => {
      const deferred = makeDeferredExecutePrompt();
      const machine = makeTestMachine({ executePrompt: deferred.actorLogic });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));

      actor.send({ type: "ASK_QUESTION", questionId: "q1", questions: [] });
      expect(actor.getSnapshot().context.status).toBe("waiting_for_input");

      // Answer consumed while the asking turn is still running: the route
      // clears the machine's pending question so the finalize guard sees null.
      actor.send({ type: "CLEAR_PENDING_QUESTION" });
      const mid = actor.getSnapshot();
      expect(mid.context.pendingQuestion).toBeNull();
      expect(mid.context.status).toBe("running");

      deferred.resolve(successResult());
      await waitForState(actor, "idle");
      expect(actor.getSnapshot().value).toBe("idle");
    });

    it("CLEAR_PENDING_QUESTION is refused when nothing pends", async () => {
      const deferred = makeDeferredExecutePrompt();
      const machine = makeTestMachine({ executePrompt: deferred.actorLogic });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));

      expect(actor.getSnapshot().can({ type: "CLEAR_PENDING_QUESTION" })).toBe(
        false,
      );

      deferred.resolve(successResult());
      await waitForState(actor, "idle");
    });

    it("ABORT_TURN mid-turn after ASK_QUESTION clears pendingQuestion and settles to idle", async () => {
      const deferred = makeDeferredExecutePrompt();
      const machine = makeTestMachine({ executePrompt: deferred.actorLogic });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));

      actor.send({ type: "ASK_QUESTION", questionId: "q1", questions: [] });
      actor.send({ type: "ABORT_TURN", reason: "user" });
      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.lastError).toContain("Aborted");
      expect(snap.context.pendingQuestion).toBeNull();

      deferred.resolve(successResult());
    });

    it("explicit stop in waitingForInput clears the question and settles to idle", async () => {
      const { actor } = await driveToWaitingForInput();

      actor.send({ type: "ABORT_TURN", reason: "user" });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.pendingQuestion).toBeNull();
      expect(snap.context.status).toBe("awaiting");
    });

    it("CLEAR_PENDING_QUESTION in waitingForInput clears the marker and settles to idle", async () => {
      // A lane (graph-workflow) answer records on the execution record and does
      // NOT queue a message, so the asking turn's pending marker is settled by a
      // direct CLEAR_PENDING_QUESTION against the parked waitingForInput actor
      // rather than by a SUBMIT_PROMPT drain.
      const { actor } = await driveToWaitingForInput();
      expect(actor.getSnapshot().value).toBe("waitingForInput");

      actor.send({ type: "CLEAR_PENDING_QUESTION" });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.pendingQuestion).toBeNull();
      expect(snap.context.status).toBe("awaiting");
    });

    it("wakes in waitingForInput with the question intact after snapshot restore", async () => {
      const { actor } = await driveToWaitingForInput();
      const persisted = actor.getPersistedSnapshot();
      actor.stop();

      const machine = makeTestMachine();
      const restored = createActor(machine, {
        input: defaultInput,
        snapshot: persisted as ReturnType<(typeof machine)["resolveState"]>,
      });
      activeActors.push(restored);
      restored.start();

      const snap = restored.getSnapshot();
      expect(snap.value).toBe("waitingForInput");
      expect(snap.context.status).toBe("waiting_for_input");
      expect(snap.context.pendingQuestion).toEqual({
        questionId: "q1",
        questions: [],
      });

      // The restored actor still accepts a turn claim (answer or supersede).
      restored.send({
        type: "SUBMIT_PROMPT",
        promptText: "the answer",
        streamId: "s3",
      });
      expect(restored.getSnapshot().context.pendingQuestion).toBeNull();
      await waitForState(restored, "idle");
    });
  });

  // Debug behavior itself (phase advancement, adapter contract, drain
  // policy) is pinned by the external-interface parity suite in
  // `@/lib/workflows/debug/debug-workflow-parity.test.ts` and the debug
  // module's own unit tests. These tests cover only what the MACHINE
  // contributes: the flat debug state, DEBUG_COMMAND legality via
  // `snapshot.can()`, the finalize branch, retry re-entry, and restoration.
  describe("debug workflow attachment", () => {
    const HYPOTHESIS_PAYLOAD = {
      hypotheses: [
        { id: "H1", description: "A", instrumentationPlan: "Log" },
        { id: "H2", description: "B", instrumentationPlan: "Log" },
        { id: "H3", description: "C", instrumentationPlan: "Log" },
      ],
      reproductionSteps: ["Step 1", "Step 2"],
    };

    const CLEANUP_PAYLOAD = {
      removedInstrumentation: true,
      filesModified: ["src/a.ts"],
      grepVerificationPassed: true,
      acknowledgesManifestDeletionContract: true,
      notes: "All probes removed.",
    };

    const CLEANUP_PHASE_INPUT: ConversationInput = {
      ...defaultInput,
      promptCount: 3,
      debugMode: {
        active: true,
        recording: true,
        logFilePath: "/tmp/logs.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [{ id: "H1", description: "A", instrumentationPlan: "L" }],
        reproductionSteps: ["Step 1"],
        fixSummary: "Applied minimal fix.",
        verificationSteps: ["Run failing test"],
        instructionsDelivered: true,
        phase: "cleanup_instrumentation",
        lastTurnFailed: false,
        debugSessionId: "debug-session-restored",
      },
    };

    function sendDebug(actor: AnyActorRef, command: Record<string, unknown>) {
      actor.send({ type: "DEBUG_COMMAND", command } as never);
    }

    function enterDebug(actor: AnyActorRef) {
      sendDebug(actor, {
        kind: "enter",
        logFilePath: "/tmp/logs.jsonl",
        debugSessionId: "debug-session-entered",
      });
    }

    function waitForContext(
      actor: AnyActorRef,
      pred: (context: Record<string, unknown>) => boolean,
      timeoutMs = 3000,
    ): Promise<void> {
      return new Promise((resolve, reject) => {
        const contextOf = () =>
          (actor.getSnapshot() as { context: Record<string, unknown> }).context;
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for context condition")),
          timeoutMs,
        );
        if (pred(contextOf())) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const sub = actor.subscribe(() => {
          if (pred(contextOf())) {
            clearTimeout(timer);
            sub.unsubscribe();
            resolve();
          }
        });
      });
    }

    it("DEBUG_COMMAND enter moves idle to the debug state and initializes debugMode", () => {
      const actor = createActor(makeTestMachine(), { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      enterDebug(actor);

      expect(actor.getSnapshot().value).toBe("debug");
      expect(actor.getSnapshot().context.debugMode).toMatchObject({
        active: true,
        recording: true,
        logFilePath: "/tmp/logs.jsonl",
        phase: "hypothesizing",
        lastTurnFailed: false,
      });
    });

    it("DEBUG_COMMAND exit settles back to idle and resumes queue draining", () => {
      const drainSpy = vi.fn();
      const actor = createActor(
        makeTestMachine({ drainPendingQueue: drainSpy }),
        { input: defaultInput },
      );
      activeActors.push(actor);
      actor.start();
      expect(drainSpy).toHaveBeenCalledTimes(1);

      enterDebug(actor);
      expect(drainSpy).toHaveBeenCalledTimes(1);

      sendDebug(actor, { kind: "exit" });

      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
      expect(drainSpy).toHaveBeenCalledTimes(2);
    });

    it("snapshot.can() reflects the reducer legality table so the adapter's 409 contract holds", () => {
      const actor = createActor(makeTestMachine(), { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      const can = (command: Record<string, unknown>) =>
        actor.getSnapshot().can({ type: "DEBUG_COMMAND", command } as never);

      // Inactive: only enter is legal.
      expect(can({ kind: "mark_reproduced" })).toBe(false);
      expect(can({ kind: "exit" })).toBe(false);
      expect(
        can({
          kind: "enter",
          logFilePath: "/tmp/l.jsonl",
          debugSessionId: "debug-session-can",
        }),
      ).toBe(true);

      enterDebug(actor);

      // hypothesizing: phase marks for other phases are illegal; retry is
      // illegal without a failed turn; re-enter is illegal while active.
      expect(can({ kind: "mark_reproduced" })).toBe(false);
      expect(can({ kind: "mark_fix_verified" })).toBe(false);
      expect(can({ kind: "retry_turn" })).toBe(false);
      expect(
        can({
          kind: "enter",
          logFilePath: "/tmp/l.jsonl",
          debugSessionId: "debug-session-can",
        }),
      ).toBe(false);
      expect(can({ kind: "set_recording", recording: false })).toBe(true);
      expect(can({ kind: "exit" })).toBe(true);
    });

    it("a debug turn runs the turn spine and finalizes back into the debug state with the phase advanced", async () => {
      const actor = createActor(
        makeTestMachine({
          executePrompt: makeSequencedExecutePrompt([
            { structuredOutput: HYPOTHESIS_PAYLOAD },
          ]),
        }),
        { input: defaultInput },
      );
      activeActors.push(actor);
      actor.start();
      enterDebug(actor);

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Investigate",
        streamId: "s1",
      });
      await waitForContext(
        actor,
        (c) =>
          (c.debugMode as { phase?: string } | null)?.phase ===
          "awaiting_reproduction",
      );

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("debug");
      expect(snap.context.activeTurn).toBeNull();
      expect(snap.context.promptCount).toBe(1);
      expect(snap.context.status).toBe("awaiting");
      expect(snap.context.totals.totalCostUsd).toBeCloseTo(0.01);
    });

    it("a failed phase-advancing turn parks in debug with the turn preserved; retry_turn re-enters the spine", async () => {
      const executedPrompts: string[] = [];
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          executedPrompts.push(input.promptText);
          await new Promise((r) => setTimeout(r, 0));
          return successResult(
            executedPrompts.length === 1
              ? { structuredOutput: undefined }
              : { structuredOutput: HYPOTHESIS_PAYLOAD },
          );
        },
      );
      const actor = createActor(makeTestMachine({ executePrompt }), {
        input: defaultInput,
      });
      activeActors.push(actor);
      actor.start();
      enterDebug(actor);

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Investigate",
        streamId: "s1",
      });
      await waitForContext(
        actor,
        (c) =>
          (c.debugMode as { lastTurnFailed?: boolean } | null)
            ?.lastTurnFailed === true,
      );

      let snap = actor.getSnapshot();
      expect(snap.value).toBe("debug");
      expect(snap.context.debugMode?.phase).toBe("hypothesizing");
      expect(snap.context.activeTurn).toMatchObject({
        promptText: "Investigate",
      });
      expect(snap.context.lastError).toBe(
        "Turn did not produce a valid structured response",
      );
      // With a failed turn preserved, retry becomes legal.
      expect(
        actor
          .getSnapshot()
          .can({ type: "DEBUG_COMMAND", command: { kind: "retry_turn" } }),
      ).toBe(true);

      sendDebug(actor, { kind: "retry_turn" });
      await waitForContext(
        actor,
        (c) =>
          (c.debugMode as { phase?: string } | null)?.phase ===
          "awaiting_reproduction",
      );

      snap = actor.getSnapshot();
      expect(executedPrompts).toEqual(["Investigate", "Investigate"]);
      expect(snap.context.debugMode?.lastTurnFailed).toBe(false);
    });

    it("cleanup verification success exits debug mode through the async DEBUG_COMMAND round-trip", async () => {
      const actor = createActor(
        makeTestMachine({
          executePrompt: makeSequencedExecutePrompt([
            { structuredOutput: CLEANUP_PAYLOAD },
          ]),
        }),
        { input: CLEANUP_PHASE_INPUT },
      );
      activeActors.push(actor);
      actor.start();
      expect(actor.getSnapshot().value).toBe("debug");

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Clean up",
        streamId: "s1",
      });
      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.context.debugMode).toBeNull();
      expect(snap.context.activeTurn).toBeNull();
      expect(snap.context.status).toBe("awaiting");
    });

    it("cleanup verification failure parks the failed cleanup turn with the remediation prompt", async () => {
      const actor = createActor(
        makeTestMachine({
          executePrompt: makeSequencedExecutePrompt([
            { structuredOutput: CLEANUP_PAYLOAD },
          ]),
          verifyCleanup: async () => ({
            ok: false,
            failedConditions: ["grepVerificationPassed"],
            missingFiles: [],
            remediationPrompt: "Probe P1 still present in src/a.ts",
          }),
        }),
        { input: CLEANUP_PHASE_INPUT },
      );
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Clean up",
        streamId: "s1",
      });
      await waitForContext(
        actor,
        (c) =>
          (c.debugMode as { lastTurnFailed?: boolean } | null)
            ?.lastTurnFailed === true,
      );

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("debug");
      expect(snap.context.debugMode).toMatchObject({
        active: true,
        phase: "cleanup_instrumentation",
        lastTurnFailed: true,
      });
      expect(snap.context.lastError).toBe("Probe P1 still present in src/a.ts");
      // The cleanup turn is preserved for retry_turn.
      expect(snap.context.activeTurn).toMatchObject({
        promptText: "Clean up",
      });
    });

    it("restores active debugMode from input directly into the debug state", () => {
      const actor = createActor(makeTestMachine(), {
        input: CLEANUP_PHASE_INPUT,
      });
      activeActors.push(actor);
      actor.start();

      expect(actor.getSnapshot().value).toBe("debug");
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "cleanup_instrumentation",
      );
    });

    it("mints and persists a generation for active legacy debug state before cleanup", async () => {
      const persistSnapshot = vi.fn();
      const syncDerivedFields = vi.fn();
      const legacyDebugMode = { ...CLEANUP_PHASE_INPUT.debugMode! };
      delete legacyDebugMode.debugSessionId;
      const actor = createActor(
        makeTestMachine({ persistSnapshot, syncDerivedFields }),
        {
          input: {
            ...CLEANUP_PHASE_INPUT,
            debugMode: legacyDebugMode,
          },
        },
      );
      activeActors.push(actor);
      actor.start();

      expect(actor.getSnapshot().value).toBe("debug");
      expect(actor.getSnapshot().context.debugMode?.debugSessionId).toEqual(
        expect.any(String),
      );
      expect(syncDerivedFields).toHaveBeenCalledTimes(1);
      expect(persistSnapshot).toHaveBeenCalledTimes(1);

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Clean up after upgrade",
        streamId: "s-legacy",
      });
      await waitForState(actor, "idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });

    it("ignores input.debugMode when active is false", () => {
      const actor = createActor(makeTestMachine(), {
        input: {
          ...CLEANUP_PHASE_INPUT,
          debugMode: {
            ...CLEANUP_PHASE_INPUT.debugMode!,
            active: false,
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });

    it("ignores SUBMIT_TASK_RUN and EXTERNAL_TURN_STARTED while in debug", () => {
      const actor = createActor(makeTestMachine(), { input: defaultInput });
      activeActors.push(actor);
      actor.start();
      enterDebug(actor);

      actor.send({
        executionClass: "nongoverned-task" as const,
        type: "SUBMIT_TASK_RUN",
        promptText: "run task",
      });
      expect(actor.getSnapshot().value).toBe("debug");
      expect(actor.getSnapshot().context.activeTurn).toBeNull();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      expect(actor.getSnapshot().value).toBe("debug");
    });
  });

  describe("external turn (auto-continuation)", () => {
    it("transitions idle → externalExecuting on EXTERNAL_TURN_STARTED", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("externalExecuting");
      expect(snap.context.status).toBe("running");
    });

    it("transitions externalExecuting → finalizingTurn → idle on EXTERNAL_TURN_COMPLETED", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: successResult({
          costUsd: 0.03,
          durationMs: 750,
          numTurns: 1,
          backendRef: { backend: "claude" as const, ref: "sess-ext" },
        }),
      });

      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.status).toBe("awaiting");
      expect(snap.context.promptCount).toBe(1);
      expect(snap.context.totals.totalCostUsd).toBe(0.03);
      expect(snap.context.totals.totalDurationMs).toBe(750);
      expect(snap.context.totals.totalTurns).toBe(1);
      expect(snap.context.backendRef).toEqual({
        backend: "claude",
        ref: "sess-ext",
      });
      expect(snap.context.lastResult).toBeTruthy();
    });

    it("re-syncs derived fields on ABORT_TURN while idle so Stop clears a phantom running row", () => {
      const syncDerivedFields = vi.fn();
      const broadcastConversationStatus = vi.fn();
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
        },
        actions: {
          persistSnapshot: () => {},
          syncDerivedFields,
          broadcastConversationStatus,
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: () => {},
          releaseResources: () => {},
          dispatchPushNotification: () => {},
        },
      });
      // A conversation that has already run a turn: the machine believes it is
      // settled, but a wedged predecessor left the persisted row on "running".
      const actor = createActor(machine, {
        input: { ...defaultInput, promptCount: 1 },
      });
      activeActors.push(actor);
      actor.start();
      syncDerivedFields.mockClear();
      broadcastConversationStatus.mockClear();

      actor.send({ type: "ABORT_TURN", reason: "user" });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.status).toBe("awaiting");
      expect(syncDerivedFields).toHaveBeenCalled();
      expect(broadcastConversationStatus).toHaveBeenCalled();
    });

    it("settles to idle on ABORT_TURN so Stop recovers an external turn that never completes", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      expect(actor.getSnapshot().value).toBe("externalExecuting");

      actor.send({ type: "ABORT_TURN", reason: "user" });
      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.status).toBe("awaiting");
      expect(snap.context.activeTurn).toBeNull();
    });

    it("re-accepts SUBMIT_PROMPT after an external turn is aborted", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      actor.send({ type: "ABORT_TURN", reason: "user" });
      await waitForState(actor, "idle");

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "next",
        streamId: "stream-after-abort",
      });
      expect(actor.getSnapshot().context.status).toBe("running");
    });

    it("fires broadcastConversationStatus on EXTERNAL_TURN_STARTED", () => {
      const broadcastConversationStatus = vi.fn();
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
        },
        actions: {
          persistSnapshot: () => {},
          syncDerivedFields: () => {},
          broadcastConversationStatus,
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: () => {},
          releaseResources: () => {},
          dispatchPushNotification: () => {},
        },
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      broadcastConversationStatus.mockClear();
      actor.send({ type: "EXTERNAL_TURN_STARTED" });

      expect(broadcastConversationStatus).toHaveBeenCalled();
    });

    it("fires dispatchPushNotification when external turn completes", async () => {
      const dispatchPushNotification = vi.fn();
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
        },
        actions: {
          persistSnapshot: () => {},
          syncDerivedFields: () => {},
          broadcastConversationStatus: () => {},
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: () => {},
          releaseResources: () => {},
          dispatchPushNotification,
        },
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: successResult(),
      });

      await waitForState(actor, "idle");
      expect(dispatchPushNotification).toHaveBeenCalled();
    });

    it("runs back-to-back external turns cleanly", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: successResult({ costUsd: 0.01, numTurns: 1 }),
      });
      await waitForState(actor, "idle");

      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: successResult({ costUsd: 0.02, numTurns: 1 }),
      });
      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.context.promptCount).toBe(2);
      expect(snap.context.totals.totalCostUsd).toBeCloseTo(0.03, 5);
      expect(snap.context.totals.totalTurns).toBe(2);
    });
  });

  describe("pending-queue drain at settled points", () => {
    it("invokes drainPendingQueue on idle entry at startup", () => {
      const drainPendingQueue = vi.fn();
      const machine = makeTestMachine({ drainPendingQueue });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // idle is the initial state, so entering it at startup fires the drain.
      expect(actor.getSnapshot().value).toBe("idle");
      expect(drainPendingQueue).toHaveBeenCalledTimes(1);
    });

    it("invokes drainPendingQueue again when a turn settles back to idle", async () => {
      const drainPendingQueue = vi.fn();
      const machine = makeTestMachine({ drainPendingQueue });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      expect(drainPendingQueue).toHaveBeenCalledTimes(1);

      // Drive a full turn: idle → acquiringResources → executing →
      // finalizingTurn → idle. The transient finalizingTurn resolves to idle,
      // re-entering idle and firing the drain a second time.
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "idle");

      expect(actor.getSnapshot().value).toBe("idle");
      expect(drainPendingQueue).toHaveBeenCalledTimes(2);
    });

    it("accepts EXTERNAL_TURN_STARTED at the settle boundary and routes to externalExecuting without dropping it", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // Drive a turn to completion so the transient finalizingTurn settles into
      // idle. A live-delivery continuation arriving "as the turn settles" is
      // handled in idle (the resting state), not dropped.
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });
      await waitForState(actor, "idle");
      expect(actor.getSnapshot().value).toBe("idle");

      actor.send({ type: "EXTERNAL_TURN_STARTED" });

      expect(actor.getSnapshot().value).toBe("externalExecuting");
      expect(actor.getSnapshot().context.status).toBe("running");
    });
  });

  describe("turn configuration threading", () => {
    it("preserves an explicit complete Codex selection in executePrompt input", async () => {
      let capturedInput: ExecutePromptInput | null = null;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          capturedInput = input;
          return successResult();
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();
      await waitForState(actor, "idle");

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Use Standard speed",
        streamId: "standard-speed",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
      });

      await waitForState(actor, "executing");
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.modelSelection).toEqual({
        modelId: "gpt-5.4",
        parameters: { fast: "false", reasoning: "high" },
      });
    });

    it("persists a resolved conversation selection on the active turn before dispatch continues", async () => {
      const canonicalSelection: BackendModelSelection = {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      };
      const order: string[] = [];
      let actorReported!: () => void;
      const reported = new Promise<void>((resolve) => {
        actorReported = resolve;
      });
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          await input.onModelSelectionResolved(canonicalSelection);
          order.push("dispatch");
          actorReported();
          return await new Promise<PromptActorResult>(() => {});
        },
      );
      const persistSnapshot = vi.fn(
        ({ context }: { context: ConversationContext }) => {
          if (context.activeTurn?.modelSelection === canonicalSelection) {
            order.push("persist");
          }
        },
      );
      const syncedSelections: Array<BackendModelSelection | null> = [];
      const syncDerivedFields = vi.fn(
        ({ context }: { context: ConversationContext }) => {
          syncedSelections.push(context.activeTurn?.modelSelection ?? null);
        },
      );
      const actor = createActor(
        makeTestMachine({
          executePrompt,
          persistSnapshot,
          syncDerivedFields,
        }),
        { input: defaultInput },
      );
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Continue on the inherited selection",
        streamId: "resolved-conversation-selection",
      });

      await reported;

      expect(actor.getSnapshot().context.activeTurn?.modelSelection).toEqual(
        canonicalSelection,
      );
      expect(order).toEqual(["persist", "dispatch"]);
      expect(syncedSelections).toContainEqual(canonicalSelection);
    });

    it("persists a resolved task-run selection on the active turn before dispatch continues", async () => {
      const configuredSelection: BackendModelSelection = {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "false", reasoning: "ultra" },
      };
      const order: string[] = [];
      let actorReported!: () => void;
      const reported = new Promise<void>((resolve) => {
        actorReported = resolve;
      });
      const runTaskRun = fromPromise<PromptActorResult, RunTaskRunInput>(
        async ({ input }) => {
          await input.onModelSelectionResolved(configuredSelection);
          order.push("dispatch");
          actorReported();
          return await new Promise<PromptActorResult>(() => {});
        },
      );
      const persistSnapshot = vi.fn(
        ({ context }: { context: ConversationContext }) => {
          if (context.activeTurn?.modelSelection === configuredSelection) {
            order.push("persist");
          }
        },
      );
      const actor = createActor(
        makeTestMachine({ runTaskRun, persistSnapshot }),
        { input: defaultInput },
      );
      activeActors.push(actor);
      actor.start();

      actor.send({
        executionClass: "nongoverned-task" as const,
        type: "SUBMIT_TASK_RUN",
        promptText: "Run with the configured default",
        backend: "codex",
      });

      await reported;

      expect(actor.getSnapshot().context.activeTurn?.modelSelection).toEqual(
        configuredSelection,
      );
      expect(order).toEqual(["persist", "dispatch"]);
    });

    it("rejects a stale selection report without mutating the current active turn", async () => {
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => await new Promise<PromptActorResult>(() => {}),
      );
      const actor = createActor(makeTestMachine({ executePrompt }), {
        input: defaultInput,
      });
      activeActors.push(actor);
      actor.start();
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Current turn",
        streamId: "current-turn",
      });
      await waitForState(actor, "conversationTurn");

      const acknowledge = vi.fn();
      const reject = vi.fn();
      actor.send({
        type: "MODEL_SELECTION_RESOLVED",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { fast: "false", reasoning: "ultra" },
        },
        executionAttemptId: "stale-attempt",
        acknowledge,
        reject,
      });

      expect(reject).toHaveBeenCalledWith(expect.any(Error));
      expect(acknowledge).not.toHaveBeenCalled();
      expect(actor.getSnapshot().context.activeTurn?.modelSelection).toBeNull();
    });

    it("rejects a selection report from the prior attempt after a debug retry", async () => {
      const resolvedSelection: BackendModelSelection = {
        modelId: "opus",
        parameters: { effort: "high" },
      };
      let invocationCount = 0;
      let firstReporter:
        | ExecutePromptInput["onModelSelectionResolved"]
        | undefined;
      let secondReporter:
        | ExecutePromptInput["onModelSelectionResolved"]
        | undefined;
      let resolveSecondStarted!: () => void;
      const secondStarted = new Promise<void>((resolve) => {
        resolveSecondStarted = resolve;
      });
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          invocationCount += 1;
          if (invocationCount === 1) {
            firstReporter = input.onModelSelectionResolved;
            return successResult({ structuredOutput: undefined });
          }
          secondReporter = input.onModelSelectionResolved;
          resolveSecondStarted();
          return await new Promise<PromptActorResult>(() => {});
        },
      );
      const actor = createActor(makeTestMachine({ executePrompt }), {
        input: defaultInput,
      });
      activeActors.push(actor);
      actor.start();
      actor.send({
        type: "DEBUG_COMMAND",
        command: {
          kind: "enter",
          logFilePath: "/tmp/logs.jsonl",
          debugSessionId: "debug-session-selection-attempt",
        },
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Investigate",
        streamId: "selection-attempt",
      });
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.debugMode?.lastTurnFailed).toBe(
          true,
        );
      });

      actor.send({
        type: "DEBUG_COMMAND",
        command: { kind: "retry_turn" },
      });
      await secondStarted;

      expect(firstReporter).toBeTypeOf("function");
      await expect(firstReporter!(resolvedSelection)).rejects.toThrow(
        "inactive",
      );
      expect(actor.getSnapshot().context.activeTurn?.modelSelection).toBeNull();

      expect(secondReporter).toBeTypeOf("function");
      await expect(secondReporter!(resolvedSelection)).resolves.toBeUndefined();
      expect(actor.getSnapshot().context.activeTurn?.modelSelection).toEqual(
        resolvedSelection,
      );
    });

    it("rejects a late selection report after the attempt is aborted", async () => {
      const resolvedSelection: BackendModelSelection = {
        modelId: "opus",
        parameters: { effort: "high" },
      };
      let reporter: ExecutePromptInput["onModelSelectionResolved"] | undefined;
      let resolveReporterCaptured!: () => void;
      const reporterCaptured = new Promise<void>((resolve) => {
        resolveReporterCaptured = resolve;
      });
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          reporter = input.onModelSelectionResolved;
          resolveReporterCaptured();
          return await new Promise<PromptActorResult>(() => {});
        },
      );
      const actor = createActor(makeTestMachine({ executePrompt }), {
        input: defaultInput,
      });
      activeActors.push(actor);
      actor.start();
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Abort before selection resolution",
        streamId: "late-selection",
      });
      await reporterCaptured;

      actor.send({ type: "ABORT_TURN", reason: "user" });
      await waitForState(actor, "idle");

      expect(reporter).toBeTypeOf("function");
      const outcome = await Promise.race([
        reporter!(resolvedSelection).then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 100);
        }),
      ]);
      expect(outcome).toBe("rejected");
      expect(actor.getSnapshot().context.activeTurn).toBeNull();
    });
  });

  describe("queuedDelivery threading", () => {
    it("threads SUBMIT_PROMPT.queuedDelivery into executePrompt input", async () => {
      let capturedInput: ExecutePromptInput | null = null;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          capturedInput = input;
          return successResult();
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();
      await waitForState(actor, "idle");

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "drained",
        streamId: "internal-1",
        queuedDelivery: {
          messageIds: ["m1", "m2"],
          deliveryAttemptId: "att-7",
        },
      });

      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.queuedDelivery).toEqual({
        messageIds: ["m1", "m2"],
        deliveryAttemptId: "att-7",
      });
    });

    it("leaves executePrompt input.queuedDelivery undefined for a normal turn", async () => {
      let capturedInput: ExecutePromptInput | null = null;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          capturedInput = input;
          return successResult();
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();
      await waitForState(actor, "idle");

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "normal",
        streamId: "internal-2",
      });

      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.queuedDelivery).toBeUndefined();
    });
  });
});
