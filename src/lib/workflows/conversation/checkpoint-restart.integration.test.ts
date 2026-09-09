/**
 * Restart at every durable checkpoint boundary, through the actual provided
 * manager and machine over real SQLite rows. A "restart" here is a crash: the
 * live actors, their runtimes and any unflushed snapshot are discarded and a
 * fresh manager is composed over the same database.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import type { ConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { readAllForStartupFromDb } from "@/lib/state-store/startup-reader";

import { setPersistenceDeps, validateRestoredSnapshot } from "./persistence";
import { toPersistedConversationSnapshot } from "./persisted-snapshot-codec";
import { rehydrateConversationActors } from "./rehydration";
import {
  createCheckpointHarness,
  deferred,
  gatedGenerator,
  seededPrompt,
  type CheckpointHarness,
} from "./testing/checkpoint-harness";

let harness: CheckpointHarness | undefined;
let releaseHeld: (() => void) | undefined;

afterEach(async () => {
  releaseHeld?.();
  releaseHeld = undefined;
  await harness?.close();
  harness = undefined;
});

/**
 * A repository whose readiness commit hangs until released: the crash window
 * after the runtime closed and before the clear-and-commit landed. `release`
 * lets a commit the crashed process was awaiting finish, so a test that
 * failed early can still be cleaned up.
 */
function hangingCommit() {
  const pending: Array<() => void> = [];
  const control = {
    hang: true,
    release() {
      control.hang = false;
      for (const resume of pending.splice(0)) resume();
    },
  };
  const repo = (
    real: ConversationCheckpointsRepo,
  ): ConversationCheckpointsRepo => ({
    ...real,
    commitReady: async (input) => {
      if (control.hang)
        await new Promise<void>((resolve) => pending.push(resolve));
      return real.commitReady(input);
    },
  });
  return { control, repo };
}

/** Startup rehydration over the harness's real store, host and queue. */
async function rehydrate(
  h: CheckpointHarness,
  hydrateCheckpointAuthority = h.fixture.hydrateCheckpointAuthority,
) {
  const { fixture } = h;
  const queue: ConversationQueueDeps = {
    submitTurn: (input) => fixture.manager.submitConversationTurn(input),
    claimNextTurnBatch: fixture.queue.claimNextTurnBatch,
    markPending: fixture.queue.markPending,
    markDelivered: fixture.queue.markDelivered,
    markFailed: fixture.queue.markFailed,
    recoverAbandonedDeliveries: fixture.queue.recoverAbandonedDeliveries,
    async runConversationCommand() {
      throw new Error("No command expected");
    },
  };
  return rehydrateConversationActors({
    host: fixture.host,
    queue,
    mutateConversation: fixture.persistence.store.mutateConversation,
    readAllForStartup: () => readAllForStartupFromDb(fixture.persistence.db),
    listAllProjectConversations:
      fixture.persistence.store.listAllProjectConversations,
    getProjectDisplayName: () => fixture.projectName,
    getConversationMachineSnapshot:
      fixture.persistence.store.getConversationMachineSnapshot,
    validateRestoredSnapshot,
    readConversation: (projectPath, storeSessionName, conversationId) =>
      h.scopeKey.scope === "project"
        ? fixture.persistence.store.getProjectConversation(
            projectPath,
            conversationId,
          )
        : fixture.persistence.store.getConversation(
            projectPath,
            storeSessionName,
            conversationId,
          ),
    hydrateCheckpointAuthority,
  });
}

/**
 * The crash lands while the retired runtime's close is in flight: the payload
 * is frozen, the durable operation says retiring, and the row still names the
 * runtime being retired, because the actor projects `ready` — and clears its
 * reference — only after the close.
 */
