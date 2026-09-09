/**
 * Deterministic reconcile and explicit recovery through the actual provided
 * manager and machine over real SQLite rows. Reconcile retries owned close
 * and persistence work and never sends a model request; recovery supersedes
 * exactly the addressed recovery-required operation and restores its gate if
 * the recovery build does not produce a checkpoint.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import type { ConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";

import { setPersistenceDeps } from "./persistence";
import {
  CHECKPOINT_TRANSCRIPT,
  createCheckpointHarness,
  deferred,
  gatedGenerator,
  seededPrompt,
  transcriptText,
  type CheckpointHarness,
} from "./testing/checkpoint-harness";

let harness: CheckpointHarness | undefined;
let releaseHeld: (() => void) | undefined;

afterEach(async () => {
  releaseHeld?.();
  releaseHeld = undefined;
  if (harness) harness.state.closeRejects = false;
  await harness?.close();
  harness = undefined;
});

function reconcile(operationId: string) {
  if (!harness) throw new Error("harness missing");
  return harness.fixture.manager.reconcileConversationCheckpoint({
    address: harness.fixture.binding.address,
    operationId,
  });
}

/** A repository whose outcome writes throw while `control.fail` is set. */
function failingOutcomeWrites() {
  const control = { fail: false };
  const repo = (
    real: ConversationCheckpointsRepo,
  ): ConversationCheckpointsRepo => ({
    ...real,
    recordOutcome: async (input) => {
      if (control.fail) throw new Error("disk full");
      return real.recordOutcome(input);
    },
  });
  return { control, repo };
}

/**
 * A repository whose operation reads and readiness commits throw while their
 * flag is set — the infrastructure failing under a reconcile, not a refusal
 * it can reason about. `lookupFailsAfterCommit` arms the read fault from
 * inside the failing commit, so only the reads that follow it throw.
 */
function faultingRepo() {
  const control = {
    getOperation: false,
    commitReady: false,
    lookupFailsAfterCommit: false,
  };
  const repo = (
    real: ConversationCheckpointsRepo,
  ): ConversationCheckpointsRepo => ({
    ...real,
    getOperation: async (key, operationId) => {
      if (control.getOperation) throw new Error("database locked");
      return real.getOperation(key, operationId);
    },
    commitReady: async (input) => {
      if (control.commitReady) {
        if (control.lookupFailsAfterCommit) control.getOperation = true;
        throw new Error("database locked");
      }
      return real.commitReady(input);
    },
  });
  const clear = () => {
    control.getOperation = false;
    control.commitReady = false;
    control.lookupFailsAfterCommit = false;
  };
  return { control, repo, clear };
}

/**
 * An unresolved first delivery: the seed was bound to an attempt and a claimed
 * queue row, and the process died before any acceptance was recorded.
 */
async function unresolvedDelivery(h: CheckpointHarness) {
  await h.runOrdinaryTurn();
  const ready = await h.checkpointToReady();
  const queued = await h.enqueue("queued for the delivering turn");
  const claimed = await h.fixture.queue.claimNextTurnBatch(h.fixture.identity);
  if (!claimed) throw new Error("nothing claimed");
  const bound = await h.fixture.checkpoints.beginDelivery({
    key: h.scopeKey,
    operationId: ready.id,
    binding: {
      attemptId: "attempt-crashed",
      inputFingerprint: "sha256:input",
      submittedInputFingerprint: "sha256:input",
      queuedAttemptId: claimed.deliveryAttemptId,
      queuedMessageId: queued.id,
    },
    at: new Date().toISOString(),
  });
  if (!bound.ok) throw new Error(bound.refusal.code);
  h.fixture.restart();
  await h.nudge();
  const held = await h.operation(ready.id);
  expect(held).toMatchObject({
    phase: "needs_reconciliation",
    lastStablePhase: "delivering",
  });
  return { ready, queued };
}

/** A hold produced in-process by a provider close that rejected. */
async function failedCloseHold(h: CheckpointHarness, enqueue?: string) {
  await h.runOrdinaryTurn();
  const queued = enqueue === undefined ? null : await h.enqueue(enqueue);
  h.state.closeRejects = true;
  const started = h.admittedOr(await h.start());
  const held = await started.completion;
  expect(held).toMatchObject({
    phase: "needs_reconciliation",
    lastStablePhase: "retiring",
    failure: { code: "runtime_close_failed" },
  });
  return { held, queued };
}

async function discardQueued(h: CheckpointHarness, id: string) {
  expect(
    await h.fixture.queue.resolveDelivery({
      ...h.fixture.identity,
      id,
      action: "discard",
    }),
  ).toBe("resolved");
}

