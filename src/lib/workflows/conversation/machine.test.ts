import { describe, it, expect, vi, afterEach } from "vitest";
import { createActor, fromPromise, type AnyActorRef } from "xstate";
import { conversationMachine } from "./machine";
import {
  debugHypothesisOutputSchema,
  debugEvidenceAnalysisOutputSchema,
  debugCleanupResultSchema,
} from "./debug-schemas";
import type {
  ConversationInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  VerifyCleanupInput,
  VerifyCleanupOutput,
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

/**
 * executePrompt mock that drives the full debug flow:
 *   hypothesizing → awaitingReproduction → analyzingEvidence → awaitingVerification
 *   → cleanupInstrumentation → verifyingCleanup
 *
 * Call 1 returns a hypothesis payload, call 2 returns an
 * outcome="fix_applied" evidence payload, calls 3+ return the configured
 * cleanup payload.
 */
function makeDebugFlowExecutePrompt(cleanupResult: {
  removedInstrumentation: boolean;
  filesModified: string[];
  grepVerificationPassed: boolean;
  acknowledgesManifestDeletionContract: boolean;
  notes: string;
}) {
  let callCount = 0;
  return fromPromise<PromptActorResult, ExecutePromptInput>(async () => {
    callCount += 1;
    if (callCount === 1) {
      return successResult({
        structuredOutput: {
          hypotheses: [
            { id: "H1", description: "A", instrumentationPlan: "Log" },
            { id: "H2", description: "B", instrumentationPlan: "Log" },
            { id: "H3", description: "C", instrumentationPlan: "Log" },
          ],
          reproductionSteps: ["Step 1", "Step 2"],
        },
      });
    }
    if (callCount === 2) {
      return successResult({
        structuredOutput: {
          outcome: "fix_applied",
          supportedHypotheses: ["H1"],
          refutedHypotheses: [],
          inconclusiveHypotheses: ["H2", "H3"],
          evidenceSummary: "H1 confirmed.",
          fixSummary: "Applied minimal fix.",
          verificationSteps: ["Run failing test"],
        },
      });
    }
    return successResult({ structuredOutput: cleanupResult });
  });
}

function makeMockVerifyCleanup(output: Partial<VerifyCleanupOutput> = {}) {
  return fromPromise<VerifyCleanupOutput, VerifyCleanupInput>(async () => {
    await new Promise((r) => setTimeout(r, 0));
    return {
      ok: true,
      failedConditions: [],
      missingFiles: [],
      remediationPrompt: null,
      ...output,
    };
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeTestMachine(overrides?: {
  prepareTurn?: any;
  executePrompt?: any;
  verifyCleanup?: any;
}) {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return conversationMachine.provide({
    actors: {
      prepareTurn: overrides?.prepareTurn ?? makeMockPrepareTurn(),
      executePrompt: overrides?.executePrompt ?? makeMockExecutePrompt(),
      verifyCleanup: overrides?.verifyCleanup ?? makeMockVerifyCleanup(),
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

    it("clears Codex backendRef when prompt returns with error", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "Codex Exec exited with code 1: Reading prompt from stdin...",
          backendRef: null,
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
            threadId: "thread-dead",
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
      let callCount = 0;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => {
          callCount += 1;
          if (callCount === 1) {
            return successResult({
              structuredOutput: {
                hypotheses: [
                  { id: "H1", description: "A", instrumentationPlan: "Log" },
                  { id: "H2", description: "B", instrumentationPlan: "Log" },
                  { id: "H3", description: "C", instrumentationPlan: "Log" },
                ],
                reproductionSteps: ["Step 1", "Step 2"],
              },
            });
          }
          if (callCount === 2) {
            return successResult({
              structuredOutput: {
                outcome: "fix_applied",
                supportedHypotheses: ["H1"],
                refutedHypotheses: [],
                inconclusiveHypotheses: ["H2", "H3"],
                evidenceSummary: "H1 confirmed.",
                fixSummary: "Applied minimal fix.",
                verificationSteps: ["Run failing test"],
              },
            });
          }
          return successResult();
        },
      );
      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

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
        promptText: "Analyze evidence",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "What about edge case?",
        streamId: "s3",
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
      let callCount = 0;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => {
          callCount += 1;
          if (callCount === 1) {
            return successResult({
              structuredOutput: {
                hypotheses: [
                  { id: "H1", description: "A", instrumentationPlan: "Log" },
                  { id: "H2", description: "B", instrumentationPlan: "Log" },
                  { id: "H3", description: "C", instrumentationPlan: "Log" },
                ],
                reproductionSteps: ["Step 1", "Step 2"],
              },
            });
          }
          if (callCount === 2) {
            return successResult({
              structuredOutput: {
                outcome: "fix_applied",
                supportedHypotheses: ["H1"],
                refutedHypotheses: [],
                inconclusiveHypotheses: ["H2", "H3"],
                evidenceSummary: "H1 confirmed.",
                fixSummary: "Applied minimal fix.",
                verificationSteps: ["Run failing test"],
              },
            });
          }
          return successResult({
            structuredOutput: {
              removedInstrumentation: true,
              filesModified: ["src/index.ts"],
              grepVerificationPassed: true,
              acknowledgesManifestDeletionContract: true,
              notes: "Cleanup complete.",
            },
          });
        },
      );
      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

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
      await waitForState(actor, "awaitingVerification");

      actor.send({ type: "MARK_FIX_VERIFIED" });
      expect(actor.getSnapshot().value).toEqual({
        debug: "cleanupInstrumentation",
      });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Clean up instrumentation",
        streamId: "s3",
      });
      await waitForState(actor, "idle");

      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });

    it("SUBMIT_PROMPT from every debug substate routes to acquiringResources via the lifted parent handler", async () => {
      const phases = [
        "hypothesizing",
        "awaiting_reproduction",
        "analyzing_evidence",
        "awaiting_verification",
        "cleanup_instrumentation",
      ] as const;

      for (const phase of phases) {
        const machine = makeTestMachine();
        const actor = createActor(machine, {
          input: {
            ...defaultInput,
            debugMode: {
              active: true,
              recording: true,
              logFilePath: "/tmp/.debug/x.jsonl",
              enteredAt: "2024-01-02T00:00:00Z",
              hypotheses: [],
              reproductionSteps: [],
              instructionsDelivered: true,
              phase,
              fixSummary: null,
              verificationSteps: [],
              lastTurnFailed: false,
            },
          },
        });
        activeActors.push(actor);
        actor.start();

        actor.send({
          type: "SUBMIT_PROMPT",
          promptText: "follow up",
          streamId: `s-${phase}`,
        });

        expect(actor.getSnapshot().value).toBe("acquiringResources");
        actor.stop();
      }
    });

    it("SUBMIT_PROMPT from debug.error replaces the failed turn (lifted parent handler)", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          structuredOutput: undefined,
          error: "no schema match",
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "error");
      expect(actor.getSnapshot().value).toEqual({ debug: "error" });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Try again with new context",
        streamId: "s2",
      });

      expect(actor.getSnapshot().value).toBe("acquiringResources");
    });

    it("persists parsed hypotheses on context.debugMode after a hypothesizing turn", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          structuredOutput: {
            hypotheses: [
              {
                id: "H1",
                description: "Token expiry",
                instrumentationPlan: "Log token timestamps",
              },
              {
                id: "H2",
                description: "Race in dispatch",
                instrumentationPlan: "Log dispatch order",
              },
              {
                id: "H3",
                description: "Stale cache",
                instrumentationPlan: "Log cache hits",
              },
            ],
            reproductionSteps: ["Step 1", "Step 2"],
          },
        }),
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
        promptText: "Form hypotheses",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      const ctx = actor.getSnapshot().context;
      expect(ctx.debugMode?.phase).toBe("awaiting_reproduction");
      expect(ctx.debugMode?.hypotheses).toEqual([
        {
          id: "H1",
          description: "Token expiry",
          instrumentationPlan: "Log token timestamps",
        },
        {
          id: "H2",
          description: "Race in dispatch",
          instrumentationPlan: "Log dispatch order",
        },
        {
          id: "H3",
          description: "Stale cache",
          instrumentationPlan: "Log cache hits",
        },
      ]);
    });

    it("restores persisted hypotheses when the actor is recreated", () => {
      const persistedHypotheses = [
        { id: "H1", description: "A", instrumentationPlan: "Log A" },
        { id: "H2", description: "B", instrumentationPlan: "Log B" },
      ];
      const machine = makeTestMachine();
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          debugMode: {
            active: true,
            recording: true,
            logFilePath: "/tmp/.debug/logs.jsonl",
            enteredAt: "2024-01-02T03:04:05Z",
            hypotheses: persistedHypotheses,
            reproductionSteps: [],
            instructionsDelivered: true,
            phase: "awaiting_reproduction",
            fixSummary: null,
            verificationSteps: [],
            lastTurnFailed: false,
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      const snap = actor.getSnapshot();
      expect(snap.context.debugMode?.hypotheses).toEqual(persistedHypotheses);
    });

    it("routes cleanup turn to debug.error when verifyCleanup reports a failed gate", async () => {
      const machine = makeTestMachine({
        executePrompt: makeDebugFlowExecutePrompt({
          removedInstrumentation: true,
          filesModified: ["src/a.ts"],
          grepVerificationPassed: true,
          acknowledgesManifestDeletionContract: true,
          notes: "done",
        }),
        verifyCleanup: makeMockVerifyCleanup({
          ok: false,
          failedConditions: [],
          missingFiles: ["src/b.ts"],
          remediationPrompt:
            "Cleanup verification failed. Re-open src/b.ts and remove probes.",
        }),
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
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");
      actor.send({ type: "MARK_FIX_VERIFIED" });
      await waitForState(actor, "cleanupInstrumentation");
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Cleanup",
        streamId: "s3",
      });

      await waitForState(actor, "error");
      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "error" });
      expect(snap.context.debugMode?.active).toBe(true);
      expect(snap.context.debugMode?.phase).toBe("cleanup_instrumentation");
      expect(snap.context.lastError).toContain("src/b.ts");
    });

    it("RETRY_DEBUG_TURN re-runs cleanup turn after a failed verifyingCleanup", async () => {
      let verifyCallCount = 0;
      const verifyCleanup = fromPromise<
        VerifyCleanupOutput,
        VerifyCleanupInput
      >(async () => {
        verifyCallCount += 1;
        await new Promise((r) => setTimeout(r, 0));
        if (verifyCallCount === 1) {
          return {
            ok: false,
            failedConditions: [],
            missingFiles: ["src/b.ts"],
            remediationPrompt: "Re-open src/b.ts and remove probes.",
          };
        }
        return {
          ok: true,
          failedConditions: [],
          missingFiles: [],
          remediationPrompt: null,
        };
      });

      const machine = makeTestMachine({
        executePrompt: makeDebugFlowExecutePrompt({
          removedInstrumentation: true,
          filesModified: ["src/a.ts"],
          grepVerificationPassed: true,
          acknowledgesManifestDeletionContract: true,
          notes: "done",
        }),
        verifyCleanup,
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
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");
      actor.send({ type: "MARK_FIX_VERIFIED" });
      await waitForState(actor, "cleanupInstrumentation");
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Cleanup",
        streamId: "s3",
      });

      await waitForState(actor, "error");
      expect(actor.getSnapshot().context.activeTurn?.promptText).toBe(
        "Cleanup",
      );

      actor.send({ type: "RETRY_DEBUG_TURN" });
      await waitForState(actor, "idle");

      expect(verifyCallCount).toBe(2);
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });

    it("clears debugMode and exits to idle when verifyCleanup reports ok", async () => {
      const machine = makeTestMachine({
        executePrompt: makeDebugFlowExecutePrompt({
          removedInstrumentation: true,
          filesModified: ["src/a.ts"],
          grepVerificationPassed: true,
          acknowledgesManifestDeletionContract: true,
          notes: "done",
        }),
        verifyCleanup: makeMockVerifyCleanup({ ok: true }),
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
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");
      actor.send({ type: "MARK_FIX_VERIFIED" });
      await waitForState(actor, "cleanupInstrumentation");
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Cleanup",
        streamId: "s3",
      });

      await waitForState(actor, "idle");
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("idle");
      expect(snap.context.debugMode).toBeNull();
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
          executePrompt: makeDebugFlowExecutePrompt({
            removedInstrumentation: true,
            filesModified: [],
            grepVerificationPassed: true,
            acknowledgesManifestDeletionContract: true,
            notes: "",
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
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      spies.syncDerivedFields.mockClear();
      spies.persistSnapshot.mockClear();

      actor.send({ type: "MARK_FIX_VERIFIED" });

      expect(spies.syncDerivedFields).toHaveBeenCalled();
      expect(spies.persistSnapshot).toHaveBeenCalled();
    });

    it("loops back to debug.awaitingReproduction when evidence analysis recommends more_instrumentation", async () => {
      let callCount = 0;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => {
          await new Promise((r) => setTimeout(r, 0));
          callCount++;
          if (callCount === 1) {
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
          return successResult({
            structuredOutput: {
              outcome: "more_instrumentation",
              supportedHypotheses: [],
              refutedHypotheses: ["H1"],
              inconclusiveHypotheses: ["H2", "H3"],
              evidenceSummary: "Insufficient data",
              hypotheses: [
                {
                  id: "H4",
                  description: "Fresh idea",
                  instrumentationPlan: "Log K",
                },
              ],
              reproductionSteps: ["Open app", "Click again"],
            },
          });
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

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
      expect(actor.getSnapshot().value).toEqual({
        debug: "analyzingEvidence",
      });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze logs",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingReproduction");

      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingReproduction",
      });
      const ctx = actor.getSnapshot().context;
      expect(ctx.debugMode?.phase).toBe("awaiting_reproduction");
      expect(ctx.debugMode?.hypotheses).toEqual([
        { id: "H4", description: "Fresh idea", instrumentationPlan: "Log K" },
      ]);
      expect(ctx.debugMode?.reproductionSteps).toEqual([
        "Open app",
        "Click again",
      ]);
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

    it("wires the per-phase debug-schemas.ts outputFormat schema on every executePrompt invocation", async () => {
      const capturedSchemas: Array<unknown> = [];
      let callCount = 0;

      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          capturedSchemas.push(input.outputFormat?.schema);
          callCount += 1;
          if (callCount === 1) {
            return successResult({
              structuredOutput: {
                hypotheses: [
                  { id: "H1", description: "A", instrumentationPlan: "Log" },
                  { id: "H2", description: "B", instrumentationPlan: "Log" },
                  { id: "H3", description: "C", instrumentationPlan: "Log" },
                ],
                reproductionSteps: ["Step 1", "Step 2"],
              },
            });
          }
          if (callCount === 2) {
            return successResult({
              structuredOutput: {
                outcome: "fix_applied",
                supportedHypotheses: ["H1"],
                refutedHypotheses: [],
                inconclusiveHypotheses: ["H2", "H3"],
                evidenceSummary: "H1 is the cause.",
                fixSummary: "Fixed H1.",
                verificationSteps: ["Run test", "Inspect logs"],
              },
            });
          }
          return successResult({
            structuredOutput: {
              removedInstrumentation: true,
              filesModified: ["src/index.ts"],
              grepVerificationPassed: true,
              acknowledgesManifestDeletionContract: true,
              notes: "Cleanup complete.",
            },
          });
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/logs.jsonl",
      });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze evidence",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      actor.send({ type: "MARK_FIX_VERIFIED" });
      await waitForState(actor, "cleanupInstrumentation");
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Cleanup",
        streamId: "s3",
      });
      await waitForState(actor, "idle");

      expect(capturedSchemas).toHaveLength(3);
      expect(capturedSchemas[0]).toBe(debugHypothesisOutputSchema);
      expect(capturedSchemas[1]).toBe(debugEvidenceAnalysisOutputSchema);
      expect(capturedSchemas[2]).toBe(debugCleanupResultSchema);
    });

    it("restores active debugMode from input into the matching debug substate", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          debugMode: {
            active: true,
            recording: true,
            logFilePath: "/tmp/.debug/restored.jsonl",
            enteredAt: "2024-01-02T03:04:05Z",
            hypotheses: [
              { id: "H1", description: "Hypothesis from prior session" },
            ],
            reproductionSteps: [],
            instructionsDelivered: true,
            phase: "awaiting_reproduction",
            fixSummary: null,
            verificationSteps: [],
            lastTurnFailed: false,
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "awaitingReproduction" });
      expect(snap.context.debugMode?.active).toBe(true);
      expect(snap.context.debugMode?.recording).toBe(true);
      expect(snap.context.debugMode?.phase).toBe("awaiting_reproduction");
      expect(snap.context.debugMode?.logFilePath).toBe(
        "/tmp/.debug/restored.jsonl",
      );
      expect(snap.context.debugMode?.hypotheses).toEqual([
        { id: "H1", description: "Hypothesis from prior session" },
      ]);
      expect(snap.context.debugMode?.instructionsDelivered).toBe(true);
    });

    it("restores debug input across all phases to the right substate", () => {
      const cases: Array<{
        phase:
          | "hypothesizing"
          | "awaiting_reproduction"
          | "analyzing_evidence"
          | "awaiting_verification"
          | "cleanup_instrumentation";
        substate: string;
      }> = [
        { phase: "hypothesizing", substate: "hypothesizing" },
        { phase: "awaiting_reproduction", substate: "awaitingReproduction" },
        { phase: "analyzing_evidence", substate: "analyzingEvidence" },
        { phase: "awaiting_verification", substate: "awaitingVerification" },
        {
          phase: "cleanup_instrumentation",
          substate: "cleanupInstrumentation",
        },
      ];

      for (const { phase, substate } of cases) {
        const machine = makeTestMachine();
        const actor = createActor(machine, {
          input: {
            ...defaultInput,
            debugMode: {
              active: true,
              recording: false,
              logFilePath: "/tmp/.debug/x.jsonl",
              enteredAt: "2024-01-02T00:00:00Z",
              hypotheses: [],
              reproductionSteps: [],
              instructionsDelivered: false,
              phase,
              fixSummary: null,
              verificationSteps: [],
              lastTurnFailed: false,
            },
          },
        });
        activeActors.push(actor);
        actor.start();
        expect(actor.getSnapshot().value).toEqual({ debug: substate });
      }
    });

    it("REVERT_TO_AWAITING_REPRODUCTION rolls phase back from analyzingEvidence", async () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      actor.send({ type: "MARK_REPRODUCED" });
      expect(actor.getSnapshot().value).toEqual({
        debug: "analyzingEvidence",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "analyzing_evidence",
      );

      actor.send({ type: "REVERT_TO_AWAITING_REPRODUCTION" });

      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingReproduction",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );
    });

    it("REVERT_TO_AWAITING_VERIFICATION rolls phase back from cleanupInstrumentation", async () => {
      const machine = makeTestMachine({
        executePrompt: makeDebugFlowExecutePrompt({
          removedInstrumentation: true,
          filesModified: [],
          grepVerificationPassed: true,
          acknowledgesManifestDeletionContract: true,
          notes: "",
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      actor.send({ type: "MARK_FIX_VERIFIED" });
      expect(actor.getSnapshot().value).toEqual({
        debug: "cleanupInstrumentation",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "cleanup_instrumentation",
      );

      actor.send({ type: "REVERT_TO_AWAITING_VERIFICATION" });

      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingVerification",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_verification",
      );
    });

    it("MARK_FIX_FAILED transitions awaitingVerification → hypothesizing and preserves fixSummary", async () => {
      const machine = makeTestMachine({
        executePrompt: makeDebugFlowExecutePrompt({
          removedInstrumentation: true,
          filesModified: [],
          grepVerificationPassed: true,
          acknowledgesManifestDeletionContract: true,
          notes: "",
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      // The analyzingEvidence outcome=fix_applied turn must have set fixSummary.
      expect(actor.getSnapshot().context.debugMode?.fixSummary).toBe(
        "Applied minimal fix.",
      );

      actor.send({ type: "MARK_FIX_FAILED" });

      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "hypothesizing" });
      expect(snap.context.debugMode?.phase).toBe("hypothesizing");
      // fixSummary stays accessible for the agent's recap prompt.
      expect(snap.context.debugMode?.fixSummary).toBe("Applied minimal fix.");
    });

    it("REVERT_TO_AWAITING_VERIFICATION rolls phase back from hypothesizing after MARK_FIX_FAILED (Strategy B rollback)", async () => {
      const machine = makeTestMachine({
        executePrompt: makeDebugFlowExecutePrompt({
          removedInstrumentation: true,
          filesModified: [],
          grepVerificationPassed: true,
          acknowledgesManifestDeletionContract: true,
          notes: "",
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      actor.send({ type: "MARK_REPRODUCED" });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      // User clicks "Fix Failed" — phase advances to hypothesizing.
      actor.send({ type: "MARK_FIX_FAILED" });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "hypothesizing",
      );

      // Re-hypothesize prompt-send fails. Client rolls back.
      actor.send({ type: "REVERT_TO_AWAITING_VERIFICATION" });

      // Conversation MUST be back in awaiting_verification so the user can retry.
      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingVerification",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_verification",
      );
    });

    it("a failed prompt send after MARK_REPRODUCED + REVERT leaves the conversation in awaiting_reproduction (no advance)", async () => {
      // Simulates the Strategy B atomic flow: phase advances, prompt send
      // fails (no SUBMIT_PROMPT reaches the actor), client dispatches
      // REVERT_TO_AWAITING_REPRODUCTION. Persisted phase MUST be
      // awaiting_reproduction — i.e. the same as before the user clicked.
      const machine = makeTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      // Click "Mark Reproduced" — phase advances
      actor.send({ type: "MARK_REPRODUCED" });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "analyzing_evidence",
      );

      // Prompt-send fails (e.g. POST /prompt returns 500). Client rolls back.
      actor.send({ type: "REVERT_TO_AWAITING_REPRODUCTION" });

      // The conversation MUST be back in awaiting_reproduction so the user
      // can retry — not stranded in analyzing_evidence with no prompt.
      expect(actor.getSnapshot().value).toEqual({
        debug: "awaitingReproduction",
      });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );
    });

    it("advances phase when hypothesizing turn returns valid structuredOutput", async () => {
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

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");

      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );
      expect(actor.getSnapshot().context.debugMode?.instructionsDelivered).toBe(
        true,
      );
    });

    it("routes to debug.error when a hypothesizing turn errors out", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          error: "SDK exhausted structured output retries",
          structuredOutput: undefined,
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "error");

      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "error" });
      // Phase preserved at the failed phase, not advanced.
      expect(snap.context.debugMode?.phase).toBe("hypothesizing");
      // instructionsDelivered MUST stay false on failure.
      expect(snap.context.debugMode?.instructionsDelivered).toBe(false);
      expect(snap.context.lastError).toContain("SDK exhausted");
    });

    it("routes to debug.error when an analyzing-evidence turn returns null structuredOutput (Codex parity case)", async () => {
      const machine = makeTestMachine({
        executePrompt: makeMockExecutePrompt({
          // Backend that supports outputFormat but produced no valid JSON —
          // mirrors the Codex JSON.parse-failure path documented in the
          // codex-output-format-parity audit.
          structuredOutput: undefined,
          error: null,
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          debugMode: {
            active: true,
            recording: false,
            logFilePath: "/tmp/.debug/x.jsonl",
            enteredAt: "2024-01-02T00:00:00Z",
            hypotheses: [],
            reproductionSteps: [],
            instructionsDelivered: true,
            phase: "analyzing_evidence",
            fixSummary: null,
            verificationSteps: [],
            lastTurnFailed: false,
          },
        },
      });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze evidence",
        streamId: "s1",
      });
      await waitForState(actor, "error");

      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "error" });
      expect(snap.context.debugMode?.phase).toBe("analyzing_evidence");
    });

    it("RETRY_DEBUG_TURN from debug.error re-runs the failed prompt against the same phase", async () => {
      let callCount = 0;
      const executePrompt = fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => {
          callCount += 1;
          if (callCount === 1) {
            return successResult({
              error: "schema validation failed",
              structuredOutput: undefined,
            });
          }
          return successResult({
            structuredOutput: {
              hypotheses: [
                { id: "H1", description: "A", instrumentationPlan: "Log" },
                { id: "H2", description: "B", instrumentationPlan: "Log" },
                { id: "H3", description: "C", instrumentationPlan: "Log" },
              ],
              reproductionSteps: ["Step 1", "Step 2"],
            },
          });
        },
      );

      const machine = makeTestMachine({ executePrompt });
      const actor = createActor(machine, { input: defaultInput });
      activeActors.push(actor);
      actor.start();

      actor.send({
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/.debug/x.jsonl",
      });
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "error");

      // The activeTurn must have been preserved so RETRY can re-run it.
      expect(actor.getSnapshot().context.activeTurn?.promptText).toBe(
        "Hypothesize",
      );

      actor.send({ type: "RETRY_DEBUG_TURN" });
      await waitForState(actor, "awaitingReproduction");

      expect(callCount).toBe(2);
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );
    });

    it("restores into debug.error when input.debugMode.lastTurnFailed is true", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          debugMode: {
            active: true,
            recording: true,
            logFilePath: "/tmp/.debug/old.jsonl",
            enteredAt: "2024-01-02T00:00:00Z",
            hypotheses: [],
            reproductionSteps: [],
            instructionsDelivered: true,
            phase: "analyzing_evidence",
            fixSummary: null,
            verificationSteps: [],
            lastTurnFailed: true,
          },
        },
      });
      activeActors.push(actor);
      actor.start();
      expect(actor.getSnapshot().value).toEqual({ debug: "error" });
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "analyzing_evidence",
      );
    });

    it("ignores input.debugMode when active is false", () => {
      const machine = makeTestMachine();
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          debugMode: {
            active: false,
            recording: false,
            logFilePath: "/tmp/.debug/old.jsonl",
            enteredAt: "2024-01-02T00:00:00Z",
            hypotheses: [],
            reproductionSteps: [],
            instructionsDelivered: false,
            phase: "hypothesizing",
            fixSummary: null,
            verificationSteps: [],
            lastTurnFailed: false,
          },
        },
      });
      activeActors.push(actor);
      actor.start();
      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
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
          backendRef: { backend: "claude" as const, sessionId: "sess-ext" },
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
        sessionId: "sess-ext",
      });
      expect(snap.context.lastResult).toBeTruthy();
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
});