async function crashDuringClose(scope: "session" | "project" = "session") {
  const closing = deferred();
  releaseHeld = closing.resolve;
  const h = await createCheckpointHarness({ scope });
  harness = h;
  h.state.holdClose = closing.promise;
  await h.runOrdinaryTurn();
  const retiredRef = h.latestRuntime().ref;
  const started = h.admittedOr(await h.start());
  await vi.waitFor(() =>
    expect(h.hosted().runtime?.maintenance?.phase).toBe("retiring"),
  );
  expect((await h.operation(started.operation.id))?.phase).toBe("retiring");
  expect((await h.readRow()).backendRef).toEqual(retiredRef);
  return { h, retiredRef, operationId: started.operation.id };
}

/**
 * A resumable resume token that still names `ref`: what a debounced snapshot
 * written before a readiness commit looks like on disk after the crash.
 */
function staleResumableSnapshot(
  h: CheckpointHarness,
  ref: AgentSessionRef,
  schemaVersion = 1,
) {
  const actor = h.hosted().actor;
  if (!actor) throw new Error("no actor to snapshot");
  const persisted = JSON.parse(
    JSON.stringify(
      toPersistedConversationSnapshot(actor.getPersistedSnapshot()),
    ),
  ) as {
    value: unknown;
    context: Record<string, unknown>;
  };
  persisted.value = "waitingForInput";
  persisted.context._schemaVersion = schemaVersion;
  persisted.context.backendRef = ref;
  persisted.context.pendingQuestion = { questionId: "q-stale", questions: [] };
  persisted.context.status = "waiting_for_input";
  return persisted;
}

describe("restart during building", () => {
  it("fails the interrupted build before any drain, keeps the prior reference, and delivers the held queue in order on the resumed continuation", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    await harness.runOrdinaryTurn();
    const liveRef = harness.latestRuntime().ref;
    const before = await harness.enqueue("queued before checkpoint");
    const started = harness.admittedOr(await harness.start());
    await gate.started.promise;
    const during = await harness.enqueue("queued during build");
    expect((await harness.readRow()).backendRef).toEqual(liveRef);

    harness.fixture.restart();
    // Nothing is running, and the durable operation still says building.
    expect(harness.hosted().actor).toBeUndefined();
    expect((await harness.operation(started.operation.id))?.phase).toBe(
      "building",
    );

    await harness.nudge();

    const operation = await harness.operation(started.operation.id);
    expect(operation).toMatchObject({
      phase: "failed",
      failure: { code: "interrupted" },
      payloadId: null,
    });
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toBeNull();
    // Both rows drained as one batch, in enqueue order, with their identities
    // intact, on the continuation the build never retired.
    await vi.waitFor(() =>
      expect(harness!.state.dispatches).toEqual([
        "first",
        "queued before checkpoint\nqueued during build",
      ]),
    );
    expect(harness.latestRuntime().input.persistedRef).toEqual(liveRef);
    const row = await harness.readRow();
    expect(row.pendingQueue.map((entry) => entry.id)).not.toContain(before.id);
    expect(row.pendingQueue.map((entry) => entry.id)).not.toContain(during.id);
    expect(row.backendRef).toEqual(harness.latestRuntime().ref);
    // The crashed process's runtime was never closed by anyone here.
    expect(harness.state.created[0]?.close).not.toHaveBeenCalled();
  });

  it("answers a cancel after the restart from the durable outcome, without a host", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    await harness.runOrdinaryTurn();
    const started = harness.admittedOr(await harness.start());
    await gate.started.promise;
    harness.fixture.restart();

    const cancelled =
      await harness.fixture.manager.cancelConversationCheckpoint({
        address: harness.fixture.binding.address,
        operationId: started.operation.id,
      });
    expect(cancelled).toMatchObject({
      kind: "refused",
      refusal: {
        code: "not_cancellable",
        operationId: started.operation.id,
        phase: "failed",
      },
    });
    expect(harness.hosted().actor).toBeUndefined();
    const check = await harness.check();
    expect(check.eligible).toBe(true);
  });
});