describe("checkpoint reconcile", () => {
  it("repairs a failed close: retries the close, commits readiness, releases the queue, and sends nothing", async () => {
    harness = await createCheckpointHarness();
    const { held, queued } = await failedCloseHold(
      harness,
      "held under the failed close",
    );
    if (!queued) throw new Error("nothing queued");
    const suspect = harness.latestRuntime();
    const laneCalls = harness.state.laneCalls.length;
    expect((await harness.readRow()).backendRef).toEqual(suspect.ref);

    harness.state.closeRejects = false;
    const result = await reconcile(held.id);
    expect(result).toMatchObject({
      kind: "repaired",
      operation: { id: held.id, phase: "ready", lastStablePhase: null },
    });
    expect(suspect.close).toHaveBeenCalledTimes(2);
    expect(harness.state.laneCalls).toHaveLength(laneCalls);
    expect((await harness.readRow()).backendRef).toBeNull();
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: held.id,
      phase: "ready",
    });
    // The queued message became the next ordinary turn on a fresh runtime.
    await vi.waitFor(() =>
      expect(harness!.state.dispatches).toEqual([
        "first",
        seededPrompt("held under the failed close"),
      ]),
    );
    expect(harness.latestRuntime().input.persistedRef).toBeNull();
    expect(
      (await harness.readRow()).pendingQueue.find((e) => e.id === queued.id),
    ).toBeUndefined();
  });

  it("keeps the operation owned when the close fails again", async () => {
    harness = await createCheckpointHarness();
    const { held } = await failedCloseHold(harness);
    const suspect = harness.latestRuntime();

    const result = await reconcile(held.id);
    expect(result).toMatchObject({
      kind: "blocked",
      operation: { id: held.id, phase: "needs_reconciliation" },
      refusal: { code: "reconciliation_failed", operationId: held.id },
    });
    expect(suspect.close).toHaveBeenCalledTimes(2);
    expect((await harness.readRow()).backendRef).toEqual(suspect.ref);
    expect(harness.hosted().runtime?.maintenance?.phase).toBe(
      "needs_reconciliation",
    );
    expect(await harness.submit("still held")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
  });

  it("repairs readiness receipts that failed before the readiness commit", async () => {
    harness = await createCheckpointHarness();
    await harness.runOrdinaryTurn();
    const queued = await harness.enqueue("after the receipts");
    const store = harness.fixture.persistence.store;
    let failSnapshots = false;
    setPersistenceDeps({
      getConversationMachineSnapshot: store.getConversationMachineSnapshot,
      upsertConversationMachineSnapshot: (owner, conversationId, snapshot) => {
        const cleared =
          (snapshot as { context?: { backendRef?: unknown } }).context
            ?.backendRef === null;
        if (failSnapshots && cleared)
          throw new Error("snapshot disk unavailable");
        return store.upsertConversationMachineSnapshot(
          owner,
          conversationId,
          snapshot,
        );
      },
      deleteConversationMachineSnapshot:
        store.deleteConversationMachineSnapshot,
    });
    const started = harness.admittedOr(await harness.start());
    failSnapshots = true;
    const held = await started.completion;
    failSnapshots = false;
    expect(held).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
    });
    expect(harness.state.dispatches).toEqual(["first"]);

    const result = await reconcile(held.id);
    expect(result).toMatchObject({
      kind: "repaired",
      operation: { id: held.id, phase: "ready" },
    });
    expect(harness.hosted().runtime?.durabilityFailure).toBeUndefined();
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
    await vi.waitFor(() =>
      expect(harness!.state.dispatches).toEqual([
        "first",
        seededPrompt("after the receipts"),
      ]),
    );
    expect(
      (await harness.readRow()).pendingQueue.find((e) => e.id === queued.id),
    ).toBeUndefined();
  });

  it("keeps an unresolved delivery blocked: queue review first, then explicit recovery, never a send", async () => {
    harness = await createCheckpointHarness();
    const { ready, queued } = await unresolvedDelivery(harness);
    const dispatches = [...harness.state.dispatches];

    const reviewFirst = await reconcile(ready.id);
    expect(reviewFirst).toMatchObject({
      kind: "blocked",
      refusal: { code: "queue_review_required", operationId: ready.id },
    });
    await discardQueued(harness, queued.id);
    const recoveryNext = await reconcile(ready.id);
    expect(recoveryNext).toMatchObject({
      kind: "blocked",
      operation: {
        phase: "needs_reconciliation",
        lastStablePhase: "delivering",
        delivery: { attemptId: "attempt-crashed" },
      },
      refusal: {
        code: "recovery_required",
        operationId: ready.id,
        phase: "needs_reconciliation",
      },
    });
    expect(harness.state.dispatches).toEqual(dispatches);
    expect(await harness.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    expect((await harness.readRow()).backendRef).toBeNull();
  });

  it("records a build whose outcome never became durable as failed and releases the host", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    let failWrites = false;
    harness = await createCheckpointHarness({
      generate: gate.generate,
      repo: (repo) => ({
        ...repo,
        recordOutcome: async (input) => {
          if (failWrites) throw new Error("disk full");
          return repo.recordOutcome(input);
        },
      }),
    });
    await harness.runOrdinaryTurn();
    const live = harness.latestRuntime();
    const queued = await harness.enqueue("queued under hold");
    const started = harness.admittedOr(await harness.start());
    await gate.started.promise;
    failWrites = true;
    await harness.fixture.manager.cancelConversationCheckpoint({
      address: harness.fixture.binding.address,
      operationId: started.operation.id,
    });
    expect(harness.hosted().runtime?.maintenance?.outcome).toBe("undurable");
    failWrites = false;

    const result = await reconcile(started.operation.id);
    expect(result).toMatchObject({
      kind: "repaired",
      operation: {
        id: started.operation.id,
        phase: "failed",
        failure: { code: "outcome_unrecorded" },
      },
    });
    expect(live.close).not.toHaveBeenCalled();
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
    await vi.waitFor(() =>
      expect(harness!.state.dispatches).toEqual(["first", "queued under hold"]),
    );
    // The live runtime was never retired, so the drained turn ran on it.
    expect(harness.state.created).toHaveLength(1);
    expect((await harness.readRow()).backendRef).toEqual(live.ref);
    expect(
      (await harness.readRow()).pendingQueue.find((e) => e.id === queued.id),
    ).toBeUndefined();
  });

  it("refuses a running build and an unknown operation, and reports nothing to do for a ready one", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    await harness.runOrdinaryTurn();
    const started = harness.admittedOr(await harness.start());
    await gate.started.promise;
    expect(await reconcile(started.operation.id)).toMatchObject({
      kind: "refused",
      refusal: { code: "conversation_busy", operationId: started.operation.id },
    });
    expect(await reconcile(randomUUID())).toMatchObject({
      kind: "refused",
      refusal: { code: "checkpoint_not_found" },
    });
    gate.release();
    const ready = await started.completion;
    expect(ready.phase).toBe("ready");
    expect(await reconcile(ready.id)).toMatchObject({
      kind: "unchanged",
      operation: { id: ready.id, phase: "ready" },
    });
  });

  it("repairs a failed-close hold after a restart, when no runtime is left to close", async () => {
    harness = await createCheckpointHarness();
    const { held } = await failedCloseHold(harness);
    const suspect = harness.latestRuntime();
    harness.state.closeRejects = false;
    harness.fixture.restart();

    const result = await reconcile(held.id);
    expect(result).toMatchObject({
      kind: "repaired",
      operation: { id: held.id, phase: "ready" },
    });
    // The crashed process's handle is gone; nothing here could close it.
    expect(suspect.close).toHaveBeenCalledTimes(1);
    expect((await harness.readRow()).backendRef).toBeNull();
    expect(harness.hosted().actor?.getSnapshot().context).toMatchObject({
      backendRef: null,
      checkpoint: { operationId: held.id, phase: "ready" },
    });
  });
});

