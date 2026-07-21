/**
 * Debug workflow external-interface parity suite (Phase 2.3 pin).
 *
 * Pins the debug-mode contract at its production seams — the `DebugAdapter`
 * methods that API routes call, the conversation context fields that
 * `syncDerivedFields` projects into `ConversationState` (`debugMode`,
 * `status`, `lastError`, `activeTurn`), the per-phase structured-output
 * format handed to `executePrompt`, and the settle-point queue-drain policy —
 * WITHOUT asserting machine state values. The debug eviction from the
 * conversation machine into `src/lib/workflows/debug/` must keep every test
 * here green; only the `makeHarness` wiring may change shape.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createActor, fromPromise, waitFor, type AnyActorRef } from "xstate";
import { conversationMachine } from "@/lib/workflows/conversation/machine";
import {
  createDebugAdapter,
  type DebugAdapter,
} from "@/lib/workflows/conversation/debug-adapter";
import { runDebugCleanupVerification } from "./cleanup-verification";
import type {
  ConversationInput,
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
  VerifyCleanupOutput,
} from "@/lib/workflows/conversation/types";

// ============================================================
// Result payload fixtures
// ============================================================

const HYPOTHESIS_PAYLOAD = {
  hypotheses: [
    { id: "H1", description: "A", instrumentationPlan: "Log" },
    { id: "H2", description: "B", instrumentationPlan: "Log" },
    { id: "H3", description: "C", instrumentationPlan: "Log" },
  ],
  reproductionSteps: ["Step 1", "Step 2"],
};

const FIX_APPLIED_PAYLOAD = {
  outcome: "fix_applied",
  supportedHypotheses: ["H1"],
  refutedHypotheses: [],
  inconclusiveHypotheses: ["H2"],
  evidenceSummary: "H1 confirmed.",
  fixSummary: "Applied minimal fix.",
  verificationSteps: ["Run failing test"],
};

const MORE_INSTRUMENTATION_PAYLOAD = {
  outcome: "more_instrumentation",
  supportedHypotheses: [],
  refutedHypotheses: ["H1"],
  inconclusiveHypotheses: ["H2"],
  evidenceSummary: "Inconclusive.",
  hypotheses: [{ id: "H4", description: "D", instrumentationPlan: "Trace" }],
  reproductionSteps: ["Step A"],
};

const CLEANUP_PAYLOAD = {
  removedInstrumentation: true,
  filesModified: ["src/a.ts"],
  grepVerificationPassed: true,
  acknowledgesManifestDeletionContract: true,
  notes: "All probes removed.",
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
    structuredOutput: {},
    ...overrides,
  };
}

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
  agentBackend: "claude",
  backendRef: null,
  promptCount: 0,
  persistence: "durable",
};

const TARGET = {
  projectPath: defaultInput.projectPath,
  sessionName: defaultInput.sessionName,
  conversationId: defaultInput.conversationId,
};

// ============================================================
// Harness — the ONLY part of this file allowed to change with
// the debug eviction refactor.
// ============================================================

interface Harness {
  actor: AnyActorRef;
  adapter: DebugAdapter;
  executedInputs: ExecutePromptInput[];
  drainCalls: () => number;
  debugModeStatusBroadcasts: () => number;
  send(event: Record<string, unknown>): void;
  ctx(): {
    debugMode: {
      active: boolean;
      recording: boolean;
      logFilePath: string;
      hypotheses: Array<{ id: string }>;
      reproductionSteps: string[];
      fixSummary: string | null;
      verificationSteps: string[];
      instructionsDelivered: boolean;
      phase: string;
      lastTurnFailed: boolean;
    } | null;
    status: string;
    lastError: string | null;
    activeTurn: { kind: string; promptText: string } | null;
    promptCount: number;
    pendingQuestion: unknown;
  };
  settled(): Promise<void>;
}

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

function makeHarness(opts: {
  turnResults: Array<Partial<PromptActorResult>>;
  cleanupVerify?: Partial<VerifyCleanupOutput>;
  /** Overrides the verifier wholesale, e.g. with deferred promises the test
   *  resolves out of order. */
  verifyCleanup?: () => Promise<VerifyCleanupOutput>;
  input?: Partial<ConversationInput>;
}): Harness {
  const executedInputs: ExecutePromptInput[] = [];
  let turnIndex = 0;
  const drainSpy = vi.fn();
  const debugModeStatusSpy = vi.fn();

  const fakeVerifyCleanup =
    opts.verifyCleanup ??
    (async (): Promise<VerifyCleanupOutput> => {
      await new Promise((r) => setTimeout(r, 0));
      return {
        ok: true,
        failedConditions: [],
        missingFiles: [],
        remediationPrompt: null,
        ...opts.cleanupVerify,
      };
    });

  const machine = conversationMachine.provide({
    actors: {
      prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
        async () => ({ transcriptPath: "/tmp/transcript.jsonl" }),
      ),
      executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
        async ({ input }) => {
          executedInputs.push(input);
          const result = opts.turnResults[turnIndex] ?? {};
          turnIndex = Math.min(turnIndex + 1, opts.turnResults.length - 1);
          await new Promise((r) => setTimeout(r, 0));
          return successResult(result);
        },
      ),
    },
    actions: {
      persistSnapshot: () => {},
      syncDerivedFields: () => {},
      broadcastConversationStatus: () => {},
      broadcastAskQuestion: () => {},
      broadcastDebugModeStatus: debugModeStatusSpy,
      releaseResources: () => {},
      dispatchPushNotification: () => {},
      markUnreadOnFinish: () => {},
      markReadOnUserTurnStart: () => {},
      drainPendingQueue: drainSpy,
      // Production wiring with a fake verifier: the real runner + reducer
      // still process the outcome.
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
    },
  });

  const actor = createActor(machine, {
    input: { ...defaultInput, ...opts.input },
  });
  activeActors.push(actor);

  const adapter = createDebugAdapter({
    sendConversationEvent: (_p, _s, _c, event) => {
      actor.send(event);
      return true;
    },
    publishSSE: () => ({ delivered: true, subscriberCount: 1 }),
  });

  actor.start();

  return {
    actor,
    adapter,
    executedInputs,
    drainCalls: () => drainSpy.mock.calls.length,
    debugModeStatusBroadcasts: () => debugModeStatusSpy.mock.calls.length,
    send: (event) => actor.send(event as never),
    ctx: () => {
      const snapshot = actor.getSnapshot() as {
        context: ReturnType<Harness["ctx"]>;
      };
      return snapshot.context;
    },
    settled: async () => {
      await waitFor(
        actor,
        (s) => {
          const value = (s as { value: unknown }).value;
          const flat =
            typeof value === "string" ? value : JSON.stringify(value);
          return (
            !flat.includes("acquiringResources") && !flat.includes("executing")
          );
        },
        { timeout: 3000 },
      );
      // Let same-tick side effects (async verification round-trip) land.
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

function submitPrompt(h: Harness, promptText: string): void {
  h.send({ type: "SUBMIT_PROMPT", promptText, streamId: "stream-1" });
}

/** Verifier whose promises the test resolves explicitly (and out of order),
 *  to pin how the machine treats verification results from superseded
 *  cleanup attempts. */
function deferredVerifier() {
  const pending: Array<(output: VerifyCleanupOutput) => void> = [];
  return {
    verifyCleanup: () =>
      new Promise<VerifyCleanupOutput>((resolvePromise) => {
        pending.push(resolvePromise);
      }),
    resolve(index: number, output: Partial<VerifyCleanupOutput>) {
      pending[index]!({
        ok: true,
        failedConditions: [],
        missingFiles: [],
        remediationPrompt: null,
        ...output,
      });
    },
    calls: () => pending.length,
  };
}

function makeCleanupHarness(
  verifier: ReturnType<typeof deferredVerifier>,
): Harness {
  return makeHarness({
    turnResults: [
      { structuredOutput: HYPOTHESIS_PAYLOAD },
      { structuredOutput: FIX_APPLIED_PAYLOAD },
      { structuredOutput: CLEANUP_PAYLOAD },
    ],
    verifyCleanup: verifier.verifyCleanup,
  });
}

async function advanceToCleanupPhase(h: Harness): Promise<void> {
  h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
  submitPrompt(h, "Investigate");
  await h.settled();
  h.adapter.markReproduced(TARGET);
  submitPrompt(h, "Analyze");
  await h.settled();
  h.adapter.markFixVerified(TARGET);
  expect(h.ctx().debugMode?.phase).toBe("cleanup_instrumentation");
}

// ============================================================
// Tests — externally observable debug contract
// ============================================================

describe("debug workflow parity (external interface)", () => {
  it("enterDebugMode initializes debugMode context and broadcasts debug-mode status", () => {
    const h = makeHarness({ turnResults: [{}] });

    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/.debug/logs.jsonl" });

    const ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      active: true,
      recording: true,
      logFilePath: "/tmp/.debug/logs.jsonl",
      phase: "hypothesizing",
      lastTurnFailed: false,
      instructionsDelivered: false,
      hypotheses: [],
    });
    expect(h.debugModeStatusBroadcasts()).toBe(1);
  });

  it("exitDebugMode clears debugMode and broadcasts", () => {
    const h = makeHarness({ turnResults: [{}] });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    h.adapter.exitDebugMode(TARGET);

    expect(h.ctx().debugMode).toBeNull();
    expect(h.debugModeStatusBroadcasts()).toBe(2);
  });

  it("hypothesizing turn with valid structured output advances to awaiting_reproduction and persists hypotheses", async () => {
    const h = makeHarness({
      turnResults: [{ structuredOutput: HYPOTHESIS_PAYLOAD }],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    submitPrompt(h, "Investigate the bug");
    await h.settled();

    const ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      active: true,
      phase: "awaiting_reproduction",
      instructionsDelivered: true,
      reproductionSteps: ["Step 1", "Step 2"],
      lastTurnFailed: false,
    });
    expect(ctx.debugMode?.hypotheses.map((hh) => hh.id)).toEqual([
      "H1",
      "H2",
      "H3",
    ]);
    expect(ctx.status).toBe("awaiting");
    expect(ctx.activeTurn).toBeNull();
    expect(ctx.promptCount).toBe(1);
  });

  it("wires the phase-specific outputFormat schema into executePrompt", async () => {
    const h = makeHarness({
      turnResults: [{ structuredOutput: HYPOTHESIS_PAYLOAD }],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    submitPrompt(h, "Investigate");
    await h.settled();

    expect(h.executedInputs).toHaveLength(1);
    // Deep equality, not identity: the machine resolves through the default
    // adapter singleton while the harness holds its own injected instance.
    expect(h.executedInputs[0]!.outputFormat).toStrictEqual(
      h.adapter.resolveOutputFormat("hypothesizing"),
    );
  });

  it("markReproduced advances awaiting_reproduction → analyzing_evidence; illegal in other phases", async () => {
    const h = makeHarness({
      turnResults: [{ structuredOutput: HYPOTHESIS_PAYLOAD }],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    // Illegal in hypothesizing — ignored.
    h.adapter.markReproduced(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("hypothesizing");

    submitPrompt(h, "Investigate");
    await h.settled();
    expect(h.ctx().debugMode?.phase).toBe("awaiting_reproduction");

    h.adapter.markReproduced(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("analyzing_evidence");
  });

  it("analyzing turn with outcome=fix_applied advances to awaiting_verification with fix details", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: FIX_APPLIED_PAYLOAD },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);

    submitPrompt(h, "Analyze evidence");
    await h.settled();

    expect(h.ctx().debugMode).toMatchObject({
      phase: "awaiting_verification",
      fixSummary: "Applied minimal fix.",
      verificationSteps: ["Run failing test"],
    });
  });

  it("analyzing turn with outcome=more_instrumentation loops back to awaiting_reproduction and clears prior fix data", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: MORE_INSTRUMENTATION_PAYLOAD },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);

    submitPrompt(h, "Analyze evidence");
    await h.settled();

    const dm = h.ctx().debugMode;
    expect(dm).toMatchObject({
      phase: "awaiting_reproduction",
      fixSummary: null,
      verificationSteps: [],
    });
    expect(dm?.hypotheses.map((hh) => hh.id)).toEqual(["H4"]);
    expect(dm?.reproductionSteps).toEqual(["Step A"]);
  });

  it("markFixVerified advances to cleanup_instrumentation; cleanup turn + passing verification exits debug mode", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: FIX_APPLIED_PAYLOAD },
        { structuredOutput: CLEANUP_PAYLOAD },
      ],
      cleanupVerify: { ok: true },
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);
    submitPrompt(h, "Analyze");
    await h.settled();
    h.adapter.markFixVerified(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("cleanup_instrumentation");

    submitPrompt(h, "Clean up instrumentation");
    await h.settled();

    const ctx = h.ctx();
    expect(ctx.debugMode).toBeNull();
    expect(ctx.activeTurn).toBeNull();
    expect(ctx.status).toBe("awaiting");
  });

  it("cleanup verification failure preserves debug mode with the remediation prompt as lastError and marks the turn failed", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: FIX_APPLIED_PAYLOAD },
        { structuredOutput: CLEANUP_PAYLOAD },
      ],
      cleanupVerify: {
        ok: false,
        remediationPrompt: "Probe P1 still present in src/a.ts",
      },
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);
    submitPrompt(h, "Analyze");
    await h.settled();
    h.adapter.markFixVerified(TARGET);

    submitPrompt(h, "Clean up instrumentation");
    await h.settled();

    const ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      active: true,
      phase: "cleanup_instrumentation",
      lastTurnFailed: true,
    });
    expect(ctx.lastError).toBe("Probe P1 still present in src/a.ts");
    // activeTurn preserved so retryDebugTurn can re-run the cleanup prompt.
    expect(ctx.activeTurn).toMatchObject({
      promptText: "Clean up instrumentation",
    });
  });

  it("a stale passing verification from a superseded cleanup attempt does not exit debug mode; the current attempt still completes", async () => {
    const verifier = deferredVerifier();
    const h = makeCleanupHarness(verifier);
    await advanceToCleanupPhase(h);

    submitPrompt(h, "Clean up attempt A");
    await h.settled();
    expect(verifier.calls()).toBe(1);

    // Attempt A's verification is still pending; the user supersedes it.
    submitPrompt(h, "Clean up attempt B");
    await h.settled();
    expect(verifier.calls()).toBe(2);

    // A's verification resolves late — after B superseded it. Its passing
    // result must not exit debug mode on B's behalf.
    verifier.resolve(0, { ok: true });
    await h.settled();
    let ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      active: true,
      phase: "cleanup_instrumentation",
    });
    expect(ctx.activeTurn).toMatchObject({
      promptText: "Clean up attempt B",
    });

    // The current attempt's own verification still completes the workflow.
    verifier.resolve(1, { ok: true });
    await h.settled();
    ctx = h.ctx();
    expect(ctx.debugMode).toBeNull();
    expect(ctx.activeTurn).toBeNull();
  });

  it("a stale failed verification from a superseded cleanup attempt does not fail the current attempt", async () => {
    const verifier = deferredVerifier();
    const h = makeCleanupHarness(verifier);
    await advanceToCleanupPhase(h);

    submitPrompt(h, "Clean up attempt A");
    await h.settled();
    submitPrompt(h, "Clean up attempt B");
    await h.settled();

    verifier.resolve(0, {
      ok: false,
      remediationPrompt: "stale remediation for attempt A",
    });
    await h.settled();
    const ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      active: true,
      phase: "cleanup_instrumentation",
      lastTurnFailed: false,
    });
    expect(ctx.lastError).not.toBe("stale remediation for attempt A");

    verifier.resolve(1, { ok: true });
    await h.settled();
    expect(h.ctx().debugMode).toBeNull();
  });

  it("a failed phase-advancing turn marks lastTurnFailed and preserves phase + activeTurn; retryDebugTurn re-runs it", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: undefined },
        { structuredOutput: HYPOTHESIS_PAYLOAD },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    submitPrompt(h, "Investigate");
    await h.settled();

    let ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      phase: "hypothesizing",
      lastTurnFailed: true,
    });
    expect(ctx.lastError).toBe(
      "Turn did not produce a valid structured response",
    );
    expect(ctx.activeTurn).toMatchObject({ promptText: "Investigate" });

    h.adapter.retryDebugTurn(TARGET);
    await h.settled();

    ctx = h.ctx();
    expect(h.executedInputs).toHaveLength(2);
    expect(h.executedInputs[1]!.promptText).toBe("Investigate");
    expect(ctx.debugMode).toMatchObject({
      phase: "awaiting_reproduction",
      lastTurnFailed: false,
    });
  });

  it("a fresh SUBMIT_PROMPT from the failed state replaces the failed turn and clears lastTurnFailed", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: undefined },
        { structuredOutput: HYPOTHESIS_PAYLOAD },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    expect(h.ctx().debugMode?.lastTurnFailed).toBe(true);

    submitPrompt(h, "Try a different angle");
    await h.settled();

    const ctx = h.ctx();
    expect(h.executedInputs[1]!.promptText).toBe("Try a different angle");
    expect(ctx.debugMode).toMatchObject({
      phase: "awaiting_reproduction",
      lastTurnFailed: false,
    });
  });

  it("markFixFailed loops awaiting_verification → hypothesizing, preserving fixSummary and clearing verificationSteps", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: FIX_APPLIED_PAYLOAD },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);
    submitPrompt(h, "Analyze");
    await h.settled();

    h.adapter.markFixFailed(TARGET);

    expect(h.ctx().debugMode).toMatchObject({
      phase: "hypothesizing",
      fixSummary: "Applied minimal fix.",
      verificationSteps: [],
    });
  });

  it("revertToAwaitingReproduction and revertToAwaitingVerification roll phases back (Strategy B)", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: FIX_APPLIED_PAYLOAD },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("analyzing_evidence");

    h.adapter.revertToAwaitingReproduction(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("awaiting_reproduction");

    h.adapter.markReproduced(TARGET);
    submitPrompt(h, "Analyze");
    await h.settled();
    h.adapter.markFixVerified(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("cleanup_instrumentation");

    h.adapter.revertToAwaitingVerification(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("awaiting_verification");

    // From hypothesizing (after markFixFailed) revert restores verification.
    h.adapter.markFixFailed(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("hypothesizing");
    h.adapter.revertToAwaitingVerification(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("awaiting_verification");
  });

  it("follow-up prompts in waiting phases settle back to the same phase without notifications", async () => {
    const h = makeHarness({
      turnResults: [
        { structuredOutput: HYPOTHESIS_PAYLOAD },
        { structuredOutput: undefined },
      ],
    });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    expect(h.ctx().debugMode?.phase).toBe("awaiting_reproduction");

    submitPrompt(h, "A follow-up question");
    await h.settled();

    const ctx = h.ctx();
    expect(ctx.debugMode).toMatchObject({
      phase: "awaiting_reproduction",
      lastTurnFailed: false,
    });
    expect(ctx.activeTurn).toBeNull();
    expect(ctx.promptCount).toBe(2);
  });

  it("setRecording toggles the flag and broadcasts each time", () => {
    const h = makeHarness({ turnResults: [{}] });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    h.adapter.setRecording(TARGET, false);
    expect(h.ctx().debugMode?.recording).toBe(false);
    h.adapter.setRecording(TARGET, true);
    expect(h.ctx().debugMode?.recording).toBe(true);
    // enter + 2 recording toggles
    expect(h.debugModeStatusBroadcasts()).toBe(3);
  });

  it("ignores SUBMIT_TASK_RUN while debug mode is active", () => {
    const h = makeHarness({ turnResults: [{}] });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    h.send({ type: "SUBMIT_TASK_RUN", promptText: "run task" });

    expect(h.ctx().activeTurn).toBeNull();
    expect(h.ctx().status).not.toBe("running");
  });

  it("ignores EXTERNAL_TURN_STARTED while debug mode is active", () => {
    const h = makeHarness({ turnResults: [{}] });
    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });

    h.send({ type: "EXTERNAL_TURN_STARTED" });

    expect(h.ctx().status).not.toBe("running");
  });

  it("does not drain the pending queue at debug-phase settle points; drains again only on exit", async () => {
    const h = makeHarness({
      turnResults: [{ structuredOutput: HYPOTHESIS_PAYLOAD }],
    });
    // Startup idle entry drains once.
    expect(h.drainCalls()).toBe(1);

    h.adapter.enterDebugMode(TARGET, { logFilePath: "/tmp/logs.jsonl" });
    submitPrompt(h, "Investigate");
    await h.settled();
    h.adapter.markReproduced(TARGET);
    // No settle-point drain fired while debug mode was active.
    expect(h.drainCalls()).toBe(1);

    h.adapter.exitDebugMode(TARGET);
    expect(h.drainCalls()).toBe(2);
  });

  it("restores persisted debugMode from input and keeps operating in the restored phase", () => {
    const h = makeHarness({
      turnResults: [{}],
      input: {
        promptCount: 3,
        debugMode: {
          active: true,
          recording: true,
          logFilePath: "/tmp/logs.jsonl",
          enteredAt: "2024-01-01T00:00:00Z",
          hypotheses: [
            { id: "H1", description: "A", instrumentationPlan: "Log" },
          ],
          reproductionSteps: ["Step 1"],
          fixSummary: null,
          verificationSteps: [],
          instructionsDelivered: true,
          phase: "awaiting_reproduction",
          lastTurnFailed: false,
        },
      },
    });

    expect(h.ctx().debugMode?.phase).toBe("awaiting_reproduction");
    h.adapter.markReproduced(TARGET);
    expect(h.ctx().debugMode?.phase).toBe("analyzing_evidence");
  });

  it("adapter methods are ignored when debug mode is not active", () => {
    const h = makeHarness({ turnResults: [{}] });

    h.adapter.markReproduced(TARGET);
    h.adapter.markFixVerified(TARGET);
    h.adapter.exitDebugMode(TARGET);
    h.adapter.setRecording(TARGET, false);

    expect(h.ctx().debugMode).toBeNull();
    expect(h.ctx().status).toBe("new");
  });
});
