/**
 * Tests for the debug adapter — the single seam around debug-mode operations.
 *
 * These tests verify three things:
 *  1. Schema selection: the adapter returns the correct JSON schema for each
 *     debug phase, and undefined for phases that do not produce structured
 *     output.
 *  2. Status emission: debug status events flow through the StatusBus
 *     (envelope `scope === "debug"`) so the existing UI listeners keep
 *     receiving the same SSE payload.
 *  3. Phase transitions: driving a real conversation actor through a full
 *     debug session via adapter calls produces the same observable behavior
 *     (final state, debugMode field, status events) as direct event sends.
 *
 * The adapter does not replace the conversation state machine — it provides
 * one place to extend or audit debug-specific behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, type AnyActorRef } from "xstate";
import { conversationMachine } from "./machine";
import {
  createDebugAdapter,
  getDefaultDebugAdapter,
  _resetDefaultDebugAdapterForTesting,
} from "./debug-adapter";
import {
  debugHypothesisOutputSchema,
  debugEvidenceAnalysisOutputSchema,
  debugCleanupResultSchema,
} from "./debug-schemas";
import {
  setDefaultSessionStatusBusBroadcastForTesting,
  subscribeSessionStatus,
  _resetDefaultSessionStatusBusForTesting,
} from "@/lib/workflows/primitives/default-session-status-bus";
import type { StatusBusEnvelope } from "@/lib/workflows/primitives/status-bus";
import type {
  ConversationInput,
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
  VerifyCleanupInput,
  VerifyCleanupOutput,
} from "./types";
import type { SSEEvent } from "@/lib/api/sse-events";
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
  conversationId: "conv-debug",
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
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    contentBlocks: [{ type: "text", text: "Hello" }],
    aborted: false,
    compacted: false,
    error: null,
    ...overrides,
  };
}

function makeMockPrepareTurn() {
  return fromPromise<PrepareTurnOutput, PrepareTurnInput>(async () => {
    await new Promise((r) => setTimeout(r, 0));
    return { transcriptPath: "/tmp/transcript.jsonl" };
  });
}

function makeMockExecutePrompt(result?: Partial<PromptActorResult>) {
  return fromPromise<PromptActorResult, ExecutePromptInput>(async () => {
    await new Promise((r) => setTimeout(r, 0));
    return successResult(result);
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

describe("debug adapter", () => {
  describe("resolveOutputFormat", () => {
    const adapter = createDebugAdapter();

    it("returns the hypothesis schema during the hypothesizing phase", () => {
      expect(adapter.resolveOutputFormat("hypothesizing")).toEqual({
        type: "json_schema",
        schema: debugHypothesisOutputSchema,
      });
    });

    it("returns the evidence-analysis schema during the analyzing_evidence phase", () => {
      expect(adapter.resolveOutputFormat("analyzing_evidence")).toEqual({
        type: "json_schema",
        schema: debugEvidenceAnalysisOutputSchema,
      });
    });

    it("returns the cleanup-result schema during the cleanup_instrumentation phase", () => {
      expect(adapter.resolveOutputFormat("cleanup_instrumentation")).toEqual({
        type: "json_schema",
        schema: debugCleanupResultSchema,
      });
    });

    it("returns undefined for awaiting phases (no structured output expected)", () => {
      expect(
        adapter.resolveOutputFormat("awaiting_reproduction"),
      ).toBeUndefined();
      expect(
        adapter.resolveOutputFormat("awaiting_verification"),
      ).toBeUndefined();
    });

    it("returns undefined when no debug phase is active", () => {
      expect(adapter.resolveOutputFormat(null)).toBeUndefined();
      expect(adapter.resolveOutputFormat(undefined)).toBeUndefined();
    });

    it("returns the same wrapper reference across calls for the same phase", () => {
      // shouldRecreateRuntime compares outputFormat by reference; a new wrapper
      // each call would churn the backend runtime even when the phase is
      // unchanged.
      const a = adapter.resolveOutputFormat("hypothesizing");
      const b = adapter.resolveOutputFormat("hypothesizing");
      expect(a).toBeDefined();
      expect(b).toBe(a);
    });

    it("returns distinct wrappers for distinct phases", () => {
      const hyp = adapter.resolveOutputFormat("hypothesizing");
      const cleanup = adapter.resolveOutputFormat("cleanup_instrumentation");
      expect(hyp).not.toBe(cleanup);
    });
  });

  describe("status emission through StatusBus", () => {
    let wire: ReturnType<typeof vi.fn<(event: SSEEvent) => void>>;
    let envelopes: StatusBusEnvelope[];
    let unsubscribe: () => void;

    beforeEach(() => {
      _resetDefaultSessionStatusBusForTesting();
      _resetDefaultDebugAdapterForTesting();
      wire = vi.fn<(event: SSEEvent) => void>();
      setDefaultSessionStatusBusBroadcastForTesting(wire);
      envelopes = [];
      unsubscribe = subscribeSessionStatus((envelope) => {
        envelopes.push(envelope);
      });
    });

    afterEach(() => {
      unsubscribe();
      _resetDefaultSessionStatusBusForTesting();
      _resetDefaultDebugAdapterForTesting();
    });

    it("publishDebugModeStatus emits a debug-mode-status SSE event with the debug scope envelope", () => {
      const adapter = getDefaultDebugAdapter();
      const outcome = adapter.publishDebugModeStatus({
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-debug-1",
        active: true,
        recording: false,
      });

      expect(outcome.delivered).toBe(true);
      expect(wire.mock.calls[0]?.[0]).toEqual({
        type: "debug-mode-status",
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-debug-1",
        active: true,
        recording: false,
      });
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]?.scope).toBe("debug");
      expect(envelopes[0]?.scopeId).toBe("conv-debug-1");
      expect(envelopes[0]?.status).toBe("running");
    });

    it("publishDebugLogReceived emits a debug-log-received SSE event with the debug scope envelope", () => {
      const adapter = getDefaultDebugAdapter();
      const outcome = adapter.publishDebugLogReceived({
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-debug-1",
        entryCount: 7,
      });

      expect(outcome.delivered).toBe(true);
      expect(wire.mock.calls[0]?.[0]).toEqual({
        type: "debug-log-received",
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-debug-1",
        entryCount: 7,
      });
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]?.scope).toBe("debug");
      expect(envelopes[0]?.scopeId).toBe("conv-debug-1");
    });

    it("respects an injected publish dependency for testing", () => {
      const customPublish = vi.fn(() => ({ delivered: true }));
      const adapter = createDebugAdapter({ publishSSE: customPublish });
      adapter.publishDebugModeStatus({
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-x",
        active: true,
        recording: true,
      });
      expect(customPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "debug-mode-status",
          conversationId: "conv-x",
          recording: true,
        }),
      );
    });
  });

  describe("phase transition dispatch", () => {
    it("dispatches ENTER_DEBUG_MODE / EXIT_DEBUG_MODE / MARK_REPRODUCED / MARK_FIX_VERIFIED / SET_DEBUG_RECORDING / CLEAR_DEBUG_LOGS through the injected sender", () => {
      const sent: Array<{
        projectPath: string;
        sessionName: string;
        conversationId: string;
        event: unknown;
      }> = [];
      const adapter = createDebugAdapter({
        sendConversationEvent: (
          projectPath,
          sessionName,
          conversationId,
          event,
        ) => {
          sent.push({ projectPath, sessionName, conversationId, event });
          return true;
        },
      });

      const target = {
        projectPath: "/repo",
        sessionName: "sess",
        conversationId: "conv-1",
      };

      adapter.enterDebugMode(target, { logFilePath: "/tmp/logs.jsonl" });
      adapter.markReproduced(target);
      adapter.markFixVerified(target);
      adapter.setRecording(target, true);
      adapter.clearDebugLogs(target);
      adapter.exitDebugMode(target);

      expect(sent.map((s) => s.event)).toEqual([
        { type: "ENTER_DEBUG_MODE", logFilePath: "/tmp/logs.jsonl" },
        { type: "MARK_REPRODUCED" },
        { type: "MARK_FIX_VERIFIED" },
        { type: "SET_DEBUG_RECORDING", recording: true },
        { type: "CLEAR_DEBUG_LOGS" },
        { type: "EXIT_DEBUG_MODE" },
      ]);
      for (const s of sent) {
        expect(s.projectPath).toBe(target.projectPath);
        expect(s.sessionName).toBe(target.sessionName);
        expect(s.conversationId).toBe(target.conversationId);
      }
    });
  });

  describe("full debug session lifecycle drives the conversation actor with same observable behavior as direct event sends", () => {
    it("drives ENTER_DEBUG_MODE → submit → MARK_REPRODUCED → submit (fix_applied) → MARK_FIX_VERIFIED → submit cleanup → idle, and the captured outputFormat schemas match the adapter's resolveOutputFormat for each phase", async () => {
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

      const sentEvents: unknown[] = [];
      const adapter = createDebugAdapter({
        sendConversationEvent: (_p, _s, _c, event) => {
          sentEvents.push(event);
          actor.send(event as never);
          return true;
        },
      });

      const target = {
        projectPath: defaultInput.projectPath,
        sessionName: defaultInput.sessionName,
        conversationId: defaultInput.conversationId,
      };

      adapter.enterDebugMode(target, { logFilePath: "/tmp/.debug/logs.jsonl" });
      expect(actor.getSnapshot().value).toEqual({ debug: "hypothesizing" });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Hypothesize",
        streamId: "s1",
      });
      await waitForState(actor, "awaitingReproduction");
      expect(actor.getSnapshot().context.debugMode?.phase).toBe(
        "awaiting_reproduction",
      );

      adapter.markReproduced(target);
      expect(actor.getSnapshot().value).toEqual({ debug: "analyzingEvidence" });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Analyze evidence",
        streamId: "s2",
      });
      await waitForState(actor, "awaitingVerification");

      adapter.markFixVerified(target);
      expect(actor.getSnapshot().value).toEqual({
        debug: "cleanupInstrumentation",
      });

      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Cleanup",
        streamId: "s3",
      });
      await waitForState(actor, "idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();

      expect(capturedSchemas).toHaveLength(3);
      expect(capturedSchemas[0]).toBe(
        adapter.resolveOutputFormat("hypothesizing")!.schema,
      );
      expect(capturedSchemas[1]).toBe(
        adapter.resolveOutputFormat("analyzing_evidence")!.schema,
      );
      expect(capturedSchemas[2]).toBe(
        adapter.resolveOutputFormat("cleanup_instrumentation")!.schema,
      );

      expect(sentEvents).toEqual([
        { type: "ENTER_DEBUG_MODE", logFilePath: "/tmp/.debug/logs.jsonl" },
        { type: "MARK_REPRODUCED" },
        { type: "MARK_FIX_VERIFIED" },
      ]);
    });
  });

  describe("markFixFailed", () => {
    it("dispatches a MARK_FIX_FAILED event to the conversation actor", () => {
      const sent: Array<{
        projectPath: string;
        sessionName: string;
        conversationId: string;
        event: unknown;
      }> = [];
      const adapter = createDebugAdapter({
        sendConversationEvent: (
          projectPath,
          sessionName,
          conversationId,
          event,
        ) => {
          sent.push({ projectPath, sessionName, conversationId, event });
          return true;
        },
      });
      const target = {
        projectPath: "/repo",
        sessionName: "sess",
        conversationId: "conv-1",
      };
      const dispatched = adapter.markFixFailed(target);
      expect(dispatched).toBe(true);
      expect(sent).toEqual([
        {
          projectPath: "/repo",
          sessionName: "sess",
          conversationId: "conv-1",
          event: { type: "MARK_FIX_FAILED" },
        },
      ]);
    });
  });
});