describe("checkpoint reconcile ownership", () => {
  it.each([
    ["an in-process hold", false],
    ["a hold loaded after a restart", true],
  ] as const)(
    "admits one of two concurrent reconciles of %s and refuses the other, which cannot re-hold the repaired operation",
    async (_label, restart) => {
      harness = await createCheckpointHarness();
      const { held } = await failedCloseHold(harness);
      harness.state.closeRejects = false;
      if (restart) harness.fixture.restart();

      const outcomes = await Promise.all([
        reconcile(held.id),
        reconcile(held.id),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual([
        "refused",
        "repaired",
      ]);
      const refused = outcomes.find((o) => o.kind === "refused");
      if (refused?.kind !== "refused") throw new Error("no refusal");
      expect(refused.refusal).toMatchObject({
        code: "conversation_busy",
        operationId: held.id,
      });
      expect((await harness.operation(held.id))?.phase).toBe("ready");
      expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
        operationId: held.id,
        phase: "ready",
      });
      expect(harness.hosted().runtime?.maintenance).toBeUndefined();
      expect(await harness.submit("after the repair")).toMatchObject({
        kind: "accepted",
      });
    },
  );

  it("owns a loaded hold from its first synchronous step: a recovery arriving while the reconcile is still reading is refused as pending", async () => {
    const reads = deferred();
    releaseHeld = reads.resolve;
    let gateNextRead = false;
    harness = await createCheckpointHarness({
      repo: (repo) => ({
        ...repo,
        getStateForAdmission: async (key) => {
          if (gateNextRead) {
            gateNextRead = false;
            await reads.promise;
          }
          return repo.getStateForAdmission(key);
        },
      }),
    });
    const { held } = await failedCloseHold(harness);
    harness.state.closeRejects = false;
    harness.fixture.restart();

    gateNextRead = true;
    const repair = reconcile(held.id);
    const recovery = await harness.start(randomUUID(), held.id);
    expect(recovery).toMatchObject({
      kind: "refused",
      refusal: { code: "checkpoint_pending", operationId: held.id },
    });

    reads.resolve();
    expect(await repair).toMatchObject({
      kind: "repaired",
      operation: { id: held.id, phase: "ready" },
    });
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: held.id,
      phase: "ready",
    });
  });
});

