/**
 * Checkpoints of conversations the shared conversation core runs, through the
 * real supervision graph (core, hold sources, queue bridge, boot) over real
 * SQLite rows and the real checkpoint repository. Only generation, the
 * archive read and the runtime close are faked; durable outcomes are read
 * back through repositories a restarted server would build.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CaptureHandoffResult } from "@/lib/agent-backends/schemas";
import { omittedCaptureResult } from "@/lib/conversation-checkpoints/checkpoint-capture";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import {
  EMPTY_CHECKPOINT_USAGE,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import {
  makeConversationState,
  type ConversationStateOverrides,
} from "@/lib/conversations/testing/conversation-state-fixture";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";
import {
  checkpointPayloadFor,
  createSupervisionHarness,
  done,
  quiesce,
} from "@/lib/supervision/testing/supervision-fixture";
import type { Supervision } from "@/lib/supervision/supervision";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { taskTurnRequestSchema } from "@/lib/conversation-core/turn/turn-spec";

const PROJECT = "/repo";
const SESSION = "session";
const CHAT = "chat-1";
const LIVE_REF = { backend: "claude", ref: "sdk-live" } as const;
const address = {
  projectPath: PROJECT,
  target: sessionConversationTarget("repo", SESSION, CHAT),
};
const KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: PROJECT,
  sessionName: SESSION,
  conversationId: CHAT,
};
const COMPACTING = /checkpoint maintenance is in progress/;

function entry(
  seq: number,
  role: "user" | "assistant",
  text: string,
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-10-03T10:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

let fixture: PersistenceFixture;
let h: ReturnType<typeof createSupervisionHarness>;
let s: Supervision;
/** Every graph a test composed, each settled before the database closes. */
let composed: Supervision[];

function compose(): Supervision {
  const supervision = h.compose();
  composed.push(supervision);
  return supervision;
}

async function seedChat(
  overrides: ConversationStateOverrides = {},
): Promise<void> {
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({
      id: CHAT,
      promptCount: 2,
      transcriptPath: "/transcripts/chat-1.jsonl",
      backendRef: LIVE_REF,
      ...overrides,
    }),
  );
}

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION);
  await seedChat();
  createConversationCoreRepo(fixture.db).enrollInteractive({
    conversationId: CHAT,
    projectPath: PROJECT,
    sessionName: SESSION,
    enrolledAt: "2026-10-03T10:00:00.000Z",
  });
  h = createSupervisionHarness(fixture);
  h.checkpoint.entries = [
    entry(0, "user", "the deploy key lives in vault"),
    entry(1, "assistant", "noted"),
  ];
  composed = [];
  s = compose();
});
afterEach(async () => {
  for (const supervision of composed) await quiesce(supervision);
  fixture.close();
});

/** The repositories a restarted server reads through. */
function reloaded() {
  const store = fixture.recreateStore();
  return {
    repo: createConversationCheckpointsRepo(
      fixture.db,
      createWriteQueue(),
      store.checkpointContinuation,
    ),
    row: () => store.getConversation(PROJECT, SESSION, CHAT),
  };
}

const message = (text = "carry on") =>
  s.core.sendUserMessage({ conversationId: CHAT, text, inputOrigin: "user" });

function batch(id: string, text: string) {
  return {
    deliveryAttemptId: `att-${id}`,
    messageIds: [id],
    content: [{ type: "text" as const, text }],
    command: null,
  };
}

