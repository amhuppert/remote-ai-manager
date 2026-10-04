import { describe, expect, it } from "vitest";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import type { TurnExecutionOutcome } from "@/lib/workflows/conversation/turn-result";
import type { DebugModePhase, DebugModeState } from "@/lib/debug-log/schemas";
import {
  applyBackendAdoption,
  applyClaimEnded,
  applyDebugCommandToRow,
  applyQuestionAsked,
  applyQuestionCleared,
  applyQuestionWithdrawn,
  applyTurnBegin,
  applyTurnClaimed,
  applyTurnInterrupted,
  applyTurnSettlement,
  conversationHoldRefusal,
  settlementOf,
  type ConversationRow,
} from "./conversation-record";

function outcomeOf(execution: ReturnType<typeof settledConversationTurn>): TurnExecutionOutcome {
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

const row = (): ConversationRow => ({
  status: "running",
  activeTurnSource: "workflow",
  promptCount: 2,
  lastActivityAt: "2026-10-03T09:00:00.000Z",
  backendRef: { backend: "claude", ref: "sdk-1" },
  totalCostUsd: 1.5,
  totalDurationMs: 1000,
  totalTurns: 4,
  contextTokens: 900,
  contextWindowMax: 200000,
  unread: false,
  pendingQuestionId: null,
  pendingQuestions: null,
  agentBackend: "claude",
  debugMode: null,
  turnGeneration: 3,
});

describe("conversation record", () => {
  it("accounts a settled turn: totals, newest continuity, idle status", () => {
    const settlement = settlementOf(
      outcomeOf(
        settledConversationTurn({
          backendRef: { backend: "claude", ref: "sdk-2" },
          usage: { costUsd: 0.25, durationMs: 500, contextTokens: 1200, contextWindowMax: 200000 },
          outcome: { kind: "completed", text: "Done.", numTurns: 3 },
        }),
      ),
    );
    const next = row();
    applyTurnSettlement(next, settlement, "2026-10-03T10:00:00.000Z", "workflow");

    expect(next).toEqual({
      status: "awaiting",
      activeTurnSource: null,
      promptCount: 3,
      lastActivityAt: "2026-10-03T10:00:00.000Z",
      backendRef: { backend: "claude", ref: "sdk-2" },
      totalCostUsd: 1.75,
      totalDurationMs: 1500,
      totalTurns: 7,
      contextTokens: 1200,
      contextWindowMax: 200000,
      unread: false,
      pendingQuestionId: null,
      pendingQuestions: null,
      agentBackend: "claude",
      debugMode: null,
      turnGeneration: 3,
    });
  });

  it("keeps the last continuity when a turn reports none, and forgets it when the backend clears it", () => {
    const kept = row();
    applyTurnSettlement(
      kept,
      settlementOf(outcomeOf(settledConversationTurn({ backendRef: null, outcome: { kind: "completed", text: "" } }))),
      "t",
      "workflow",
    );
    expect(kept.backendRef).toEqual({ backend: "claude", ref: "sdk-1" });

    const cleared = row();
    applyTurnSettlement(
      cleared,
      settlementOf(
        outcomeOf(
          settledConversationTurn({
            backendRef: null,
            continuationDisposition: "clear",
            outcome: { kind: "failed", error: { backend: "claude", failureKind: "stale_resume_ref", message: "gone" } },
          }),
        ),
      ),
      "t",
      "workflow",
    );
    expect(cleared.backendRef).toBeNull();
  });

  it("returns a turn that never started to idle without counting it", () => {
    const next = row();
    applyTurnSettlement(
      next,
      settlementOf({ kind: "not_started", reason: "configuration", message: "no runtime" }),
      "2026-10-03T10:00:00.000Z",
      "workflow",
    );
    expect(next).toMatchObject({ status: "awaiting", activeTurnSource: null, promptCount: 2, totalCostUsd: 1.5 });
  });

  it("leaves a person's finished turn unread for whoever was not watching, but not a workflow's", () => {
    const settlement = settlementOf(outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "ok" } })));
    const person = row();
    applyTurnSettlement(person, settlement, "t", "user");
    expect(person.unread).toBe(true);

    const workflow = row();
    applyTurnSettlement(workflow, settlement, "t", "workflow");
    expect(workflow.unread).toBe(false);
  });

  it("carries a failed turn's reason, noting whether the transcript already explains it", () => {
    expect(settlementOf({ kind: "not_started", reason: "configuration", message: "Model gpt-x is not available" }).failure).toEqual({
      message: "Model gpt-x is not available",
      recorded: false,
    });
    expect(
      settlementOf(
        outcomeOf(
          settledConversationTurn({
            outcome: { kind: "failed", error: { backend: "claude", failureKind: "backend_error", message: "transport closed" } },
          }),
        ),
      ).failure,
    ).toEqual({ message: "transport closed", recorded: true });
    expect(settlementOf({ kind: "not_started", reason: "cancelled", message: "cancelled" }).failure).toBeNull();
    expect(
      settlementOf({
        ...outcomeOf(
          settledConversationTurn({
            outcome: { kind: "failed", error: { backend: "claude", failureKind: "aborted", message: "aborted" } },
          }),
        ),
        interruption: { reason: "user" },
      }).failure,
    ).toBeNull();
    expect(settlementOf(outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "ok" } }))).failure).toBeNull();
  });

  it("takes a first message's backend, and refuses a change once the conversation has run", () => {
    const fresh = { ...row(), promptCount: 0, agentBackend: "claude" as const };
    applyBackendAdoption(fresh, "codex");
    expect(fresh.agentBackend).toBe("codex");
    expect(() => applyBackendAdoption({ ...row(), agentBackend: "claude" as const }, "codex")).toThrow(/after prompts/);
  });

  it("shows a conversation running from the moment its turn is taken up, before it has model capacity", () => {
    const idle = { ...row(), status: "awaiting" as const, activeTurnSource: null };
    applyTurnClaimed(idle, "t");
    // Every turn the core takes up moves the fence a released collaboration checks before it reclaims the conversation.
    expect(idle).toMatchObject({ status: "running", activeTurnSource: null, lastActivityAt: "t", turnGeneration: 4 });

    // Taken up but never begun (stopped while waiting): idle again.
    expect(applyClaimEnded(idle)).toBe("awaiting");
    expect(idle.status).toBe("awaiting");
    // A turn the port settled leaves nothing to end.
    expect(applyClaimEnded(idle)).toBeNull();
    const begun = row();
    expect(applyClaimEnded(begun)).toBeNull();
    expect(begun.status).toBe("running");
  });

  describe("questions", () => {
    const batch = {
      questionId: "q-1",
      questions: [{ id: "0", question: "Which database?", options: [], multiSelect: false, required: true, allowNote: true }],
    };

    it("puts a running conversation in waiting for input with its question, once", () => {
      const asking = row();
      expect(applyQuestionAsked(asking, batch)).toBe(true);
      expect(asking).toMatchObject({ status: "waiting_for_input", pendingQuestionId: "q-1", pendingQuestions: batch.questions });
      expect(applyQuestionAsked(asking, { ...batch, questionId: "q-2" })).toBe(false);
    });

    it("clears only the question it names, and the turn runs on", () => {
      const asked = row();
      applyQuestionAsked(asked, batch);
      expect(applyQuestionCleared(asked, "q-other")).toBe(false);
      expect(applyQuestionCleared(asked, "q-1")).toBe(true);
      expect(asked).toMatchObject({ status: "running", pendingQuestionId: null, pendingQuestions: null });
    });

    it("finishes an answer the queue already consumed: the asking turn runs on, a parked question leaves the conversation idle", () => {
      const running = row();
      applyQuestionAsked(running, batch);
      // The answer's enqueue consumes the marker atomically before the clear arrives.
      running.pendingQuestionId = null;
      running.pendingQuestions = null;
      expect(applyQuestionCleared(running, "q-1")).toBe(true);
      expect(running.status).toBe("running");

      const parked = { ...row(), activeTurnSource: null, status: "waiting_for_input" as const };
      expect(applyQuestionCleared(parked, "q-1")).toBe(true);
      expect(parked.status).toBe("awaiting");

      const parkedNamed = { ...row(), activeTurnSource: null };
      applyQuestionAsked(parkedNamed, batch);
      expect(applyQuestionCleared(parkedNamed, "q-1")).toBe(true);
      expect(parkedNamed).toMatchObject({ status: "awaiting", pendingQuestionId: null });
    });

    it("withdraws whatever question is pending when the person stops the conversation", () => {
      const parked = { ...row(), activeTurnSource: null };
      applyQuestionAsked(parked, batch);
      expect(applyQuestionWithdrawn(parked)).toBe(true);
      expect(parked).toMatchObject({ status: "awaiting", pendingQuestionId: null, pendingQuestions: null });
      expect(applyQuestionWithdrawn(parked)).toBe(false);

      // A person's message started a new turn first: it already superseded the question.
      const superseded = row();
      applyTurnBegin(superseded, "user", "t");
      expect(applyQuestionWithdrawn(superseded)).toBe(false);
      expect(superseded.status).toBe("running");
    });

    it("leaves a turn that ended on an unanswered question waiting for input, and says so", () => {
      const asked = row();
      applyQuestionAsked(asked, batch);
      const { status } = applyTurnSettlement(
        asked,
        settlementOf(outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "?" } }))),
        "t",
        "user",
      );
      expect(asked.status).toBe("waiting_for_input");
      expect(status).toBe("waiting_for_input");
    });

    it("keeps an unanswered question across a restart that interrupted its turn", () => {
      const asked = row();
      applyQuestionAsked(asked, batch);
      expect(applyTurnInterrupted(asked, "t")).toBe("waiting_for_input");
      expect(asked).toMatchObject({ status: "waiting_for_input", activeTurnSource: null, pendingQuestionId: "q-1" });
      const plain = row();
      expect(applyTurnInterrupted(plain, "t")).toBe("awaiting");

      // A question asked inside the turn died with its transport: nothing could answer it.
      const inTurn = row();
      applyQuestionAsked(inTurn, { ...batch, questionId: "cc-in-turn-1" });
      expect(applyTurnInterrupted(inTurn, "t")).toBe("awaiting");
      expect(inTurn).toMatchObject({ pendingQuestionId: null, pendingQuestions: null });
    });

    it("lets a person's new message supersede an unanswered question", () => {
      const asked = row();
      applyQuestionAsked(asked, batch);
      applyTurnBegin(asked, "user", "t");
      expect(asked).toMatchObject({ status: "running", activeTurnSource: "user", pendingQuestionId: null, unread: false });
    });
  });

  describe("debug mode", () => {
    const debugging = (phase: DebugModePhase, overrides: Partial<DebugModeState> = {}): ConversationRow => ({
      ...row(),
      activeTurnSource: "user",
      unread: false,
      debugMode: {
        active: true,
        recording: true,
        logFilePath: "/w/.cc/debug/conv-1.ndjson",
        enteredAt: "2026-10-03T09:00:00.000Z",
        hypotheses: [],
        reproductionSteps: [],
        fixSummary: null,
        verificationSteps: [],
        instructionsDelivered: false,
        phase,
        lastTurnFailed: false,
        debugSessionId: "dbg-1",
        ...overrides,
      },
    });
    const settle = (draft: ConversationRow, outcome: TurnExecutionOutcome) =>
      applyTurnSettlement(draft, settlementOf(outcome), "t", "user");
    const report = (structuredOutput: unknown) =>
      outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "", structuredOutput } }));

    it("advances a hypothesizing turn that produced its report, and only an advance is left unread", () => {
      const draft = debugging("hypothesizing");
      const hypotheses = ["A race", "A stale cache", "A wrong default"].map((description, index) => ({
        id: `H${index + 1}`,
        description,
        instrumentationPlan: "Log the state before and after",
      }));
      const settled = settle(draft, report({ hypotheses, reproductionSteps: ["Start it", "Run it twice"] }));
      expect(settled.debug?.kind).toBe("advance");
      expect(draft.debugMode).toMatchObject({
        phase: "awaiting_reproduction",
        instructionsDelivered: true,
        hypotheses,
        reproductionSteps: ["Start it", "Run it twice"],
      });
      expect(draft.unread).toBe(true);
      expect(settled.status).toBe("awaiting");
    });

    it("keeps a phase turn without its report for retry, and a stopped one too, without marking them unread", () => {
      const plain = debugging("hypothesizing");
      const failed = settle(plain, outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "I looked around" } })));
      expect(failed.debug).toMatchObject({ kind: "turn_failed", lastError: "Turn did not produce a valid structured response" });
      expect(plain.debugMode?.lastTurnFailed).toBe(true);
      expect(plain.unread).toBe(false);

      const stopped = debugging("analyzing_evidence");
      const aborted = settle(
        stopped,
        outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "" } }, { reason: "user" })),
      );
      expect(aborted.debug).toMatchObject({ kind: "turn_failed", lastError: "Aborted: user" });
    });

    it("settles a follow-up in a waiting phase without change, and hands a cleanup report to verification", () => {
      const waiting = debugging("awaiting_reproduction");
      expect(settle(waiting, report(undefined)).debug?.kind).toBe("followup_settled");
      expect(waiting.debugMode?.phase).toBe("awaiting_reproduction");
      expect(waiting.unread).toBe(false);

      const cleanup = debugging("cleanup_instrumentation");
      expect(settle(cleanup, report({ removed: ["src/a.ts"] })).debug?.kind).toBe("verify_cleanup");
      expect(cleanup.debugMode?.cleanupVerificationAttempt).toBe(1);
    });

    it("leaves an ordinary conversation's settlement alone", () => {
      const ordinary = { ...row(), unread: false };
      expect(settle(ordinary, report(undefined)).debug).toBeNull();
      expect(ordinary).toMatchObject({ unread: true, debugMode: null });
    });

    it("clears a failed turn when the next one starts", () => {
      const failed = debugging("hypothesizing", { lastTurnFailed: true });
      applyTurnBegin(failed, "user", "t");
      expect(failed.debugMode?.lastTurnFailed).toBe(false);
    });

    it("applies only the commands legal in the current phase", () => {
      const ordinary = row();
      expect(applyDebugCommandToRow(ordinary, { kind: "enter", logFilePath: "/w/log", debugSessionId: "dbg-2" }, "t")).not.toBeNull();
      expect(ordinary.debugMode).toMatchObject({ active: true, phase: "hypothesizing", debugSessionId: "dbg-2" });

      const hypothesizing = debugging("hypothesizing");
      const before = structuredClone(hypothesizing.debugMode);
      expect(applyDebugCommandToRow(hypothesizing, { kind: "mark_reproduced" }, "t")).toBeNull();
      expect(hypothesizing.debugMode).toEqual(before);

      expect(applyDebugCommandToRow(hypothesizing, { kind: "exit" }, "t")).not.toBeNull();
      expect(hypothesizing.debugMode).toBeNull();
    });

    it("marks a debug turn a restart interrupted as failed, so it can be retried", () => {
      const interrupted = debugging("hypothesizing");
      applyTurnInterrupted(interrupted, "t");
      expect(interrupted.debugMode?.lastTurnFailed).toBe(true);
    });
  });

  it("holds the conversation's turns while a collaboration owns it, and a claim while its row forbids one", () => {
    const owned = { owner: { kind: "collaboration" as const, workflowId: "wf-1", attemptEpoch: 1 }, debugMode: null, pendingQueue: [] };
    expect(conversationHoldRefusal({ owner: null, debugMode: null, pendingQueue: [] }, "message")).toBeNull();
    expect(conversationHoldRefusal(owned, "task")).toEqual({
      code: "owned",
      message: "A collaboration holds this conversation; send your message once it ends, or stop it",
    });
    // A collaboration's own reclaim answers to its own fence.
    expect(conversationHoldRefusal(owned, "claim")).toBeNull();
    expect(
      conversationHoldRefusal(
        {
          owner: null,
          debugMode: null,
          pendingQueue: [
            {
              id: "q-1",
              content: [{ type: "text", text: "Earlier" }],
              status: "uncertain",
              enqueuedAt: "t",
              updatedAt: "t",
              deliveryStartedAt: "t",
              deliveredAt: null,
              cancelledAt: null,
              failedAt: null,
              deliveryAttemptId: "att-1",
              attemptCount: 1,
              error: null,
              metadata: null,
            },
          ],
        },
        "claim",
      ),
    ).toMatchObject({ code: "busy", message: "Review queued deliveries before sending another prompt." });
  });
});