describe("restart during retiring", () => {
  it.each(["session", "project"] as const)(
    "finishes a %s retirement from the saved payload, clears the row, and never resumes the retired reference",
    async (scope) => {
      const commit = hangingCommit();
      releaseHeld = commit.control.release;
      harness = await createCheckpointHarness({ scope, repo: commit.repo });
      await harness.runOrdinaryTurn();
      const retiredRef = harness.latestRuntime().ref;
      const started = harness.admittedOr(await harness.start());
      // The runtime closed, the payload is frozen, and the maintenance is
      // awaiting the clear-and-commit that never lands.
      await vi.waitFor(() =>
        expect(harness!.hosted().runtime?.maintenance?.phase).toBe(
          "publishing",
        ),
      );
      expect(harness.latestRuntime().close).toHaveBeenCalledTimes(1);
      // The actor's ready projection already cleared the row through its
      // derived write; the durable operation still says retiring and records
      // the reference it retires.
      expect(await harness.operation(started.operation.id)).toMatchObject({
        phase: "retiring",
        protectedReferences: { priorBackendRef: retiredRef.ref },
      });

      harness.fixture.restart();
      commit.control.hang = false;
      await harness.enqueue("after the restart");
      await harness.nudge();

      const operation = await harness.operation(started.operation.id);
      expect(operation).toMatchObject({
        phase: "ready",
        payloadId: started.operation.id,
        protectedReferences: {
          priorBackendRef: retiredRef.ref,
          acceptedBackendRef: null,
        },
      });
      expect(
        await harness.fixture.checkpoints.getPayload(
          harness.scopeKey,
          operation!.id,
        ),
      ).not.toBeNull();
      expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
        operationId: started.operation.id,
        phase: "ready",
      });
      // The queued message became the next ordinary turn on a FRESH runtime:
      // no resume of the retired reference, and the row never names it again.
      await vi.waitFor(() =>
        expect(harness!.state.dispatches).toEqual([
          "first",
          seededPrompt("after the restart"),
        ]),
      );
      const fresh = harness.latestRuntime();
      expect(fresh.input.persistedRef).toBeNull();
      expect(fresh.ref).not.toEqual(retiredRef);
      expect((await harness.readRow()).backendRef).toEqual(fresh.ref);
    },
  );

  it("completes the retirement for an unhosted conversation when a cancel arrives after the restart", async () => {
    const commit = hangingCommit();
    releaseHeld = commit.control.release;
    harness = await createCheckpointHarness({ repo: commit.repo });
    await harness.runOrdinaryTurn();
    const started = harness.admittedOr(await harness.start());
    await vi.waitFor(() =>
      expect(harness!.hosted().runtime?.maintenance?.phase).toBe("publishing"),
    );
    harness.fixture.restart();
    commit.control.hang = false;

    const cancelled =
      await harness.fixture.manager.cancelConversationCheckpoint({
        address: harness.fixture.binding.address,
        operationId: started.operation.id,
      });
    expect(cancelled).toMatchObject({
      kind: "completed",
      operation: { phase: "ready" },
    });
    expect((await harness.readRow()).backendRef).toBeNull();
    expect(harness.hosted().actor).toBeUndefined();
  });
});

describe("restart with a ready checkpoint", () => {
  it("stays ready; the next queued message is the next ordinary turn on a fresh runtime", async () => {
    harness = await createCheckpointHarness();
    await harness.runOrdinaryTurn();
    const retiredRef = harness.latestRuntime().ref;
    const ready = await harness.checkpointToReady();
    const updatedAt = ready.updatedAt;

    harness.fixture.restart();
    await harness.enqueue("first message after readiness");
    await harness.nudge();

    expect(await harness.operation(ready.id)).toMatchObject({
      phase: "ready",
      updatedAt,
    });
    await vi.waitFor(() =>
      expect(harness!.state.dispatches).toEqual([
        "first",
        seededPrompt("first message after readiness"),
      ]),
    );
    expect(harness.latestRuntime().input.persistedRef).toBeNull();
    expect(harness.latestRuntime().ref).not.toEqual(retiredRef);
  });
});