describe("checkpoint recovery", () => {
  it("supersedes the addressed unresolved delivery after queue review, builds from the whole archive, and reaches ready", async () => {
    harness = await createCheckpointHarness();
    const { ready, queued } = await unresolvedDelivery(harness);
    // History recorded after the checkpoint belongs in the recovery seed.
    harness.fixture.transcripts.set(CHECKPOINT_TRANSCRIPT, [
      ...harness.fixture.transcripts.get(CHECKPOINT_TRANSCRIPT)!,
      transcriptText(4, "user", "after the checkpoint: rotate the vault key"),
      transcriptText(5, "assistant", "rotating the key now"),
    ]);
    const laneCallsBefore = harness.state.laneCalls.length;
    await discardQueued(harness, queued.id);

    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), ready.id),
    );
    expect(recovery.kind).toBe("admitted");
    expect(recovery.operation).toMatchObject({
      phase: "building",
      recoversOperationId: ready.id,
      ordinal: ready.ordinal + 1,
      sourceBasis: { capturedThroughSeq: 5 },
    });
    const done = await recovery.completion;
    expect(done).toMatchObject({
      phase: "ready",
      recoversOperationId: ready.id,
      payloadId: recovery.operation.id,
    });
    expect(harness.state.laneCalls.length).toBeGreaterThan(laneCallsBefore);
    const payload = await harness.fixture.checkpoints.getPayload(
      harness.scopeKey,
      done.id,
    );
    expect(payload?.seedText).toContain("rotate the vault key");

    const prior = await harness.operation(ready.id);
    expect(prior).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      supersededByOperationId: done.id,
      delivery: { attemptId: "attempt-crashed" },
    });
    const page = await harness.fixture.checkpoints.listReceipts(
      harness.scopeKey,
    );
    expect(page.receipts.map((r) => [r.ordinal, r.phase])).toEqual([
      [done.ordinal, "ready"],
      [ready.ordinal, "needs_reconciliation"],
    ]);
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: done.id,
      phase: "ready",
    });
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
    await harness.enqueue("first turn after recovery");
    await harness.nudge();
    await vi.waitFor(() =>
      expect(harness!.state.dispatches.at(-1)).toEqual(
        seededPrompt("first turn after recovery"),
      ),
    );
    expect(harness.latestRuntime().input.persistedRef).toBeNull();
  });

  it("refuses recovery while queued deliveries need review, and an ordinary start against the blocked operation", async () => {
    harness = await createCheckpointHarness();
    const { ready, queued } = await unresolvedDelivery(harness);
    expect(await harness.start(randomUUID(), ready.id)).toMatchObject({
      kind: "refused",
      refusal: { code: "queue_review_required" },
    });
    await discardQueued(harness, queued.id);
    expect(await harness.start(randomUUID())).toMatchObject({
      kind: "refused",
      refusal: {
        code: "recovery_required",
        operationId: ready.id,
        phase: "needs_reconciliation",
      },
    });
    expect((await harness.operation(ready.id))?.phase).toBe(
      "needs_reconciliation",
    );
  });

  it("refuses recovery that names an operation not requiring recovery, or none at all", async () => {
    harness = await createCheckpointHarness();
    await harness.runOrdinaryTurn();
    const ready = await harness.checkpointToReady();
    expect(await harness.start(randomUUID(), ready.id)).toMatchObject({
      kind: "refused",
      refusal: {
        code: "recovery_target_mismatch",
        operationId: ready.id,
        phase: "ready",
      },
    });
    expect(await harness.start(randomUUID(), randomUUID())).toMatchObject({
      kind: "refused",
      refusal: { code: "recovery_target_mismatch" },
    });
    expect((await harness.operation(ready.id))?.phase).toBe("ready");
  });

  it("lets one of two concurrent recovery requests win, and reuses the winner's request id", async () => {
    const gate = gatedGenerator({ armed: false });
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    const { ready, queued } = await unresolvedDelivery(harness);
    await discardQueued(harness, queued.id);
    gate.arm();

    const [a, b] = await Promise.all([
      harness.start("11111111-1111-4111-8111-111111111111", ready.id),
      harness.start("22222222-2222-4222-8222-222222222222", ready.id),
    ]);
    const outcomes = [a.kind, b.kind].sort();
    expect(outcomes).toEqual(["admitted", "refused"]);
    const winner = a.kind === "admitted" ? a : b;
    const loser = a.kind === "refused" ? a : b;
    if (winner.kind === "refused" || loser.kind !== "refused")
      throw new Error("unexpected outcomes");
    expect(loser.refusal.code).toBe("checkpoint_pending");
    const repeated = await harness.start(winner.operation.id, ready.id);
    expect(repeated).toMatchObject({
      kind: "reused",
      operation: { id: winner.operation.id },
    });
    gate.release();
    expect(await winner.completion).toMatchObject({ phase: "ready" });
  });

  it("restores the prior gate when the recovery build fails, and a later recovery succeeds", async () => {
    let failNext = false;
    harness = await createCheckpointHarness({
      generate: async (input, deps) => {
        if (failNext) {
          failNext = false;
          throw new Error("lane exploded");
        }
        return generateCheckpoint(input, deps);
      },
    });
    const { held, queued } = await failedCloseHold(
      harness,
      "must not drain into uncertainty",
    );
    if (!queued) throw new Error("nothing queued");
    const suspect = harness.latestRuntime();
    harness.state.closeRejects = false;
    failNext = true;

    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), held.id),
    );
    const failed = await recovery.completion;
    expect(failed).toMatchObject({
      phase: "failed",
      recoversOperationId: held.id,
      failure: { code: "build_error" },
    });
    expect(await harness.operation(held.id)).toMatchObject({
      phase: "needs_reconciliation",
      supersededByOperationId: null,
    });
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: held.id,
      phase: "needs_reconciliation",
    });
    expect(harness.hosted().runtime?.maintenance).toMatchObject({
      operationId: held.id,
      phase: "needs_reconciliation",
    });
    expect(await harness.submit("still blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    expect((await harness.readRow()).pendingQueue).toMatchObject([
      { id: queued.id, status: "pending" },
    ]);
    expect(harness.state.dispatches).toEqual(["first"]);
    // The suspect runtime was not closed by the failed build.
    expect(suspect.close).toHaveBeenCalledTimes(1);
    const check = await harness.check();
    expect(check.refusals).toContainEqual(
      expect.objectContaining({
        code: "recovery_required",
        operationId: held.id,
      }),
    );

    const again = harness.admittedOr(
      await harness.start(randomUUID(), held.id),
    );
    expect(await again.completion).toMatchObject({
      phase: "ready",
      recoversOperationId: held.id,
    });
    expect(suspect.close).toHaveBeenCalledTimes(2);
    expect((await harness.readRow()).backendRef).toBeNull();
    await vi.waitFor(() =>
      expect(harness!.state.dispatches).toEqual([
        "first",
        seededPrompt("must not drain into uncertainty"),
      ]),
    );
  });

  it("restores the prior gate when a recovery build is cancelled", async () => {
    const gate = gatedGenerator({ armed: false });
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    const { held } = await failedCloseHold(harness);
    harness.state.closeRejects = false;
    gate.arm();
    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), held.id),
    );
    await gate.started.promise;
    const cancelled =
      await harness.fixture.manager.cancelConversationCheckpoint({
        address: harness.fixture.binding.address,
        operationId: recovery.operation.id,
      });
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      operation: { phase: "cancelled", recoversOperationId: held.id },
    });
    expect(await harness.operation(held.id)).toMatchObject({
      phase: "needs_reconciliation",
      supersededByOperationId: null,
    });
    expect(harness.hosted().runtime?.maintenance?.operationId).toBe(held.id);
    expect(await harness.submit("still blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    expect(harness.state.dispatches).toEqual(["first"]);
  });

  it("finishes forward when a cancel lands after the recovery froze", async () => {
    harness = await createCheckpointHarness();
    const { held } = await failedCloseHold(harness);
    harness.state.closeRejects = false;
    const closing = deferred();
    harness.state.holdClose = closing.promise;
    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), held.id),
    );
    await vi.waitFor(() =>
      expect(harness!.hosted().runtime?.maintenance?.phase).toBe("retiring"),
    );
    const cancelling = harness.fixture.manager.cancelConversationCheckpoint({
      address: harness.fixture.binding.address,
      operationId: recovery.operation.id,
    });
    closing.resolve();
    expect(await cancelling).toMatchObject({
      kind: "completed",
      operation: { phase: "ready", recoversOperationId: held.id },
    });
    expect((await harness.operation(held.id))?.supersededByOperationId).toBe(
      recovery.operation.id,
    );
  });

  it("keeps a recovery whose close fails owned, and lets reconcile repair it", async () => {
    harness = await createCheckpointHarness();
    const { held } = await failedCloseHold(harness);
    const suspect = harness.latestRuntime();
    // The suspect runtime keeps refusing to close during the recovery too.
    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), held.id),
    );
    const blocked = await recovery.completion;
    expect(blocked).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
      recoversOperationId: held.id,
      failure: { code: "runtime_close_failed" },
    });
    expect((await harness.operation(held.id))?.supersededByOperationId).toBe(
      blocked.id,
    );
    expect(harness.hosted().runtime?.maintenance?.operationId).toBe(blocked.id);

    harness.state.closeRejects = false;
    expect(await reconcile(blocked.id)).toMatchObject({
      kind: "repaired",
      operation: { id: blocked.id, phase: "ready" },
    });
    expect(suspect.close).toHaveBeenCalledTimes(3);
    expect((await harness.readRow()).backendRef).toBeNull();
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
  });

  it("restores the prior gate when a restart interrupts the recovery build", async () => {
    const gate = gatedGenerator({ armed: false });
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    const { ready, queued } = await unresolvedDelivery(harness);
    await discardQueued(harness, queued.id);
    gate.arm();
    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), ready.id),
    );
    await gate.started.promise;

    harness.fixture.restart();
    await harness.nudge();

    expect(await harness.operation(recovery.operation.id)).toMatchObject({
      phase: "failed",
      failure: { code: "interrupted" },
      recoversOperationId: ready.id,
    });
    expect(await harness.operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      supersededByOperationId: null,
    });
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "needs_reconciliation",
    });
    expect(await harness.submit("still blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
  });

  it("recovers a lost applied continuation and keeps the earlier acceptance evidence", async () => {
    harness = await createCheckpointHarness();
    await harness.runOrdinaryTurn();
    const ready = await harness.checkpointToReady();
    const repo = harness.fixture.checkpoints;
    const at = new Date().toISOString();
    const payload = await repo.getPayload(harness.scopeKey, ready.id);
    const bound = await repo.beginDelivery({
      key: harness.scopeKey,
      operationId: ready.id,
      binding: {
        attemptId: "attempt-applied",
        inputFingerprint: "sha256:input",
        submittedInputFingerprint: "sha256:input",
        queuedAttemptId: null,
        queuedMessageId: null,
      },
      at,
    });
    if (!bound.ok) throw new Error(bound.refusal.code);
    const applied = await repo.recordAcceptance({
      key: harness.scopeKey,
      operationId: ready.id,
      acceptance: {
        attemptId: "attempt-applied",
        seedHash: payload!.seedSha256,
        acceptedAt: at,
      },
      acceptedBackendRef: "sdk-session-accepted",
    });
    if (!applied.ok) throw new Error(applied.refusal.code);
    const lost = await repo.recordOutcome({
      key: harness.scopeKey,
      operationId: ready.id,
      expectedPhase: "applied",
      phase: "needs_reconciliation",
      failure: {
        code: "continuation_unusable",
        message: "the provider rejected the accepted session",
      },
      at,
    });
    if (!lost.ok) throw new Error(lost.refusal.code);
    // The loss was recorded durably; the host learns it the way it would
    // after a restart.
    harness.fixture.restart();
    await harness.nudge();
    expect(await reconcile(ready.id)).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required", operationId: ready.id },
    });

    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), ready.id),
    );
    const done = await recovery.completion;
    expect(done).toMatchObject({
      phase: "ready",
      recoversOperationId: ready.id,
    });

    const prior = await harness.operation(ready.id);
    expect(prior).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "applied",
      supersededByOperationId: done.id,
      acceptance: {
        attemptId: "attempt-applied",
        seedHash: payload!.seedSha256,
      },
      protectedReferences: { acceptedBackendRef: "sdk-session-accepted" },
    });
    const state = await repo.getStateForAdmission(harness.scopeKey);
    expect(state.latestAccepted?.operationId).toBe(ready.id);
    expect(state.active?.id).toBe(done.id);
  });

  it.each([
    ["fails", "failed"],
    ["is cancelled", "cancelled"],
  ] as const)(
    "keeps the restored gate when a recovery build %s and reconcile is what records its outcome",
    async (_label, how) => {
      const gate = gatedGenerator({ armed: false });
      releaseHeld = gate.release;
      let explode = false;
      const writes = failingOutcomeWrites();
      harness = await createCheckpointHarness({
        generate: (input, deps) => {
          if (explode) throw new Error("lane exploded");
          return gate.generate(input, deps);
        },
        repo: writes.repo,
      });
      const { held, queued } = await failedCloseHold(
        harness,
        "must stay queued",
      );
      if (!queued) throw new Error("nothing queued");
      harness.state.closeRejects = false;
      const suspect = harness.latestRuntime();

      if (how === "failed") explode = true;
      else gate.arm();
      writes.control.fail = true;
      const recovery = harness.admittedOr(
        await harness.start(randomUUID(), held.id),
      );
      if (how === "cancelled") {
        await gate.started.promise;
        await harness.fixture.manager.cancelConversationCheckpoint({
          address: harness.fixture.binding.address,
          operationId: recovery.operation.id,
        });
      }
      await recovery.completion;
      // The build ended, but its outcome never reached the repository: the
      // durable phase still says building and the prior gate is still
      // superseded.
      expect(harness.hosted().runtime?.maintenance).toMatchObject({
        operationId: recovery.operation.id,
        outcome: "undurable",
      });
      expect((await harness.operation(recovery.operation.id))?.phase).toBe(
        "building",
      );
      expect((await harness.operation(held.id))?.supersededByOperationId).toBe(
        recovery.operation.id,
      );
      writes.control.fail = false;
      explode = false;

      const result = await reconcile(recovery.operation.id);
      expect(result).toMatchObject({
        kind: "blocked",
        operation: {
          id: recovery.operation.id,
          phase: "failed",
          failure: { code: "outcome_unrecorded" },
          recoversOperationId: held.id,
        },
        refusal: {
          code: "recovery_required",
          operationId: held.id,
          phase: "needs_reconciliation",
        },
      });
      expect(await harness.operation(held.id)).toMatchObject({
        phase: "needs_reconciliation",
        supersededByOperationId: null,
      });
      expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
        operationId: held.id,
        phase: "needs_reconciliation",
      });
      expect(harness.hosted().runtime?.maintenance).toMatchObject({
        operationId: held.id,
        phase: "needs_reconciliation",
        outcome: "durable",
      });
      expect(await harness.submit("still blocked")).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      expect(harness.state.dispatches).toEqual(["first"]);
      expect((await harness.readRow()).pendingQueue).toMatchObject([
        { id: queued.id, status: "pending" },
      ]);
      expect(suspect.close).toHaveBeenCalledTimes(1);

      // The restored gate is a live hold: a later recovery supersedes it.
      gate.release();
      const again = harness.admittedOr(
        await harness.start(randomUUID(), held.id),
      );
      expect(await again.completion).toMatchObject({
        phase: "ready",
        recoversOperationId: held.id,
      });
      expect(harness.hosted().runtime?.maintenance).toBeUndefined();
      await vi.waitFor(() =>
        expect(harness!.state.dispatches).toEqual([
          "first",
          seededPrompt("must stay queued"),
        ]),
      );
    },
  );
});

