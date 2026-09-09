/**
 * First-turn checkpoint delivery through the actual provided manager and
 * machine over real SQLite rows: the next ordinary turn after readiness runs
 * on a fresh runtime seeded with the exact frozen payload, acceptance is
 * recorded once against the admitted attempt, and every later turn resumes
 * the accepted continuation without the seed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeUndeliveredPromptFailure } from "@/lib/agent-backends/testing/undelivered-prompt-fixture";
import {
  fingerprintAssembledInput,
  fingerprintSubmittedInput,
} from "@/lib/conversation-checkpoints/input-fingerprint";
import type { MemoryIndexContextRequest } from "@/lib/memory/index-live-context";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";

import {
  createCheckpointHarness,
  type CheckpointHarness,
} from "./testing/checkpoint-harness";

let harness: CheckpointHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function payloadOf(h: CheckpointHarness, operationId: string) {
  const payload = await h.fixture.checkpoints.getPayload(
    h.scopeKey,
    operationId,
  );
  if (!payload) throw new Error("payload missing");
  return payload;
}

describe("first ordinary turn after readiness", () => {
  it.each(["session", "project"] as const)(
    "%s: seeds a fresh runtime with the exact frozen bytes ahead of the user's input, applies once, and resumes that continuation afterwards",
    async (scope) => {
      harness = await createCheckpointHarness({ scope });
      const h = harness;
      await h.runOrdinaryTurn();
      const retired = h.latestRuntime().ref;
      const ready = await h.checkpointToReady();
      const payload = await payloadOf(h, ready.id);
      const before = await h.readRow();
      const laneCallsBefore = h.state.laneCalls.length;
      const dispatchesBefore = h.state.dispatches.length;

      const settled = await h.runOrdinaryTurn("after the checkpoint");

      // Fresh continuity: a new runtime created with no resume handle and no
      // native fork parent, reporting a reference the retired one never had.
      const fresh = h.latestRuntime();
      expect(fresh.input.persistedRef).toBeNull();
      expect(fresh.ref).not.toEqual(retired);
      // Exactly one provider dispatch: the exact seed, then the actual input.
      expect(h.state.dispatches).toHaveLength(dispatchesBefore + 1);
      expect(h.state.dispatches.at(-1)).toBe(
        `${payload.seedText}\n\nafter the checkpoint`,
      );
      expect(h.state.turnInputs.at(-1)?.syntheticForkSeed ?? null).toBeNull();
      // Applied once, against the admitted attempt and the frozen hash.
      expect(await h.operation(ready.id)).toMatchObject({
        phase: "applied",
        delivery: {
          attemptId: settled.attemptId,
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        acceptance: {
          attemptId: settled.attemptId,
          seedHash: payload.seedSha256,
        },
        protectedReferences: {
          priorBackendRef: retired.ref,
          acceptedBackendRef: fresh.ref.ref,
        },
      });
      // The actor no longer projects an active checkpoint; the row names the
      // accepted reference; identity, worktree, backend and profile are as
      // they were, and exactly one ordinary turn was counted.
      expect(h.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
      const after = await h.readRow();
      expect(after.backendRef).toEqual(fresh.ref);
      expect(after.id).toBe(before.id);
      expect(after.transcriptPath).toBe(before.transcriptPath);
      expect(after.agentBackend).toBe(before.agentBackend);
      expect(after.profileSnapshot).toEqual(before.profileSnapshot);
      expect(after.forkedFrom).toEqual(before.forkedFrom);
      expect(after.promptCount).toBe(before.promptCount + 1);
      expect(fresh.input.worktreePath).toBe(
        h.state.created[0]?.input.worktreePath,
      );
      expect(fresh.input.conversationId).toBe(before.id);
      // No compaction or workflow work was triggered by the delivery.
      expect(h.state.laneCalls).toHaveLength(laneCallsBefore);
      const admission = await h.check();
      expect(admission.active).toBeNull();

      // The following turn resumes the accepted continuation and omits the seed.
      await h.runOrdinaryTurn("second");
      expect(h.latestRuntime()).toBe(fresh);
      expect(h.state.dispatches.at(-1)).toBe("second");
      expect((await h.operation(ready.id))?.phase).toBe("applied");
      expect((await h.readRow()).backendRef).toEqual(fresh.ref);
    },
  );

  it("archives only the actual user message, keeps the normal runtime setup, and logs the planned fresh start rather than a missing resume handle", async () => {
    const userEntries: { id?: string; content?: unknown }[] = [];
    const log = createCapturingLogger();
    harness = await createCheckpointHarness({
      actorDeps: {
        log,
        safeAppendTranscriptEntry: vi.fn(async (_id, entry) => {
          if (entry.role === "user") userEntries.push(entry);
        }),
      },
    });
    const h = harness;
    await h.runOrdinaryTurn();
    const first = h.latestRuntime();
    const ready = await h.checkpointToReady();
    const payload = await payloadOf(h, ready.id);
    userEntries.length = 0;
    const logged = log.entries.length;

    await h.runOrdinaryTurn("after the checkpoint");
    const messages = log.entries.slice(logged).map((entry) => entry.message);

    // The archive holds the user's actual message and nothing of the seed;
    // the seed lives only in its own frozen payload.
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.content).toEqual([
      { type: "text", text: "after the checkpoint" },
    ]);
    expect(JSON.stringify(userEntries[0])).not.toContain(payload.seedText);
    // Same profile, model, instructions and tooling as the retired runtime.
    const fresh = h.latestRuntime();
    expect(fresh.input.modelSelection).toEqual(first.input.modelSelection);
    expect(fresh.input.sessionInstructions).toEqual(
      first.input.sessionInstructions,
    );
    expect(fresh.input.tooling).toEqual(first.input.tooling);
    expect(fresh.input.worktreePath).toBe(first.input.worktreePath);
    // The planned fresh start is a checkpoint lifecycle event, not the
    // unexplained-continuity warning.
    expect(messages).toContain("checkpoint.fresh_runtime");
    expect(messages).not.toContain("prompt.resume_ref_missing");
  });

  it("supersedes an older synthetic fork seed without touching its provenance, on the delivery turn and afterwards", async () => {
    const forkedFrom = {
      sourceConversationId: "source",
      messageIndex: 1,
      sourceBackend: "claude" as const,
      sourceBackendRef: null,
      forkLocator: null,
      forkMode: "synthetic" as const,
      forkPending: false,
      syntheticSeed: "older fork history",
      syntheticSeedAcceptedRef: {
        backend: "claude" as const,
        ref: "sdk-session-seeded",
      },
    };
    harness = await createCheckpointHarness({ conversation: { forkedFrom } });
    const h = harness;
    await h.runOrdinaryTurn();
    // The seeded reference already accepted the fork seed: no seed on resume.
    expect(h.state.turnInputs.at(-1)?.syntheticForkSeed ?? null).toBeNull();
    const ready = await h.checkpointToReady();
    const payload = await payloadOf(h, ready.id);

    await h.runOrdinaryTurn("after the checkpoint");
    expect(h.state.dispatches.at(-1)).toBe(
      `${payload.seedText}\n\nafter the checkpoint`,
    );
    expect(h.state.turnInputs.at(-1)?.syntheticForkSeed ?? null).toBeNull();
    expect((await h.readRow()).forkedFrom).toEqual(forkedFrom);

    // The accepted reference differs from the fork's accepted one, which
    // would have re-fired the fork seed; the checkpoint lineage suppresses it.
    await h.runOrdinaryTurn("second");
    expect(h.state.dispatches.at(-1)).toBe("second");
    expect(h.state.turnInputs.at(-1)?.syntheticForkSeed ?? null).toBeNull();
    expect((await h.readRow()).forkedFrom).toEqual(forkedFrom);
  });

  it("delivers the seed with a queued message, binding the queued attempt and row, and marks the row delivered", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const payload = await payloadOf(h, ready.id);
    const queued = await h.enqueue("queued after readiness");

    await h.nudge();
    await vi.waitFor(() =>
      expect(h.state.dispatches.at(-1)).toBe(
        `${payload.seedText}\n\nqueued after readiness`,
      ),
    );
    await vi.waitFor(async () =>
      expect((await h.operation(ready.id))?.phase).toBe("applied"),
    );
    const operation = await h.operation(ready.id);
    expect(operation?.delivery).toMatchObject({
      queuedMessageId: queued.id,
      attemptId: operation?.acceptance?.attemptId,
    });
    expect(operation?.delivery?.queuedAttemptId).toEqual(expect.any(String));
    await vi.waitFor(async () => {
      const row = await h.readRow();
      expect(row.pendingQueue.map((entry) => entry.id)).not.toContain(
        queued.id,
      );
      expect(row.backendRef).toEqual(h.latestRuntime().ref);
    });
    expect(h.latestRuntime().input.persistedRef).toBeNull();
  });

  it("gives the first fresh runtime the ordinary full memory delivery exactly once, and the next turn a delta", async () => {
    const requests: MemoryIndexContextRequest[] = [];
    harness = await createCheckpointHarness({
      actorDeps: {
        getMemoryIndexBlock: vi.fn(
          async (request: MemoryIndexContextRequest) => {
            requests.push(request);
            return null;
          },
        ),
      },
    });
    const h = harness;
    await h.runOrdinaryTurn();
    expect(requests.at(-1)?.runtimeCreatedWithoutResume).toBe(false);
    await h.checkpointToReady();
    await h.runOrdinaryTurn("after the checkpoint");
    expect(requests.at(-1)?.runtimeCreatedWithoutResume).toBe(true);
    expect(requests).toHaveLength(2);
    await h.runOrdinaryTurn("second");
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)?.runtimeCreatedWithoutResume).toBe(false);
  });

  it("refuses a task run while a checkpoint is ready, so the seed can only be delivered by an ordinary turn", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const admission = await h.fixture.manager.submitConversationTurn({
      binding: h.fixture.binding,
      turn: {
        kind: "task_run",
        promptText: "task",
        executionClass: "nongoverned-task",
      },
    });
    expect(admission).toMatchObject({ kind: "refused", code: "busy" });
    expect((await h.operation(ready.id))?.phase).toBe("ready");
  });
});

describe("attempt-bound acceptance", () => {
  it("applies the seed when the fresh reference arrives before the input is accepted", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    h.state.emitTurnEvents = async (turn, ref) => {
      await turn.onEvent({ type: "backend_init", backendRef: ref });
      await turn.onEvent({ type: "input_accepted" });
    };
    const settled = await h.runOrdinaryTurn("reversed order");
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: settled.attemptId },
      protectedReferences: { acceptedBackendRef: h.latestRuntime().ref.ref },
    });
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
  });

  it("does not apply on the reference alone: a turn that only initialized holds for reconciliation with the queue held", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    h.state.emitTurnEvents = async (turn, ref) => {
      await turn.onEvent({ type: "backend_init", backendRef: ref });
    };
    const settled = await h.runOrdinaryTurn("reference only");
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
      delivery: { attemptId: settled.attemptId },
      acceptance: null,
      protectedReferences: { acceptedBackendRef: null },
    });
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "needs_reconciliation",
    });
    const dispatches = h.state.dispatches.length;
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    await h.enqueue("must stay queued");
    await h.nudge();
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect((await h.readRow()).pendingQueue).toMatchObject([
      { status: "pending" },
    ]);
    const check = await h.check();
    expect(check.refusals).toContainEqual(
      expect.objectContaining({
        code: "recovery_required",
        operationId: ready.id,
      }),
    );
  });

  it("retains a failed acceptance write, holds the host and queue, and repairs the same receipt without resending", async () => {
    let failAcceptance = false;
    let acceptanceWrites = 0;
    harness = await createCheckpointHarness({
      repo: (real) => ({
        ...real,
        recordAcceptance: async (input) => {
          acceptanceWrites += 1;
          if (failAcceptance) throw new Error("disk full");
          return real.recordAcceptance(input);
        },
      }),
    });
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    await h.enqueue("held behind the receipt");
    failAcceptance = true;
    const admission = await h.submit("deliver");
    if (admission.kind !== "accepted") throw new Error(admission.message);
    const settled = await admission.turn.completed;
    expect(settled.outcome).toMatchObject({
      kind: "settlement_failed",
      code: "delivery_receipt",
    });
    expect((await h.operation(ready.id))?.phase).toBe("delivering");
    const dispatches = h.state.dispatches.length;
    // The host is held: no ordinary admission, no queue drain, no resend.
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    await h.nudge();
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect((await h.readRow()).pendingQueue).toMatchObject([
      { status: "pending" },
    ]);

    failAcceptance = false;
    await h.fixture.manager.ensureConversationLifecycle(h.fixture.binding);
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: settled.attemptId },
    });
    expect(acceptanceWrites).toBeGreaterThanOrEqual(2);
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
    // Only the queue's ordinary turn follows; the delivery was sent once.
    await vi.waitFor(() =>
      expect(h.state.dispatches).toEqual([
        ...h.state.dispatches.slice(0, dispatches),
        "held behind the receipt",
      ]),
    );
    expect(h.state.dispatches).toHaveLength(dispatches + 1);
  });
});

describe("uncertain input and recovery", () => {
  it("returns the seed to ready and settles the attempted runtime when the prompt definitely never reached the provider", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const queued = await h.enqueue("queued for the failed send");
    // The adapter attests non-delivery; the retry policy replaces the runtime
    // and tries once more, which fails the same way.
    h.state.sendTurnError = makeUndeliveredPromptFailure();
    const created = h.state.created.length;
    await h.nudge();
    await vi.waitFor(async () =>
      expect(await h.operation(ready.id)).toMatchObject({
        phase: "ready",
        failure: { code: "delivery_not_sent" },
        acceptance: null,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.state.created
          .slice(created)
          .every((r) => r.close.mock.calls.length > 0),
      ).toBe(true),
    );
    // The queued row follows the existing retry semantics: held for review,
    // neither discarded nor automatically repeated.
    const row = await h.readRow();
    expect(row.pendingQueue).toMatchObject([
      { id: queued.id, status: "uncertain" },
    ]);
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "ready",
    });
    expect((await h.readRow()).backendRef).toBeNull();
    // Reviewing and retrying the row delivers the still-ready seed once.
    const dispatches = h.state.dispatches.length;
    await h.fixture.queue.resolveDelivery({
      ...h.fixture.identity,
      id: queued.id,
      action: "retry",
    });
    await h.nudge();
    await vi.waitFor(async () =>
      expect((await h.operation(ready.id))?.phase).toBe("applied"),
    );
    expect(h.state.dispatches).toHaveLength(dispatches + 1);
  });

  it("holds an unknown send for reconciliation: uncertain queue, no admission, no automatic replay", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const queued = await h.enqueue("queued for the unknown send");
    h.state.sendTurnError = new Error("socket hang up");
    await h.nudge();
    await vi.waitFor(async () =>
      expect(await h.operation(ready.id)).toMatchObject({
        phase: "needs_reconciliation",
        lastStablePhase: "delivering",
        failure: { code: "delivery_unresolved" },
        delivery: { queuedMessageId: queued.id },
      }),
    );
    const dispatches = h.state.dispatches.length;
    expect((await h.readRow()).pendingQueue).toMatchObject([
      { id: queued.id, status: "uncertain" },
    ]);
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    await h.nudge();
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect(
      await h.fixture.manager.reconcileConversationCheckpoint({
        address: h.fixture.binding.address,
        operationId: ready.id,
      }),
    ).toMatchObject({
      kind: "blocked",
      refusal: { code: "queue_review_required" },
    });
    expect(h.state.dispatches).toHaveLength(dispatches);
  });

  it("repairs a queued receipt from the durable checkpoint acceptance after a crash, without replaying the input", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const queued = await h.enqueue("queued and accepted");
    await h.nudge();
    await vi.waitFor(async () =>
      expect((await h.operation(ready.id))?.phase).toBe("applied"),
    );
    const dispatches = h.state.dispatches.length;
    const operation = await h.operation(ready.id);
    expect(operation?.delivery?.queuedMessageId).toBe(queued.id);
    // The live path delivered the row after the acceptance landed. A crash
    // between those two receipts leaves the row claimed under the same
    // queued attempt; restart recovery then holds it uncertain, which is the
    // state this restores before the host wakes.
    await h.fixture.persistence.store.mutateConversation(
      h.fixture.identity.projectPath,
      h.fixture.identity.sessionName,
      h.fixture.identity.conversationId,
      "test.reopen_delivery",
      (conversation) => {
        conversation.pendingQueue = [
          {
            ...queued,
            status: "uncertain",
            deliveryAttemptId: operation?.delivery?.queuedAttemptId ?? null,
            deliveryStartedAt: queued.enqueuedAt,
            attemptCount: 1,
            error: "Delivery was interrupted",
          },
        ];
      },
    );
    h.fixture.restart();
    await h.nudge();
    // Confirmed from the acceptance, never re-sent.
    expect((await h.readRow()).pendingQueue).toEqual([]);
    expect(h.fixture.repairedUserEntries).toEqual([
      { conversationId: h.fixture.identity.conversationId, id: queued.id },
    ]);
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect(await h.submit("ordinary after repair")).toMatchObject({
      kind: "accepted",
    });
  });

  it("leaves a queued row in review when its attempt or fingerprint disagrees with the checkpoint receipt", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const queued = await h.enqueue("queued and accepted");
    await h.nudge();
    await vi.waitFor(async () =>
      expect((await h.operation(ready.id))?.phase).toBe("applied"),
    );
    const operation = await h.operation(ready.id);
    const dispatches = h.state.dispatches.length;
    await h.fixture.persistence.store.mutateConversation(
      h.fixture.identity.projectPath,
      h.fixture.identity.sessionName,
      h.fixture.identity.conversationId,
      "test.reopen_delivery",
      (conversation) => {
        conversation.pendingQueue = [
          {
            ...queued,
            // Another attempt's claim of the same row.
            status: "uncertain",
            deliveryAttemptId: "a-later-attempt",
            deliveryStartedAt: queued.enqueuedAt,
            attemptCount: 2,
            error: "Delivery was interrupted",
          },
          {
            ...queued,
            id: "edited",
            content: [{ type: "text", text: "queued and edited" }],
            status: "uncertain",
            deliveryAttemptId: operation?.delivery?.queuedAttemptId ?? null,
            deliveryStartedAt: queued.enqueuedAt,
            attemptCount: 1,
            error: "Delivery was interrupted",
          },
        ];
      },
    );
    h.fixture.restart();
    await h.nudge();
    expect((await h.readRow()).pendingQueue.map((r) => r.status)).toEqual([
      "uncertain",
      "uncertain",
    ]);
    expect(h.fixture.repairedUserEntries).toEqual([]);
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect(await h.submit("blocked by review")).toMatchObject({
      kind: "refused",
      code: "queue_review_required",
    });
  });

  it("gates a lost applied continuation for recovery, keeps the acceptance evidence, and recovers from the history recorded since", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const applied = await h.runOrdinaryTurn("after the checkpoint");
    const acceptedRef = h.latestRuntime().ref;
    // History recorded after the checkpoint, which a recovery must include.
    h.fixture.transcripts.get("/lifecycle-fixture/transcripts/c.jsonl")!.push(
      {
        seq: 4,
        entryId: "entry-4",
        role: "user",
        timestamp: "2026-01-02T00:00:00Z",
        content: [{ type: "text", text: "after the checkpoint" }],
      },
      {
        seq: 5,
        entryId: "entry-5",
        role: "assistant",
        timestamp: "2026-01-02T00:00:01Z",
        content: [
          {
            type: "text",
            text: "post-checkpoint fact: rotate the deploy key on Friday",
          },
        ],
      },
    );
    // The provider declares the accepted continuation unusable.
    h.state.nextTurnResult = {
      backendRef: null,
      continuationDisposition: "clear",
    };
    await h.runOrdinaryTurn("the turn that loses the session");

    expect(await h.operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "applied",
      failure: { code: "continuation_lost" },
      acceptance: { attemptId: applied.attemptId },
      protectedReferences: { acceptedBackendRef: acceptedRef.ref },
    });
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "needs_reconciliation",
    });
    const dispatches = h.state.dispatches.length;
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    await h.enqueue("queued under the recovery gate");
    await h.nudge();
    expect(h.state.dispatches).toHaveLength(dispatches);
    const check = await h.check();
    expect(check.refusals).toContainEqual(
      expect.objectContaining({
        code: "recovery_required",
        operationId: ready.id,
      }),
    );
    expect(await h.start()).toMatchObject({
      kind: "refused",
      refusal: { code: "recovery_required" },
    });

    // Explicit recovery builds from the complete archive, post-checkpoint
    // turns included, and the queued message then delivers the new seed.
    const laneCalls = h.state.laneCalls.length;
    const recovery = h.admittedOr(await h.start(undefined, ready.id));
    const recovered = await recovery.completion;
    expect(recovered).toMatchObject({
      phase: "ready",
      recoversOperationId: ready.id,
    });
    expect(
      h.state.laneCalls
        .slice(laneCalls)
        .some((call) =>
          call.prompt.includes("rotate the deploy key on Friday"),
        ),
    ).toBe(true);
    expect((await h.operation(ready.id))?.acceptance?.attemptId).toBe(
      applied.attemptId,
    );
    await vi.waitFor(async () =>
      expect((await h.operation(recovered.id))?.phase).toBe("applied"),
    );
    const fresh = h.latestRuntime();
    expect(fresh.input.persistedRef).toBeNull();
    expect(fresh.ref).not.toEqual(acceptedRef);
    expect(h.state.dispatches).toHaveLength(dispatches + 1);
  });

  it("detects a continuation lost by an external turn at the next admission, without an extra turn", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    await h.runOrdinaryTurn("after the checkpoint");
    expect((await h.operation(ready.id))?.phase).toBe("applied");
    // A provider-initiated turn ends by clearing the continuation.
    h.state.externalEvents!({ type: "external_turn_started" });
    h.state.externalEvents!({
      type: "external_turn_completed",
      result: {
        backendRef: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "clear",
      },
    });
    await vi.waitFor(async () =>
      expect((await h.readRow()).backendRef).toBeNull(),
    );
    const dispatches = h.state.dispatches.length;
    const admission = await h.submit("after the loss");
    expect(admission).toMatchObject({ kind: "refused", code: "busy" });
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      failure: { code: "continuation_lost" },
    });
    expect(h.state.dispatches).toHaveLength(dispatches);
  });
});

describe("acceptance releases the dependent acknowledgements", () => {
  it("binds the fingerprint of the exact dispatched input separately from the submitted input's", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const payload = await payloadOf(h, ready.id);
    await h.runOrdinaryTurn("after the checkpoint");
    const delivery = (await h.operation(ready.id))?.delivery;
    expect(delivery).toMatchObject({
      inputFingerprint: fingerprintAssembledInput({
        promptText: `${payload.seedText}\n\nafter the checkpoint`,
        images: [],
      }),
      submittedInputFingerprint: fingerprintSubmittedInput({
        promptText: "after the checkpoint",
        images: [],
      }),
    });
    expect(delivery?.inputFingerprint).not.toBe(
      delivery?.submittedInputFingerprint,
    );
  });

  it("archives an accepted queued input at once but leaves its row for review when no reference ever arrives", async () => {
    const userEntries: { id?: string }[] = [];
    harness = await createCheckpointHarness({
      actorDeps: {
        appendTranscriptEntryOnce: vi.fn(async (_id, entry) => {
          if (entry.role === "user") userEntries.push(entry);
        }),
      },
    });
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const queued = await h.enqueue("accepted without a reference");
    h.state.emitTurnEvents = async (turn) => {
      await turn.onEvent({ type: "input_accepted" });
    };
    await h.nudge();
    await vi.waitFor(async () =>
      expect(await h.operation(ready.id)).toMatchObject({
        phase: "needs_reconciliation",
        failure: { code: "acceptance_without_reference" },
        delivery: { queuedMessageId: queued.id },
        acceptance: null,
      }),
    );
    // The archive holds the accepted input once, in event order; the queue
    // still owns the row, because nothing durable says the seed was applied.
    expect(userEntries.filter((entry) => entry.id === queued.id)).toHaveLength(
      1,
    );
    expect((await h.readRow()).pendingQueue).toMatchObject([
      { id: queued.id, status: "uncertain" },
    ]);
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
  });

  it("completes the queue release and the context receipts from the retained checkpoint receipt, without resending", async () => {
    let failAcceptance = false;
    const memoryDeliveries: string[] = [];
    const userEntries: { id?: string }[] = [];
    harness = await createCheckpointHarness({
      repo: (real) => ({
        ...real,
        recordAcceptance: async (input) => {
          if (failAcceptance) throw new Error("disk full");
          return real.recordAcceptance(input);
        },
      }),
      actorDeps: {
        getMemoryIndexBlock: vi.fn(async () => ({
          mode: "full" as const,
          composedAt: "2026-09-08T00:00:00.000Z",
          entries: [],
          block: "<memory-index/>",
          rendered: null,
        })),
        recordMemoryIndexDeliveries: vi.fn(async (input) => {
          memoryDeliveries.push(input.kind);
        }),
        appendTranscriptEntryOnce: vi.fn(async (_id, entry) => {
          if (entry.role === "user") userEntries.push(entry);
        }),
      },
    });
    const h = harness;
    await h.runOrdinaryTurn();
    expect(memoryDeliveries).toHaveLength(1);
    const ready = await h.checkpointToReady();
    const queued = await h.enqueue("queued behind the receipt");
    failAcceptance = true;
    await h.nudge();
    await vi.waitFor(async () =>
      expect((await h.readRow()).pendingQueue).toMatchObject([
        { id: queued.id, status: "uncertain" },
      ]),
    );
    expect((await h.operation(ready.id))?.phase).toBe("delivering");
    // Archived in event order; nothing else was released while the
    // acceptance is not durable.
    expect(userEntries.filter((entry) => entry.id === queued.id)).toHaveLength(
      1,
    );
    expect(memoryDeliveries).toHaveLength(1);
    const dispatches = h.state.dispatches.length;
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });

    failAcceptance = false;
    await h.fixture.manager.ensureConversationLifecycle(h.fixture.binding);
    expect((await h.operation(ready.id))?.phase).toBe("applied");
    // The repaired receipt released the row and recorded the memory delivery
    // itself: no second provider call, no second archive entry.
    expect((await h.readRow()).pendingQueue).toEqual([]);
    expect(memoryDeliveries).toEqual(["full", "full"]);
    expect(userEntries.filter((entry) => entry.id === queued.id)).toHaveLength(
      1,
    );
    expect(h.state.dispatches).toHaveLength(dispatches);
    // The next turn resumes the accepted continuation without the seed; the
    // memory block this fixture composes every turn is all that precedes it.
    await h.runOrdinaryTurn("second");
    expect(h.state.dispatches.at(-1)).toBe("<memory-index/>\n\nsecond");
    expect(memoryDeliveries).toHaveLength(3);
  });

  it("keeps an observed acceptance when archiving the accepted queued input fails, and repairs the archive from the receipt without resending", async () => {
    let failAppend = true;
    let appends = 0;
    const userEntries: { id?: string }[] = [];
    harness = await createCheckpointHarness({
      actorDeps: {
        appendTranscriptEntryOnce: vi.fn(async (_id, entry) => {
          if (entry.role !== "user") return;
          appends += 1;
          if (failAppend) throw new Error("transcript unwritable");
          userEntries.push(entry);
        }),
      },
    });
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    const payload = await payloadOf(h, ready.id);
    const queued = await h.enqueue("accepted before its archive");
    // Both facts are observed before the archive of the accepted input is
    // even attempted; that archive then fails.
    h.state.emitTurnEvents = async (turn, ref) => {
      await turn.onEvent({ type: "backend_init", backendRef: ref });
      await turn.onEvent({ type: "input_accepted" });
    };
    await h.nudge();
    await vi.waitFor(async () =>
      expect(await h.operation(ready.id)).toMatchObject({
        phase: "applied",
        acceptance: { seedHash: payload.seedSha256 },
        delivery: { queuedMessageId: queued.id },
        protectedReferences: { acceptedBackendRef: h.latestRuntime().ref.ref },
      }),
    );
    // The archive is owed, so nothing is released: the row stays for review,
    // the host is held, and the seed is not sent again.
    await vi.waitFor(async () =>
      expect((await h.readRow()).pendingQueue).toMatchObject([
        { id: queued.id, status: "uncertain" },
      ]),
    );
    expect(userEntries).toEqual([]);
    expect(appends).toBeGreaterThanOrEqual(1);
    const dispatches = h.state.dispatches.length;
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });

    failAppend = false;
    await h.fixture.manager.ensureConversationLifecycle(h.fixture.binding);
    // The repaired receipt archived the accepted input once and only then
    // released the row; the provider was never asked again.
    expect(userEntries.filter((entry) => entry.id === queued.id)).toHaveLength(
      1,
    );
    expect((await h.readRow()).pendingQueue).toEqual([]);
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
    expect(await h.submit("after the repaired archive")).toMatchObject({
      kind: "accepted",
    });
  });

  it("applies the seed with the replacement runtime's own reference, never the one an earlier runtime reported before attesting non-delivery", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    // Runtime A reports its session, then attests the prompt never reached
    // it and dies; the retry policy replaces it with runtime B, which
    // accepts the input before reporting its own session.
    let sends = 0;
    h.state.deadAfterSendFailure = true;
    h.state.emitTurnEvents = async (turn, ref) => {
      sends += 1;
      if (sends === 1) {
        await turn.onEvent({ type: "backend_init", backendRef: ref });
        throw makeUndeliveredPromptFailure();
      }
      await turn.onEvent({ type: "input_accepted" });
      await turn.onEvent({ type: "backend_init", backendRef: ref });
    };
    const created = h.state.created.length;
    const settled = await h.runOrdinaryTurn("accepted by the replacement");
    expect(h.state.created).toHaveLength(created + 2);
    const [first, replacement] = h.state.created.slice(created);
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: settled.attemptId },
      protectedReferences: { acceptedBackendRef: replacement?.ref.ref },
    });
    expect(first?.ref.ref).not.toBe(replacement?.ref.ref);
    expect((await h.readRow()).backendRef).toEqual(replacement?.ref);
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
  });
});

describe("pre-send failures and settlement", () => {
  it("holds a replacement send that ended without acceptance for reconciliation, whatever the first send attested", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    // The first send attests non-delivery on a runtime that then reports
    // itself dead, so the retry policy replaces it and sends once more; that
    // send ends with no event at all.
    h.state.deadAfterSendFailure = true;
    h.state.sendTurnError = makeUndeliveredPromptFailure();
    h.state.emitTurnEvents = async () => {};
    const created = h.state.created.length;
    await h.runOrdinaryTurn("sent twice, accepted never");
    expect(h.state.created).toHaveLength(created + 2);
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
      acceptance: null,
    });
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
  });

  it("closes the runtime an attempt installed when the turn fails before its binding, and keeps the seed ready for the next turn", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    // The readiness check refuses twice: the fresh runtime and its
    // replacement are both unusable, and the prompt is never dispatched.
    h.state.prepareForTurnStart = async () => ({
      status: "recreate-runtime",
      reason: "session tools unavailable",
    });
    const created = h.state.created.length;
    const dispatches = h.state.dispatches.length;
    const admission = await h.submit("never dispatched");
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await admission.turn.completed;
    expect(h.state.dispatches).toHaveLength(dispatches);
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "ready",
      delivery: null,
      acceptance: null,
    });
    const attempted = h.state.created.slice(created);
    expect(attempted).toHaveLength(2);
    expect(attempted.every((r) => r.close.mock.calls.length > 0)).toBe(true);
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "ready",
    });
    expect((await h.readRow()).backendRef).toBeNull();

    h.state.prepareForTurnStart = null;
    await h.runOrdinaryTurn("after the failed attempt");
    expect((await h.operation(ready.id))?.phase).toBe("applied");
    expect(h.state.created).toHaveLength(created + 3);
    expect(h.latestRuntime().input.persistedRef).toBeNull();
    expect(h.state.dispatches).toHaveLength(dispatches + 1);
  });

  it("retries a close that failed inside the unsent settlement through reconciliation, and only then returns the seed to ready", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    const ready = await h.checkpointToReady();
    h.state.sendTurnError = makeUndeliveredPromptFailure();
    h.state.closeRejects = true;
    const admission = await h.submit("never reached the provider");
    if (admission.kind !== "accepted") throw new Error(admission.message);
    const settled = await admission.turn.completed;
    expect(settled.outcome).toMatchObject({
      kind: "settlement_failed",
      code: "runtime_close",
    });
    // Not sent, but not released either: the seed returns to ready only once
    // the attempted runtime is settled.
    expect((await h.operation(ready.id))?.phase).toBe("delivering");
    expect(await h.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    const dispatches = h.state.dispatches.length;

    h.state.closeRejects = false;
    await h.fixture.manager.ensureConversationLifecycle(h.fixture.binding);
    expect(await h.operation(ready.id)).toMatchObject({
      phase: "ready",
      failure: { code: "delivery_not_sent" },
      acceptance: null,
    });
    expect(h.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "ready",
    });
    expect(h.state.dispatches).toHaveLength(dispatches);
    await h.runOrdinaryTurn("after the repaired close");
    expect((await h.operation(ready.id))?.phase).toBe("applied");
    expect(h.state.dispatches).toHaveLength(dispatches + 1);
  });
});