describe("restart during delivering", () => {
  it("holds the attempted delivery for reconciliation: queued delivery uncertain, no admission, no inferred acceptance, no send", async () => {
    harness = await createCheckpointHarness();
    await harness.runOrdinaryTurn();
    const ready = await harness.checkpointToReady();
    const queued = await harness.enqueue("queued for the delivering turn");
    // The delivery owner claims the queue row and binds the attempt before the
    // provider call; the crash lands after that, before any acceptance.
    const claimed = await harness.fixture.queue.claimNextTurnBatch(
      harness.fixture.identity,
    );
    if (!claimed) throw new Error("nothing claimed");
    const bound = await harness.fixture.checkpoints.beginDelivery({
      key: harness.scopeKey,
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
    const dispatchesBefore = [...harness.state.dispatches];

    harness.fixture.restart();
    await harness.nudge();

    expect(await harness.operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
      acceptance: null,
      delivery: { attemptId: "attempt-crashed", queuedMessageId: queued.id },
    });
    expect(harness.hosted().actor?.getSnapshot().context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "needs_reconciliation",
    });
    const row = await harness.readRow();
    expect(row.pendingQueue).toMatchObject([
      { id: queued.id, status: "uncertain" },
    ]);
    expect(row.backendRef).toBeNull();
    expect(await harness.submit("blocked")).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    expect(harness.state.dispatches).toEqual(dispatchesBefore);
    const check = await harness.check();
    expect(check.eligible).toBe(false);
    expect(check.refusals).toContainEqual(
      expect.objectContaining({
        code: "recovery_required",
        operationId: ready.id,
        phase: "needs_reconciliation",
      }),
    );

    // A second restart changes nothing: the hold is durable, not in-process.
    harness.fixture.restart();
    await harness.nudge();
    expect((await harness.operation(ready.id))?.phase).toBe(
      "needs_reconciliation",
    );
    expect(harness.state.dispatches).toEqual(dispatchesBefore);
  });
});

describe("snapshot authority on restart", () => {
  it("overrides a stale resumable snapshot that still names the retired reference", async () => {
    harness = await createCheckpointHarness();
    await harness.runOrdinaryTurn();
    const retiredRef = harness.latestRuntime().ref;
    const ready = await harness.checkpointToReady();
    const stale = staleResumableSnapshot(harness, retiredRef);
    await harness.fixture.persistence.store.upsertConversationMachineSnapshot(
      "session",
      harness.fixture.identity.conversationId,
      stale,
    );

    harness.fixture.restart();
    expect(await rehydrate(harness)).toBe(1);

    const actor = harness.hosted().actor;
    const context = actor!.getSnapshot().context;
    expect(actor!.getSnapshot().value).toBe("waitingForInput");
    expect(context.pendingQuestion).toMatchObject({ questionId: "q-stale" });
    expect(context.backendRef).toBeNull();
    expect(context.checkpoint).toEqual({
      operationId: ready.id,
      phase: "ready",
    });

    // A derived write from the restored actor keeps the row cleared.
    await harness.fixture.manager.clearConversationQuestion(
      harness.fixture.identity.projectPath,
      harness.fixture.identity.sessionName,
      harness.fixture.identity.conversationId,
      { questionId: "q-stale" },
    );
    expect((await harness.readRow()).backendRef).toBeNull();
  });

  it.each([
    ["absent", null],
    ["rejected", 99],
  ] as const)(
    "reads the authority with a(n) %s snapshot: an interrupted retirement finishes and the reference is gone before any actor exists",
    async (_label, schemaVersion) => {
      const commit = hangingCommit();
      releaseHeld = commit.control.release;
      harness = await createCheckpointHarness({ repo: commit.repo });
      await harness.runOrdinaryTurn();
      const retiredRef = harness.latestRuntime().ref;
      const started = harness.admittedOr(await harness.start());
      await vi.waitFor(() =>
        expect(harness!.hosted().runtime?.maintenance?.phase).toBe(
          "publishing",
        ),
      );
      if (schemaVersion !== null) {
        await harness.fixture.persistence.store.upsertConversationMachineSnapshot(
          "session",
          harness.fixture.identity.conversationId,
          staleResumableSnapshot(harness, retiredRef, schemaVersion),
        );
      } else {
        await harness.fixture.persistence.store.deleteConversationMachineSnapshot(
          "session",
          harness.fixture.identity.conversationId,
        );
      }

      harness.fixture.restart();
      commit.control.hang = false;
      // No queue and no resumable snapshot: no actor starts, yet the
      // authority was hydrated for the candidate.
      expect(await rehydrate(harness)).toBe(0);
      expect(harness.hosted().actor).toBeUndefined();
      expect((await harness.operation(started.operation.id))?.phase).toBe(
        "ready",
      );
      expect((await harness.readRow()).backendRef).toBeNull();

      // And the first host to wake takes the projection, not the reference.
      await harness.nudge();
      const context = harness.hosted().actor!.getSnapshot().context;
      expect(context.backendRef).toBeNull();
      expect(context.checkpoint).toEqual({
        operationId: started.operation.id,
        phase: "ready",
      });
    },
  );
});