describe("checkpoint reconcile exception safety", () => {
  const holds = [
    ["an in-process hold", false],
    ["a hold loaded after a restart", true],
  ] as const;

  it.each(holds)(
    "hands back its claim on %s when the operation read throws: the next reconcile repairs and recovery is not refused as pending",
    async (_label, restart) => {
      const faults = faultingRepo();
      harness = await createCheckpointHarness({ repo: faults.repo });
      const { held } = await failedCloseHold(harness);
      harness.state.closeRejects = false;
      if (restart) harness.fixture.restart();

      faults.control.getOperation = true;
      await expect(reconcile(held.id)).rejects.toThrow("database locked");
      faults.clear();

      // The failed call left nothing behind that a later caller mistakes for
      // a reconcile in progress.
      expect(await harness.check(held.id)).toMatchObject({ eligible: true });
      expect(await reconcile(held.id)).toMatchObject({
        kind: "repaired",
        operation: { id: held.id, phase: "ready" },
      });
      expect(harness.hosted().runtime?.maintenance).toBeUndefined();
      expect(await harness.submit("after the repair")).toMatchObject({
        kind: "accepted",
      });
    },
  );

  it.each(holds)(
    "keeps %s when the readiness commit throws after the close: the actor stays held, admission stays refused, and the next reconcile repairs it",
    async (_label, restart) => {
      const faults = faultingRepo();
      harness = await createCheckpointHarness({ repo: faults.repo });
      const { held, queued } = await failedCloseHold(
        harness,
        "must stay queued",
      );
      if (!queued) throw new Error("nothing queued");
      harness.state.closeRejects = false;
      if (restart) harness.fixture.restart();

      faults.control.commitReady = true;
      const result = await reconcile(held.id);
      faults.clear();
      expect(result).toMatchObject({
        kind: "blocked",
        operation: { id: held.id, phase: "needs_reconciliation" },
        refusal: { code: "reconciliation_failed", operationId: held.id },
      });
      // The durable record still needs reconciliation, and the projection
      // says so too — not the readiness this call never committed.
      expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
        operationId: held.id,
        phase: "needs_reconciliation",
      });
      expect(await harness.submit("still blocked")).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      expect(harness.state.dispatches).toEqual(["first"]);
      expect((await harness.readRow()).pendingQueue).toMatchObject([
        { id: queued.id, status: "pending" },
      ]);

      expect(await reconcile(held.id)).toMatchObject({
        kind: "repaired",
        operation: { id: held.id, phase: "ready" },
      });
      expect(harness.hosted().runtime?.maintenance).toBeUndefined();
      const { dispatches } = harness.state;
      await vi.waitFor(() =>
        expect(dispatches).toEqual(["first", seededPrompt("must stay queued")]),
      );
    },
  );

  it.each(holds)(
    "keeps %s when the repair and the lookup that follows it both throw, and repairs it on the next reconcile",
    async (_label, restart) => {
      const faults = faultingRepo();
      harness = await createCheckpointHarness({ repo: faults.repo });
      const { held } = await failedCloseHold(harness);
      harness.state.closeRejects = false;
      if (restart) harness.fixture.restart();

      faults.control.commitReady = true;
      faults.control.lookupFailsAfterCommit = true;
      const result = await reconcile(held.id);
      faults.clear();
      expect(result).toMatchObject({
        kind: "blocked",
        operation: { id: held.id, phase: "needs_reconciliation" },
        refusal: { code: "reconciliation_failed", operationId: held.id },
      });
      expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
        operationId: held.id,
        phase: "needs_reconciliation",
      });
      expect(await harness.submit("still blocked")).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      expect(harness.state.dispatches).toEqual(["first"]);

      expect(await reconcile(held.id)).toMatchObject({
        kind: "repaired",
        operation: { id: held.id, phase: "ready" },
      });
      expect(harness.hosted().runtime?.maintenance).toBeUndefined();
      expect(await harness.submit("after the repair")).toMatchObject({
        kind: "accepted",
      });
    },
  );

  it.each(holds)(
    "keeps %s when readiness receipts fail while outcome writes are unavailable; the next reconcile settles the receipts and publishes",
    async (_label, restart) => {
      const writes = failingOutcomeWrites();
      harness = await createCheckpointHarness({ repo: writes.repo });
      const { held, queued } = await failedCloseHold(
        harness,
        "must stay queued",
      );
      if (!queued) throw new Error("nothing queued");
      harness.state.closeRejects = false;
      if (restart) harness.fixture.restart();
      const store = harness.fixture.persistence.store;
      let failSnapshots = false;
      setPersistenceDeps({
        getConversationMachineSnapshot: store.getConversationMachineSnapshot,
        upsertConversationMachineSnapshot: (
          owner,
          conversationId,
          snapshot,
        ) => {
          const cleared =
            (snapshot as { context?: { backendRef?: unknown } }).context
              ?.backendRef === null;
          if (failSnapshots && cleared)
            throw new Error("snapshot disk unavailable");
          return store.upsertConversationMachineSnapshot(
            owner,
            conversationId,
            snapshot,
          );
        },
        deleteConversationMachineSnapshot:
          store.deleteConversationMachineSnapshot,
      });

      failSnapshots = true;
      writes.control.fail = true;
      const result = await reconcile(held.id);
      failSnapshots = false;
      writes.control.fail = false;
      expect(result).toMatchObject({
        kind: "blocked",
        operation: { id: held.id, phase: "needs_reconciliation" },
        refusal: { code: "reconciliation_failed", operationId: held.id },
      });
      expect(await harness.operation(held.id)).toEqual(held);
      expect(await harness.submit("still blocked")).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      expect(harness.state.dispatches).toEqual(["first"]);
      expect((await harness.readRow()).pendingQueue).toMatchObject([
        { id: queued.id, status: "pending" },
      ]);

      expect(await reconcile(held.id)).toMatchObject({
        kind: "repaired",
        operation: { id: held.id, phase: "ready" },
      });
      expect(harness.hosted().runtime?.durabilityFailure).toBeUndefined();
      expect(harness.hosted().runtime?.maintenance).toBeUndefined();
      const { dispatches } = harness.state;
      await vi.waitFor(() =>
        expect(dispatches).toEqual(["first", seededPrompt("must stay queued")]),
      );
    },
  );

  it("settles a hold it kept after an unknown-delivery repair threw: queue review, reconcile and explicit recovery then proceed", async () => {
    let failAdmissionRead = false;
    harness = await createCheckpointHarness({
      beforeAdmissionStateRead: async () => {
        if (!failAdmissionRead) return;
        failAdmissionRead = false;
        throw new Error("database locked");
      },
    });
    const { ready, queued } = await unresolvedDelivery(harness);

    failAdmissionRead = true;
    expect(await reconcile(ready.id)).toMatchObject({
      kind: "blocked",
      operation: {
        id: ready.id,
        phase: "needs_reconciliation",
        lastStablePhase: "delivering",
      },
      refusal: { code: "reconciliation_failed", operationId: ready.id },
    });
    expect(await harness.submit("still blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    expect(harness.state.dispatches).toEqual(["first"]);

    // The kept hold still answers with the prescribed sequence: queue
    // review, a reconcile that names recovery, then the explicit recovery.
    expect(await reconcile(ready.id)).toMatchObject({
      kind: "blocked",
      refusal: { code: "queue_review_required", operationId: ready.id },
    });
    await discardQueued(harness, queued.id);
    expect(await reconcile(ready.id)).toMatchObject({
      kind: "blocked",
      refusal: { code: "recovery_required", operationId: ready.id },
    });
    const recovery = harness.admittedOr(
      await harness.start(randomUUID(), ready.id),
    );
    expect(recovery.operation).toMatchObject({
      phase: "building",
      recoversOperationId: ready.id,
    });
    const done = await recovery.completion;
    expect(done).toMatchObject({
      phase: "ready",
      recoversOperationId: ready.id,
    });
    expect((await harness.operation(ready.id))?.supersededByOperationId).toBe(
      done.id,
    );
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: done.id,
      phase: "ready",
    });
    expect(harness.hosted().runtime?.maintenance).toBeUndefined();
    expect(harness.state.dispatches).toEqual(["first"]);
  });
});
