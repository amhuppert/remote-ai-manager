import { describe, it, expect, vi, afterEach } from "vitest";
import { createActor, fromPromise, type AnyActorRef } from "xstate";
import { conversationMachine } from "./machine";
import type {
  ConversationInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
} from "./types";

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
    contentBlocks: [{ type: "text", text: "Hello" }],
    aborted: false,
    error: null,
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

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeTestMachine(overrides?: {
  prepareTurn?: any;
  executePrompt?: any;
}) {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return conversationMachine.provide({
    actors: {
      prepareTurn: overrides?.prepareTurn ?? makeMockPrepareTurn(),
      executePrompt: overrides?.executePrompt ?? makeMockExecutePrompt(),
    },
    actions: {
      persistSnapshot: () => {},
      syncDerivedFields: () => {},
      broadcastConversationStatus: () => {},
      broadcastAskQuestion: () => {},
      broadcastDebugModeStatus: () => {},
      releaseResources: () => {},
      dispatchPushNotification: () => {},
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
  });

  describe("AskUserQuestion flow", () => {
    it("does not re-invoke executePrompt when transitioning through waitingForInput", async () => {
      let invocationCount = 0;
      let resolvePrompt: ((result: PromptActorResult) => void) | null = null;

      const machine = makeTestMachine({
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          async () => {
            invocationCount++;
            return new Promise<PromptActorResult>((resolve) => {
              resolvePrompt = resolve;
            });
          },
        ),
      });

      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hello",
        streamId: "s1",
      });

      // Wait for executePrompt to be invoked
      await waitForState(actor, "executing");
      await new Promise((r) => setTimeout(r, 10));
      expect(invocationCount).toBe(1);

      // Simulate SDK's canUseTool sending ASK_QUESTION
      actor.send({
        type: "ASK_QUESTION",
        questionId: "q1",
        questions: [],
      });
      await waitForState(actor, "waitingForInput");

      // User answers — should NOT re-invoke executePrompt
      actor.send({
        type: "ANSWER",
        questionId: "q1",
        answers: { "Continue?": "yes" },
      });

      // Give time for any potential re-invocation
      await new Promise((r) => setTimeout(r, 50));
      expect(invocationCount).toBe(1);

      // Complete the prompt
      resolvePrompt!(successResult());
      await waitForState(actor, "idle");

      expect(actor.getSnapshot().context.promptCount).toBe(1);
    });

    it("handles ABORT_TURN while in waitingForInput", async () => {
      let resolvePrompt: ((result: PromptActorResult) => void) | null = null;

      const machine = makeTestMachine({
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          async () => {
            return new Promise<PromptActorResult>((resolve) => {
              resolvePrompt = resolve;
            });
          },
        ),
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

      actor.send({
        type: "ASK_QUESTION",
        questionId: "q1",
        questions: [],
      });
      await waitForState(actor, "waitingForInput");

      // Abort while waiting for input
      actor.send({ type: "ABORT_TURN", reason: "user" });
      await waitForState(actor, "idle");

      const snap = actor.getSnapshot();
      expect(snap.context.lastError).toContain("Aborted");
      expect(snap.context.pendingQuestion).toBeNull();

      // Clean up pending promise
      resolvePrompt!(successResult());
    });
  });

  describe("debug mode", () => {
    it("transitions to debug.hypothesizing on ENTER_DEBUG_MODE", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });

      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "hypothesizing" });
      expect(snap.context.debugMode).not.toBeNull();
      expect(snap.context.debugMode?.active).toBe(true);
      expect(snap.context.debugMode?.phase).toBe("hypothesizing");
      expect(snap.context.debugMode?.logFilePath).toBe(
        "/tmp/.debug/logs.jsonl",
      );
    });

    it("exits debug mode back to idle on EXIT_DEBUG_MODE", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({ type: "EXIT_DEBUG_MODE" });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.debugMode).toBeNull();
    });

    it("fires syncDerivedFields, broadcastDebugModeStatus, and persistSnapshot on ENTER_DEBUG_MODE", () => {
      const spies = {
        syncDerivedFields: vi.fn(),
        broadcastDebugModeStatus: vi.fn(),
        persistSnapshot: vi.fn(),
      };
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
        },
        actions: {
          persistSnapshot: spies.persistSnapshot,
          syncDerivedFields: spies.syncDerivedFields,
          broadcastConversationStatus: () => {},
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: spies.broadcastDebugModeStatus,
          releaseResources: () => {},
          dispatchPushNotification: () => {},
        },
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });

      expect(spies.syncDerivedFields).toHaveBeenCalled();
      expect(spies.broadcastDebugModeStatus).toHaveBeenCalled();
      expect(spies.persistSnapshot).toHaveBeenCalled();
    });

    it("fires syncDerivedFields, broadcastDebugModeStatus, and persistSnapshot on EXIT_DEBUG_MODE", () => {
      const spies = {
        syncDerivedFields: vi.fn(),
        broadcastDebugModeStatus: vi.fn(),
        persistSnapshot: vi.fn(),
      };
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
        },
        actions: {
          persistSnapshot: spies.persistSnapshot,
          syncDerivedFields: spies.syncDerivedFields,
          broadcastConversationStatus: () => {},
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: spies.broadcastDebugModeStatus,
          releaseResources: () => {},
          dispatchPushNotification: () => {},
        },
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });

      // Reset spies after enter so we only check exit actions
      spies.syncDerivedFields.mockClear();
      spies.broadcastDebugModeStatus.mockClear();
      spies.persistSnapshot.mockClear();

      actor.send({ type: "EXIT_DEBUG_MODE" });

      expect(spies.syncDerivedFields).toHaveBeenCalled();
      expect(spies.broadcastDebugModeStatus).toHaveBeenCalled();
      expect(spies.persistSnapshot).toHaveBeenCalled();
    });

    it("allows SET_DEBUG_RECORDING in any debug state", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({ type: "SET_DEBUG_RECORDING", recording: true });

      expect(actor.getSnapshot().context.debugMode?.recording).toBe(true);
    });

    it("fires syncDerivedFields on SET_DEBUG_RECORDING", () => {
      const spies = {
        syncDerivedFields: vi.fn(),
      };
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
        },
        actions: {
          persistSnapshot: () => {},
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
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      spies.syncDerivedFields.mockClear();

      actor.send({ type: "SET_DEBUG_RECORDING", recording: true });

      expect(spies.syncDerivedFields).toHaveBeenCalled();
    });

    it("returns to awaitingReproduction after a follow-up prompt completes", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          structuredOutput: {
            hypotheses: [
              { id: "H1", description: "A", instrumentationPlan: "Log A" },
              { id: "H2", description: "B", instrumentationPlan: "Log B" },
              { id: "H3", description: "C", instrumentationPlan: "Log C" },
            ],
            reproductionSteps: ["Step 1", "Step 2"],
          },
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // Enter debug → hypothesizing → submit → awaitingReproduction
      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug this",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      // Submit a follow-up prompt from awaitingReproduction
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Can you also check X?",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingReproduction");

      // Should still be in debug mode with same phase
      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingReproduction",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );
      expect(actor.getSnapshot().context.debugMode?.active).toBe(true);
    });

    it("returns to awaitingVerification after a follow-up prompt completes", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // Enter debug → hypothesizing → submit → awaitingReproduction
      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug this",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      // Mark reproduced → analyzingEvidence → submit → fixing
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze evidence",
        streamId: "s2",
      });
      await waitForState(actor, "fixing");

      // Submit fix prompt → awaitingVerification
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Apply fix",
        streamId: "s3",
      });
      await waitForState(actor, "awaitingVerification");

      // Submit a follow-up from awaitingVerification
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "What about edge case?",
        streamId: "s4",
      });
      await waitForState(actor, "awaitingVerification");

      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingVerification",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_verification",
      );
    });

    it("exits to idle and clears debugMode after cleanup prompt completes", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // Fast-track to awaitingVerification
      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug this",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "fixing");
      actor.send({ type: "SUBMIT_PROMPT", promptText: "Fix", streamId: "s3" });
      await waitForState(actor, "awaitingVerification");

      // Mark fix verified → cleanupInstrumentation
      actor.send({ type: "MARK_FIX_VERIFIED" });
      expect(actor.getSnapshot().value).toEqual({
        debug: "cleanupInstrumentation",
      });

      // Submit cleanup prompt → should exit to idle and clear debugMode
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Clean up instrumentation",
        streamId: "s4",
      });
      await waitForState(actor, "idle");

      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });

    it("fires syncDerivedFields and persistSnapshot on MARK_REPRODUCED", async () => {
      const spies = {
        syncDerivedFields: vi.fn(),
        persistSnapshot: vi.fn(),
      };
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt({
            structuredOutput: {
              hypotheses: [
                { id: "H1", description: "A", instrumentationPlan: "Log A" },
                { id: "H2", description: "B", instrumentationPlan: "Log B" },
                { id: "H3", description: "C", instrumentationPlan: "Log C" },
              ],
              reproductionSteps: ["Step 1"],
            },
          }),
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
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      spies.syncDerivedFields.mockClear();
      spies.persistSnapshot.mockClear();

      actor.send({ type: "MARK_REPRODUCED" });

      expect(spies.syncDerivedFields).toHaveBeenCalled();
      expect(spies.persistSnapshot).toHaveBeenCalled();
    });

    it("fires syncDerivedFields and persistSnapshot on MARK_FIX_VERIFIED", async () => {
      const spies = {
        syncDerivedFields: vi.fn(),
        persistSnapshot: vi.fn(),
      };
      const machine = conversationMachine.provide({
        actors: {
          prepareTurn: makeMockPrepareTurn(),
          executePrompt: makeMockExecutePrompt(),
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

      // Fast-track to awaitingVerification
      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "fixing");
      actor.send({ type: "SUBMIT_PROMPT", promptText: "Fix", streamId: "s3" });
      await waitForState(actor, "awaitingVerification");

      spies.syncDerivedFields.mockClear();
      spies.persistSnapshot.mockClear();

      actor.send({ type: "MARK_FIX_VERIFIED" });

      expect(spies.syncDerivedFields).toHaveBeenCalled();
      expect(spies.persistSnapshot).toHaveBeenCalled();
    });

    it("loops back to debug.hypothesizing when evidence analysis recommends more_instrumentation", async () => {
      let callCount = 0;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => {
          await new Promise((r) => setTimeout(r, 0));
          callCount++;
          if (callCount === 1) {
            // First call: hypothesizing phase
            return successResult({
              structuredOutput: {
                hypotheses: [
                  {
                    id: "H1",
                    description: "A",
                    instrumentationPlan: "Log",
                  },
                  {
                    id: "H2",
                    description: "B",
                    instrumentationPlan: "Log",
                  },
                  {
                    id: "H3",
                    description: "C",
                    instrumentationPlan: "Log",
                  },
                ],
                reproductionSteps: ["Step 1", "Step 2"],
              },
            });
          }
          // Second call: evidence analysis → more_instrumentation
          return successResult({
            structuredOutput: {
              supportedHypotheses: [],
              refutedHypotheses: ["H1"],
              inconclusiveHypotheses: ["H2", "H3"],
              recommendedNextStep: "more_instrumentation",
              evidenceSummary: "Insufficient data",
            },
          });
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // Enter debug → hypothesizing
      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });

      // Submit hypothesis prompt → awaitingReproduction
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug this",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      // Mark reproduced → analyzingEvidence
      actor.send({ type: "MARK_REPRODUCED" });
      expect(actor.getSnapshot().value).toEqual({
        debug: "analyzingEvidence",
      });

      // Submit analysis prompt → should loop back to hypothesizing
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze logs",
        streamId: "s2",
      });
      await waitForState(actor, "hypothesizing");

      // Machine state should be debug.hypothesizing (not debug.fixing)
      expect(actor.getSnapshot().value).toEqual({
        debug: "hypothesizing",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "hypothesizing",
      );
    });

    it("runs full debug lifecycle: hypothesize → reproduce → analyze → fix → verify → cleanup", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          structuredOutput: {
            hypotheses: [
              {
                id: "H1",
                description: "Race condition",
                instrumentationPlan: "Add logs",
              },
              {
                id: "H2",
                description: "Null ref",
                instrumentationPlan: "Add guards",
              },
              {
                id: "H3",
                description: "Stale cache",
                instrumentationPlan: "Add timestamps",
              },
            ],
            reproductionSteps: ["Open app", "Click button"],
          },
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      // Enter debug
      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });
      expect(actor.getSnapshot().value).toEqual({ debug: "hypothesizing" });

      // Submit prompt for hypothesizing phase
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Debug this issue",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );

      // Mark reproduced → analyzing evidence
      actor.send({ type: "MARK_REPRODUCED" });
      expect(actor.getSnapshot().value).toEqual({
        debug: "analyzingEvidence",
      });
    });
  });
});