describe("restart after the freeze, before the actor cleared its reference", () => {
  it.each(["session", "project"] as const)(
    "%s: a woken host seeds itself from the row after readiness clears it, so the retired reference never reaches the new actor",
    async (scope) => {
      const { h, retiredRef, operationId } = await crashDuringClose(scope);

      h.fixture.restart();
      h.state.holdClose = null;
      await h.enqueue("after the restart");
      await h.nudge();

      expect((await h.operation(operationId))?.phase).toBe("ready");
      const context = h.hosted().actor?.getSnapshot().context;
      expect(context?.backendRef).toBeNull();
      expect(context?.checkpoint).toEqual({ operationId, phase: "ready" });
      // The queued message ran on a FRESH runtime, and the row never named
      // the retired reference again.
      await vi.waitFor(() =>
        expect(h.state.dispatches).toEqual([
          "first",
          seededPrompt("after the restart"),
        ]),
      );
      const fresh = h.latestRuntime();
      expect(fresh.input.persistedRef).toBeNull();
      expect(fresh.ref).not.toEqual(retiredRef);
      expect((await h.readRow()).backendRef).toEqual(fresh.ref);
    },
  );

  it.each([
    ["a queued message and no snapshot", false],
    ["a stale resumable snapshot naming the retired reference", true],
  ] as const)(
    "startup restore with %s seeds the actor from the row readiness cleared",
    async (_label, staleSnapshot) => {
      const { h, retiredRef, operationId } = await crashDuringClose();
      const { store } = h.fixture.persistence;
      const { conversationId } = h.fixture.identity;
      if (staleSnapshot) {
        await store.upsertConversationMachineSnapshot(
          "session",
          conversationId,
          staleResumableSnapshot(h, retiredRef),
        );
      } else {
        await h.enqueue("queued before the crash");
        await store.deleteConversationMachineSnapshot(
          "session",
          conversationId,
        );
      }

      h.fixture.restart();
      h.state.holdClose = null;
      expect(await rehydrate(h)).toBe(1);

      expect((await h.operation(operationId))?.phase).toBe("ready");
      expect((await h.readRow()).backendRef).toBeNull();
      const context = h.hosted().actor?.getSnapshot().context;
      expect(context?.backendRef).toBeNull();
      expect(context?.checkpoint).toEqual({ operationId, phase: "ready" });
      if (staleSnapshot) {
        expect(context?.pendingQuestion).toMatchObject({
          questionId: "q-stale",
        });
        // A derived write from the restored actor keeps the row cleared.
        await h.fixture.manager.clearConversationQuestion(
          h.fixture.identity.projectPath,
          h.fixture.identity.sessionName,
          conversationId,
          { questionId: "q-stale" },
        );
        expect((await h.readRow()).backendRef).toBeNull();
      } else {
        await vi.waitFor(() =>
          expect(h.state.dispatches).toEqual([
            "first",
            seededPrompt("queued before the crash"),
          ]),
        );
        const fresh = h.latestRuntime();
        expect(fresh.input.persistedRef).toBeNull();
        expect(fresh.ref).not.toEqual(retiredRef);
        expect((await h.readRow()).backendRef).toEqual(fresh.ref);
      }
    },
  );
});

