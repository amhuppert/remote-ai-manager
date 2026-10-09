import { describe, expect, it } from "vitest";
import type { DebugModeState } from "@/lib/debug-log/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { DebugCleanupVerificationRequest } from "@/lib/workflows/debug/cleanup-verification";
import {
  applyDebugCommandToRow,
  type ConversationRow,
} from "./conversation-record";
import { createCoreDebugMode, type CoreDebugModeDeps } from "./debug-mode";
import type { UserMessageAdmission } from "./executor";
import type { UserTurnRequest } from "./schemas";

const enrollment = {
  conversationId: "conv-1",
  projectPath: "/repo",
  sessionName: "session",
  enrolledAt: "2026-10-03T10:00:00.000Z",
};

const session = (overrides: Partial<DebugModeState> = {}): DebugModeState => ({
  active: true,
  recording: true,
  logFilePath: "/w/.cc/debug/conv-1.ndjson",
  enteredAt: "2026-10-03T09:00:00.000Z",
  hypotheses: [],
  reproductionSteps: [],
  fixSummary: null,
  verificationSteps: [],
  instructionsDelivered: true,
  phase: "hypothesizing",
  lastTurnFailed: false,
  debugSessionId: "dbg-1",
  ...overrides,
});

function harness(debugMode: DebugModeState | null = null) {
  const row: Pick<ConversationRow, "debugMode"> = { debugMode };
  const applied: string[] = [];
  const sent: unknown[] = [];
  const verifications: DebugCleanupVerificationRequest[] = [];
  let busy = false;
  let durableHold: string | null = null;
  const holdsAsked: string[] = [];
  let runningAttempt: string | null = null;
  let finishTrailing: () => void = () => {};
  let trailing: Promise<void> = Promise.resolve();
  let lastMessage: UserTurnRequest | null = null;
  let admission: UserMessageAdmission = {
    kind: "accepted",
    cause: "user:conv-1:9",
    settled: new Promise(() => {}),
  };
  let verify: (
    request: DebugCleanupVerificationRequest,
  ) => Promise<DebugCommand | null> = async () => null;
  const deps: CoreDebugModeDeps = {
    core: {
      async whileIdle(_conversationId, work, _holder, options) {
        if (busy) return { kind: "busy" };
        holdsAsked.push(options?.holds ?? "none");
        if (options?.holds !== undefined && durableHold !== null)
          return { kind: "busy", reason: durableHold };
        return { kind: "ran", value: await work() };
      },
      runningAttempt: () => runningAttempt,
      conversationIdle: () => trailing,
      lastMessageRequest: () => lastMessage,
      async sendUserMessage(input) {
        sent.push(input);
        return admission;
      },
    },
    enrollment: (conversationId) =>
      conversationId === "conv-1" ? enrollment : null,
    records: {
      async readDebugMode() {
        return row.debugMode;
      },
      async applyCommand(_identity, command) {
        applied.push(command.kind);
        // The real row function over the harness's row, as production applies it inside its write.
        return applyDebugCommandToRow(row, command, "2026-10-03T10:00:00.000Z");
      },
    },
    verify: (request) => {
      verifications.push(request);
      return verify(request);
    },
    log: createCapturingLogger(),
  };
  const debug = createCoreDebugMode(deps);
  return {
    debug,
    row,
    applied,
    sent,
    verifications,
    setBusy(value: boolean) {
      busy = value;
    },
    holdsAsked,
    setDurableHold(reason: string | null) {
      durableHold = reason;
    },
    /** The turn that started a verification is still finishing its trailing work. */
    finishingTurn() {
      busy = true;
      trailing = new Promise<void>((resolve) => {
        finishTrailing = () => {
          busy = false;
          resolve();
        };
      });
      return () => finishTrailing();
    },
    setRunningAttempt(attemptId: string | null) {
      runningAttempt = attemptId;
    },
    setLastMessage(request: UserTurnRequest) {
      lastMessage = request;
    },
    setAdmission(value: UserMessageAdmission) {
      admission = value;
    },
    setVerify(
      fn: (
        request: DebugCleanupVerificationRequest,
      ) => Promise<DebugCommand | null>,
    ) {
      verify = fn;
    },
  };
}