/** Generation waits until released, or ends cancelled when its build is cancelled. */
function gateGeneration() {
  let release: () => void = () => {};
  let markBegun: () => void = () => {};
  const opened = new Promise<void>((resolve) => (release = resolve));
  const begun = new Promise<void>((resolve) => (markBegun = resolve));
  h.checkpoint.generate = async (input, deps) => {
    markBegun();
    await Promise.race([
      opened,
      new Promise<void>((resolve) =>
        deps.signal?.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    if (deps.signal?.aborted === true) {
      return {
        ok: false,
        failure: {
          code: "cancelled",
          message: "checkpoint generation was cancelled",
        },
        generationPassCount: 0,
        usage: EMPTY_CHECKPOINT_USAGE,
      };
    }
    return {
      ok: true,
      payload: checkpointPayloadFor(input),
      generationPassCount: 1,
      usage: EMPTY_CHECKPOINT_USAGE,
    };
  };
  return { begun, release };
}

/** The parts of every capture audit entry in the archive, in order. */
function captureParts() {
  return h.checkpoint.entries.flatMap((e) =>
    e.origin?.source === "checkpoint_capture"
      ? [e.origin.checkpointCapture?.part]
      : [],
  );
}

/** A checkpoint that asks for a handoff capture first. */
async function withHandoff(requestId: string) {
  const started = await s.checkpoints.start({
    address,
    requestId,
    handoff: { mode: "tool-disabled" },
  });
  if (started.kind === "refused")
    throw new Error(
      `refused: ${started.refusal.code} ${started.refusal.reason}`,
    );
  if (started.kind !== "admitted")
    throw new Error(`not admitted: ${started.kind}`);
  return started;
}

/** A capture that answered with an empty handoff in the conversation's own session. */
function capturedHandoff(): CaptureHandoffResult {
  return {
    modeEstablished: true,
    submitted: true,
    correlatedCompletion: true,
    candidateText: JSON.stringify({
      plan: [],
      hypotheses: [],
      failedApproaches: [],
      blockers: [],
      nextStep: [],
    }),
    omissionReason: null,
    executionSettled: true,
    cleanupFailure: null,
    continuation: {
      disposition: "retain",
      backendRef: LIVE_REF,
      nextRuntime: "recreate_from_ref",
    },
    activity: {
      transport: "complete",
      native: "unavailable",
      prohibited: "not_observed",
      inspectedBytes: null,
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
      costBasis: null,
      executionMs: 1,
      settlementMs: 1,
    },
  };
}

async function admitted(requestId: string, recover: string | null = null) {
  const started = await s.checkpoints.start({ address, requestId, recover });
  if (started.kind === "refused")
    throw new Error(
      `refused: ${started.refusal.code} ${started.refusal.reason}`,
    );
  return started;
}

describe("checkpoints of a conversation the core runs", () => {
  it("builds a checkpoint: the operation is ready, the provider reference is cleared, and the next message runs", async () => {
    const started = await admitted("op-1");
    expect(started.kind).toBe("admitted");
    expect(await started.completion).toMatchObject({
      id: "op-1",
      phase: "ready",
    });

    const after = reloaded();
    expect(await after.repo.getOperation(KEY, "op-1")).toMatchObject({
      phase: "ready",
      payloadId: "op-1",
    });
    expect((await after.row())?.backendRef).toBeNull();
    expect(h.checkpoint.releases).toEqual([CHAT]);
    expect(await message()).toMatchObject({ kind: "accepted" });
  });

  it("holds the conversation while it builds: a message is refused, a queued batch waits, and it runs once ready", async () => {
    const gate = gateGeneration();
    const started = await admitted("op-1");
    await gate.begun;

    expect(await message()).toMatchObject({ kind: "refused", code: "busy" });
    expect(s.checkpoints.acceptsQueuedInput(CHAT)).toBe(true);
    h.queued.push(batch("q-1", "queued while compacting"));
    await s.drainConversationQueue(CHAT);
    expect(h.queued).toHaveLength(1);

    gate.release();
    await started.completion;
    await quiesce(s);
    expect(h.userMessages).toEqual(["queued while compacting"]);
  });

  it("answers a retransmitted start with the operation it already admitted", async () => {
    const gate = gateGeneration();
    const first = await admitted("op-1");
    const again = await s.checkpoints.start({ address, requestId: "op-1" });
    expect(again).toMatchObject({ kind: "reused", operation: { id: "op-1" } });
    gate.release();
    await first.completion;
  });

  it.each<[string, ConversationStateOverrides, string]>([
    ["a pending question", { pendingQuestionId: "q-1" }, "question_pending"],
    ["no recorded turns", { promptCount: 0 }, "no_recorded_history"],
    ["archival", { archived: true }, "conversation_archived"],
    ["a workflow role", { role: "validator" }, "conversation_owned"],
  ])(
    "refuses %s alike in a check and a start, and writes nothing",
    async (_name, overrides, code) => {
      await seedChat(overrides);
      const checked = await s.checkpoints.check(address, { recover: null });
      expect(checked).toMatchObject({ eligible: false, active: null });
      expect(checked.refusals.map((refusal) => refusal.code)).toContain(code);

      const started = await s.checkpoints.start({ address, requestId: "op-1" });
      expect(started).toMatchObject({
        kind: "refused",
        refusal: { code: checked.refusals[0]?.code },
      });
      expect((await reloaded().repo.listReceipts(KEY)).receipts).toEqual([]);
      expect(await message()).toMatchObject({ kind: "accepted" });
    },
  );

  it("refuses a checkpoint while a turn runs, and reports the backend's handoff capture as available", async () => {
    let finish: () => void = () => {};
    h.userTurn = () =>
      new Promise((resolve) => (finish = () => resolve(done("Hello."))));
    await message("long task");
    await quiesce(s, false);

    const checked = await s.checkpoints.check(address, { recover: null });
    expect(checked.refusals.map((refusal) => refusal.code)).toContain(
      "turn_active",
    );
    expect(checked.handoff).toMatchObject({
      available: true,
      mode: "tool-disabled",
    });
    expect(
      await s.checkpoints.start({ address, requestId: "op-1" }),
    ).toMatchObject({
      kind: "refused",
      refusal: { code: "turn_active" },
    });
    finish();
    await quiesce(s);
    expect((await reloaded().repo.listReceipts(KEY)).receipts).toEqual([]);
  });

  it("reports no handoff capture for a conversation with no session to resume", async () => {
    await seedChat({ backendRef: null });
    const checked = await s.checkpoints.check(address, { recover: null });
    expect(checked.handoff).toMatchObject({
      available: false,
      reason: "continuity_unavailable",
    });
  });

  it("captures a requested handoff in the conversation's own session, audits it in the transcript, and builds with it", async () => {
    h.checkpoint.capture = async () => capturedHandoff();
    const started = await withHandoff("op-1");

    expect(await started.completion).toMatchObject({
      phase: "ready",
      handoff: { stage: "included", omissionReason: null },
    });
    expect(h.checkpoint.captures).toEqual([
      {
        backendRef: LIVE_REF,
        captureId: "op-1:capture",
        mode: "tool-disabled",
        modelSelection: { modelId: "sonnet", parameters: {} },
      },
    ]);
    expect(
      h.checkpoint.entries.flatMap((e) =>
        e.origin?.source === "checkpoint_capture"
          ? [e.origin.checkpointCapture?.part]
          : [],
      ),
    ).toEqual(["control", "output", "settlement"]);
    expect(h.checkpoint.releases).toContain(CHAT);
    expect(
      await s.checkpoints.skipHandoff({ address, operationId: "op-1" }),
    ).toMatchObject({ kind: "handoff_already_settled" });
  });

  it("omits the handoff when its capture cannot start in the conversation's session, and builds the baseline", async () => {
    const started = await withHandoff("op-1");

    expect(await started.completion).toMatchObject({
      phase: "ready",
      handoff: {
        stage: "omitted",
        omissionReason: "mode_establishment_failed",
      },
    });
  });

  it("skips a running capture: the capture is stopped and the baseline checkpoint is built", async () => {
    let capturing: () => void = () => {};
    const began = new Promise<void>((resolve) => (capturing = resolve));
    h.checkpoint.capture = (input) =>
      new Promise((resolve) => {
        capturing();
        input.signal.addEventListener(
          "abort",
          () => resolve(omittedCaptureResult("skipped", LIVE_REF)),
          { once: true },
        );
      });
    const started = await withHandoff("op-1");
    await began;

    await s.checkpoints.skipHandoff({ address, operationId: "op-1" });

    expect(await started.completion).toMatchObject({
      phase: "ready",
      handoff: { stage: "omitted", omissionReason: "skipped" },
    });
  });

  it("keeps a held capture's audit open until reconcile collects it, then completes the audit", async () => {
    const late: { frame: (() => Promise<void>) | null } = { frame: null };
    h.checkpoint.capture = async (input) => {
      late.frame = () =>
        input.onTranscript({
          seq: 0,
          backend: "claude",
          type: "assistant",
          raw: {
            timestamp: "2026-10-03T10:00:01.000Z",
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text: "late frame" }],
          },
        });
      return {
        ...omittedCaptureResult("capture_failed", LIVE_REF),
        executionSettled: false,
        cleanupFailure: {
          code: "cleanup_unverified",
          message: "the capture process could not be confirmed stopped",
        },
      };
    };
    const started = await withHandoff("op-1");
    expect(await started.completion).toMatchObject({
      phase: "needs_reconciliation",
    });

    await late.frame?.();
    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required" },
    });

    expect(captureParts()).toEqual(["control", "output", "settlement"]);
    expect(
      (await reloaded().repo.getOperation(KEY, "op-1"))?.handoff,
    ).toMatchObject({ executionSettled: true, auditDurable: true });
  });

  it("writes a capture audit entry that failed, with its own id, before the audit counts as durable", async () => {
    h.checkpoint.capture = async () => capturedHandoff();
    h.checkpoint.failingAppends.add("op-1:capture:1");
    const started = await withHandoff("op-1");
    expect(await started.completion).toMatchObject({
      phase: "needs_reconciliation",
    });

    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required" },
    });

    expect(
      h.checkpoint.entries
        .filter((e) => e.origin?.source === "checkpoint_capture")
        .map((e) => e.entryId),
    ).toEqual(["op-1:capture:0", "op-1:capture:1", "op-1:capture:2"]);
  });

  it("observes the stop of a capture it ran and released, when the checkpoint failed after it", async () => {
    h.checkpoint.capture = async () => {
      h.checkpoint.failNextRead = true;
      return capturedHandoff();
    };
    const started = await withHandoff("op-1");
    expect(await started.completion).toMatchObject({
      phase: "needs_reconciliation",
    });

    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required" },
    });
    expect(
      (await reloaded().repo.getOperation(KEY, "op-1"))?.handoff,
    ).toMatchObject({ executionSettled: true, executionStopAttestation: null });
  });

  it("after a restart, leaves a held capture's execution unknown until the person confirms it stopped", async () => {
    h.checkpoint.capture = async () => ({
      ...omittedCaptureResult("capture_failed", LIVE_REF),
      executionSettled: false,
      cleanupFailure: {
        code: "cleanup_unverified",
        message: "the capture process could not be confirmed stopped",
      },
    });
    const started = await withHandoff("op-1");
    await started.completion;
    s = compose();
    await s.boot();

    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "blocked",
      refusal: {
        code: "recovery_required",
        reason: expect.stringMatching(/captureExecutionStopped/),
      },
    });
    expect(
      (await reloaded().repo.getOperation(KEY, "op-1"))?.handoff,
    ).toMatchObject({ executionSettled: false });

    await s.checkpoints.reconcile({
      address,
      operationId: "op-1",
      captureExecutionStopped: true,
      source: "cli",
    });
    expect(
      (await reloaded().repo.getOperation(KEY, "op-1"))?.handoff,
    ).toMatchObject({
      executionSettled: true,
      executionStopAttestation: { source: "cli" },
    });
  });

  it("holds a capture whose cleanup is unverified for reconciliation, which closes its runtime", async () => {
    h.checkpoint.capture = async () => ({
      ...omittedCaptureResult("capture_failed", LIVE_REF),
      executionSettled: false,
      cleanupFailure: {
        code: "cleanup_unverified",
        message: "the capture process could not be confirmed stopped",
      },
    });
    const started = await withHandoff("op-1");
    expect(await started.completion).toMatchObject({
      phase: "needs_reconciliation",
    });
    expect(await message()).toMatchObject({ kind: "refused" });

    const reconciled = await s.checkpoints.reconcile({
      address,
      operationId: "op-1",
    });

    expect(h.checkpoint.releases).toContain(`retry:${CHAT}`);
    expect(reconciled).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required" },
    });
  });

  it("cancels a build: the operation is cancelled, the continuation is untouched, and the queue drains", async () => {
    const gate = gateGeneration();
    await admitted("op-1");
    await gate.begun;
    h.queued.push(batch("q-1", "queued while compacting"));

    expect(
      await s.checkpoints.cancel({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "cancelled",
      operation: { phase: "cancelled" },
    });
    await quiesce(s);
    expect(h.userMessages).toEqual(["queued while compacting"]);
    const after = reloaded();
    expect(await after.repo.getOperation(KEY, "op-1")).toMatchObject({
      phase: "cancelled",
    });
    expect((await after.row())?.backendRef).toEqual(LIVE_REF);
  });

  it("cancels a build when the server stops, and the stop waits for it", async () => {
    const gate = gateGeneration();
    const started = await admitted("op-1");
    await gate.begun;
    await s.core.shutdown();
    expect(await started.completion).toMatchObject({ phase: "cancelled" });
  });

  it("holds a checkpoint whose runtime did not close, across a restart, until a reconcile closes it", async () => {
    h.checkpoint.closeFailure = "child process cleanup could not be verified";
    const started = await admitted("op-1");
    expect(await started.completion).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
    });
    expect(await message()).toMatchObject({
      kind: "refused",
      code: "busy",
      message: expect.stringMatching(COMPACTING),
    });

    s = compose();
    await s.boot();
    expect(await message()).toMatchObject({ kind: "refused", code: "busy" });
    expect(
      await s.checkpoints.cancel({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "refused",
      refusal: { code: "not_cancellable" },
    });
    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "blocked",
      refusal: { code: "reconciliation_failed" },
    });

    h.checkpoint.closeFailure = null;
    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "repaired",
      operation: { phase: "ready" },
    });
    expect(h.checkpoint.releases).toContain(`retry:${CHAT}`);
    expect((await reloaded().row())?.backendRef).toBeNull();
    expect(await message()).toMatchObject({ kind: "accepted" });
  });

  it("supersedes a held operation with --recover, and a failed recovery restores its gate", async () => {
    h.checkpoint.closeFailure = "child process cleanup could not be verified";
    await (
      await admitted("op-1")
    ).completion;
    h.checkpoint.closeFailure = null;
    h.checkpoint.generate = async () => ({
      ok: false,
      failure: { code: "build_error", message: "the generator failed" },
      generationPassCount: 1,
      usage: EMPTY_CHECKPOINT_USAGE,
    });

    expect(await (await admitted("op-2", "op-1")).completion).toMatchObject({
      phase: "failed",
    });
    expect(
      (await reloaded().repo.getStateForAdmission(KEY)).active,
    ).toMatchObject({
      id: "op-1",
      phase: "needs_reconciliation",
    });
    expect(await message()).toMatchObject({ kind: "refused", code: "busy" });

    h.checkpoint.generate = async (input) => ({
      ok: true,
      payload: checkpointPayloadFor(input),
      generationPassCount: 1,
      usage: EMPTY_CHECKPOINT_USAGE,
    });
    expect(await (await admitted("op-3", "op-1")).completion).toMatchObject({
      phase: "ready",
      recoversOperationId: "op-1",
    });
    expect(await message()).toMatchObject({ kind: "accepted" });
  });

  it("refuses a task while a checkpoint waits for its delivering message", async () => {
    await (
      await admitted("op-1")
    ).completion;
    const task = taskTurnRequestSchema.parse({
      kind: "task_run",
      promptText: "Write a commit message",
      executionClass: "nongoverned-task",
    });
    expect(await s.core.runTask({ conversationId: CHAT, turn: task })).toEqual({
      kind: "not_started",
      reason: "configuration",
      message:
        "A ready checkpoint is delivered by the next ordinary conversation turn",
    });
  });

  it("refuses a collaboration's claim while a checkpoint waits for its delivering message", async () => {
    await (
      await admitted("op-1")
    ).completion;
    // A collaboration would run its agents without the checkpoint's seed; only the person's next message delivers it.
    expect(
      await s.core.whileIdle(
        CHAT,
        async () => "claimed",
        { kind: "collaboration_claim" },
        { holds: "claim" },
      ),
    ).toEqual({
      kind: "busy",
      reason:
        "A ready checkpoint is delivered by the next ordinary conversation turn",
    });
    expect(await message()).toMatchObject({ kind: "accepted" });
  });

  it("holds the next message when an applied checkpoint's continuation is gone, for an explicit recovery", async () => {
    await (
      await admitted("op-1")
    ).completion;
    const repo = h.checkpoint.repo;
    const at = new Date().toISOString();
    const binding = {
      attemptId: "attempt-1",
      inputFingerprint: "sha256:input",
      submittedInputFingerprint: "sha256:input",
      queuedAttemptId: null,
      queuedMessageId: null,
    };
    expect(
      (await repo.beginDelivery({ key: KEY, operationId: "op-1", binding, at }))
        .ok,
    ).toBe(true);
    const accepted = await repo.recordAcceptance({
      key: KEY,
      operationId: "op-1",
      acceptance: {
        attemptId: "attempt-1",
        seedHash: "sha256:op-1",
        acceptedAt: at,
      },
      acceptedBackendRef: "sdk-fresh",
    });
    expect(accepted).toMatchObject({ ok: true, value: { phase: "applied" } });

    // The row never received the fresh reference the acceptance names.
    expect(await message()).toMatchObject({
      kind: "refused",
      code: "busy",
      message: expect.stringContaining("--recover op-1"),
    });
    expect(await reloaded().repo.getOperation(KEY, "op-1")).toMatchObject({
      phase: "needs_reconciliation",
    });
    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required" },
    });
  });

  it("settles a build whose failure could not be recorded when it is reconciled", async () => {
    const repo = h.checkpoint.repo;
    let failWrites = true;
    h.checkpoint.repo = {
      ...repo,
      async recordOutcome(input) {
        if (failWrites) throw new Error("database is locked");
        return repo.recordOutcome(input);
      },
    };
    h.checkpoint.generate = async () => ({
      ok: false,
      failure: { code: "build_error", message: "the generator failed" },
      generationPassCount: 1,
      usage: EMPTY_CHECKPOINT_USAGE,
    });
    expect(await (await admitted("op-1")).completion).toMatchObject({
      phase: "building",
    });
    expect(await message()).toMatchObject({ kind: "refused", code: "busy" });

    failWrites = false;
    expect(
      await s.checkpoints.reconcile({ address, operationId: "op-1" }),
    ).toMatchObject({
      kind: "repaired",
      operation: { phase: "failed" },
    });
    expect((await reloaded().row())?.backendRef).toEqual(LIVE_REF);
    expect(await message()).toMatchObject({ kind: "accepted" });
  });
});