describe("startup restore over live ownership", () => {
  it("leaves a hosted conversation's running build alone", async () => {
    const gate = gatedGenerator();
    releaseHeld = gate.release;
    harness = await createCheckpointHarness({ generate: gate.generate });
    await harness.runOrdinaryTurn();
    const started = harness.admittedOr(await harness.start());
    await gate.started.promise;

    expect(await rehydrate(harness)).toBe(0);

    expect((await harness.operation(started.operation.id))?.phase).toBe(
      "building",
    );
    gate.release();
    expect(await started.completion).toMatchObject({ phase: "ready" });
  });

  it("waits for the host's per-conversation section before applying any restart rule", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    await h.enqueue("queued before the crash");
    h.fixture.restart();
    const section = deferred();
    const holding = h.fixture.host.exclusive(h.key, () => section.promise);
    const hydrate = vi.fn(h.fixture.hydrateCheckpointAuthority);

    const sweep = rehydrate(h, hydrate);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(hydrate).not.toHaveBeenCalled();
    expect(h.hosted().actor).toBeUndefined();

    section.resolve();
    await holding;
    expect(await sweep).toBe(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(h.state.dispatches).toEqual(["first", "queued before the crash"]),
    );
  });

  it("makes an on-demand start wait for the same section", async () => {
    harness = await createCheckpointHarness();
    const h = harness;
    await h.runOrdinaryTurn();
    h.fixture.restart();
    const section = deferred();
    const holding = h.fixture.host.exclusive(h.key, () => section.promise);

    const nudge = h.nudge();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.hosted().actor).toBeUndefined();

    section.resolve();
    await holding;
    await nudge;
    expect(h.hosted().actor).toBeDefined();
  });
});

it.each(["session", "project"] as const)(
  "%s restart preserves the cleared row after a readiness snapshot failure",
  async (scope) => {
    harness = await createCheckpointHarness({ scope });
    await harness.runOrdinaryTurn();
    const stale = staleResumableSnapshot(harness, harness.latestRuntime().ref);
    const store = harness.fixture.persistence.store;
    let failCleared = true;
    setPersistenceDeps({
      getConversationMachineSnapshot: store.getConversationMachineSnapshot,
      deleteConversationMachineSnapshot:
        store.deleteConversationMachineSnapshot,
      async upsertConversationMachineSnapshot(owner, conversationId, snapshot) {
        if (
          failCleared &&
          (snapshot as { context?: { backendRef?: unknown } }).context
            ?.backendRef === null
        ) {
          throw new Error("snapshot unavailable");
        }
        return store.upsertConversationMachineSnapshot(
          owner,
          conversationId,
          snapshot,
        );
      },
    });
    const started = harness.admittedOr(await harness.start());
    const operation = await started.completion;
    failCleared = false;
    expect(operation).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
    });
    expect((await harness.readRow()).backendRef).toBeNull();
    await store.upsertConversationMachineSnapshot(
      scope,
      harness.fixture.identity.conversationId,
      stale,
    );
    harness.fixture.restart();
    expect(await rehydrate(harness)).toBe(1);
    expect(harness.hosted().actor?.getSnapshot().context.backendRef).toBeNull();
    expect((await harness.readRow()).backendRef).toBeNull();
    expect((await harness.operation(operation.id))?.phase).toBe(
      "needs_reconciliation",
    );
  },
);