describe("debug mode on a conversation the core runs", () => {
  it("enters and leaves debug mode on the conversation row, refusing what the phase does not allow", async () => {
    const h = harness();
    expect(
      await h.debug.command("conv-1", {
        kind: "enter",
        logFilePath: "/w/log",
        debugSessionId: "dbg-2",
      }),
    ).toEqual({
      kind: "applied",
    });
    expect(h.row.debugMode).toMatchObject({
      active: true,
      phase: "hypothesizing",
      debugSessionId: "dbg-2",
    });

    expect(
      await h.debug.command("conv-1", { kind: "mark_reproduced" }),
    ).toMatchObject({ kind: "refused", code: "invalid_state" });
    expect(await h.debug.command("conv-1", { kind: "exit" })).toEqual({
      kind: "applied",
    });
    expect(h.row.debugMode).toBeNull();
    expect(await h.debug.command("conv-x", { kind: "exit" })).toMatchObject({
      kind: "refused",
      code: "not_found",
    });
  });

  it("asks the conversation's durable holds only on entering, so leaving is never held by them", async () => {
    const h = harness();
    h.setDurableHold("Conversation checkpoint maintenance is in progress");
    expect(
      await h.debug.command("conv-1", {
        kind: "enter",
        logFilePath: "/w/log",
        debugSessionId: "dbg-2",
      }),
    ).toEqual({
      kind: "refused",
      code: "busy",
      message: "Conversation checkpoint maintenance is in progress",
    });
    h.row.debugMode = session();
    expect(await h.debug.command("conv-1", { kind: "exit" })).toEqual({
      kind: "applied",
    });
    expect(h.holdsAsked).toEqual(["message", "none"]);
  });

  it("refuses a command while a turn runs, and leaves an unchanged recording setting alone", async () => {
    const h = harness(session());
    h.setBusy(true);
    expect(
      await h.debug.command("conv-1", {
        kind: "set_recording",
        recording: false,
      }),
    ).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    h.setBusy(false);
    expect(
      await h.debug.command("conv-1", {
        kind: "set_recording",
        recording: true,
      }),
    ).toEqual({ kind: "unchanged" });
    expect(h.applied).toEqual([]);
  });

  it("runs the failed turn's message again, and refuses a retry with no failed turn", async () => {
    const h = harness(session());
    expect(
      await h.debug.command("conv-1", { kind: "retry_turn" }),
    ).toMatchObject({ kind: "refused", code: "invalid_state" });

    h.row.debugMode = session({ lastTurnFailed: true });
    h.setLastMessage({
      kind: "user_message",
      text: "It crashes on save",
      inputOrigin: "user",
    });
    expect(await h.debug.command("conv-1", { kind: "retry_turn" })).toEqual({
      kind: "applied",
    });
    expect(h.sent).toEqual([
      {
        conversationId: "conv-1",
        kind: "user_message",
        text: "It crashes on save",
        inputOrigin: "user",
      },
    ]);

    h.setAdmission({
      kind: "refused",
      code: "busy",
      message: "Conversation is busy",
    });
    expect(
      await h.debug.command("conv-1", { kind: "retry_turn" }),
    ).toMatchObject({ kind: "refused", code: "busy" });
  });

  it("applies a cleanup verification's result to the session that asked for it", async () => {
    const h = harness(
      session({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 1,
      }),
    );
    h.setVerify(async (request) => ({
      kind: "cleanup_verified",
      debugSessionId: request.debugSessionId,
      attempt: request.attempt,
    }));
    h.debug.startVerification({
      identity: {
        projectPath: "/repo",
        storeSessionName: "session",
        conversationId: "conv-1",
      },
      worktreePath: "/w",
      structuredOutput: { removedInstrumentation: true },
      debugSessionId: "dbg-1",
      attempt: 1,
      turnAttemptId: "attempt-cleanup",
    });
    await h.debug.settled("conv-1");
    expect(h.verifications[0]).toMatchObject({
      worktreePath: "/w",
      conversationId: "conv-1",
      debugSessionId: "dbg-1",
      attempt: 1,
    });
    expect(h.row.debugMode).toBeNull();
  });

  it("stops a pending verification when the person leaves debug mode, before leaving", async () => {
    const h = harness(
      session({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 1,
      }),
    );
    let aborted = false;
    h.setVerify(
      (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve(null);
          }),
        ),
    );
    h.debug.startVerification({
      identity: {
        projectPath: "/repo",
        storeSessionName: "session",
        conversationId: "conv-1",
      },
      worktreePath: "/w",
      structuredOutput: {},
      debugSessionId: "dbg-1",
      attempt: 1,
      turnAttemptId: "attempt-cleanup",
    });
    expect(await h.debug.command("conv-1", { kind: "exit" })).toEqual({
      kind: "applied",
    });
    expect(aborted).toBe(true);
    expect(h.applied).toEqual(["exit"]);
  });

  it("applies a verification that reports while its own turn is still finishing, once that turn is done", async () => {
    const h = harness(
      session({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 1,
      }),
    );
    const finished = h.finishingTurn();
    h.setVerify(async (request) => ({
      kind: "cleanup_verified",
      debugSessionId: request.debugSessionId,
      attempt: request.attempt,
    }));
    h.debug.startVerification({
      identity: {
        projectPath: "/repo",
        storeSessionName: "session",
        conversationId: "conv-1",
      },
      worktreePath: "/w",
      structuredOutput: {},
      debugSessionId: "dbg-1",
      attempt: 1,
      turnAttemptId: "attempt-cleanup",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.row.debugMode).not.toBeNull();
    finished();
    await h.debug.settled("conv-1");
    expect(h.row.debugMode).toBeNull();
  });

  it("waits for its own turn even while that turn's attempt is still running its trailing work", async () => {
    const h = harness(
      session({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 1,
      }),
    );
    const finished = h.finishingTurn();
    h.setRunningAttempt("attempt-cleanup");
    h.setVerify(async (request) => ({
      kind: "cleanup_verified",
      debugSessionId: request.debugSessionId,
      attempt: request.attempt,
    }));
    h.debug.startVerification({
      identity: {
        projectPath: "/repo",
        storeSessionName: "session",
        conversationId: "conv-1",
      },
      worktreePath: "/w",
      structuredOutput: {},
      debugSessionId: "dbg-1",
      attempt: 1,
      turnAttemptId: "attempt-cleanup",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.setRunningAttempt(null);
    finished();
    await h.debug.settled("conv-1");
    expect(h.row.debugMode).toBeNull();
  });

  it("drops a verification that reports while a later turn runs, as the conversation actor does", async () => {
    const h = harness(
      session({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 1,
      }),
    );
    h.setBusy(true);
    h.setRunningAttempt("attempt-later");
    h.setVerify(async (request) => ({
      kind: "cleanup_verified",
      debugSessionId: request.debugSessionId,
      attempt: request.attempt,
    }));
    h.debug.startVerification({
      identity: {
        projectPath: "/repo",
        storeSessionName: "session",
        conversationId: "conv-1",
      },
      worktreePath: "/w",
      structuredOutput: {},
      debugSessionId: "dbg-1",
      attempt: 1,
      turnAttemptId: "attempt-cleanup",
    });
    await h.debug.settled("conv-1");
    expect(h.row.debugMode).not.toBeNull();
  });
});
