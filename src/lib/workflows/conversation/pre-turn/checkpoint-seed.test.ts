/**
 * The checkpoint seed's required receipt against the real repository: the
 * delivering binding lands before any provider event, acceptance needs both
 * the input event and the fresh reference in either order, and every other
 * ending is classified from neutral evidence — never from a timeout, a
 * reference, or an empty in-memory map.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { makeUndeliveredPromptFailure } from "@/lib/agent-backends/testing/undelivered-prompt-fixture";
import type { CheckpointConversationGateway } from "@/lib/conversation-checkpoints/continuation";
import {
  createConversationCheckpointsRepo,
  type ConversationCheckpointsRepo,
} from "@/lib/conversation-checkpoints/repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointOperation,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  classifyCheckpointDelivery,
  prepareCheckpointSeed,
  type CheckpointDeliveryDependencies,
  type PreparedCheckpointSeed,
} from "./checkpoint-seed";

type Db = InstanceType<typeof Database>;

const KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: "/projects/alpha",
  sessionName: "csm-alpha",
  conversationId: "conv-1",
};
const SEED_TEXT = "<cc-checkpoint>\nobjective: ship ✓\n</cc-checkpoint>";
const SEED_SHA = "sha256:seed-a";
const FRESH = { backend: "claude", ref: "sdk-session-fresh" } as const;
const BINDING = {
  attemptId: "attempt-a",
  inputFingerprint: "sha256:assembled-a",
  submittedInputFingerprint: "sha256:input-a",
  queuedAttemptId: "queue-attempt-1",
  queuedMessageId: "m1",
};

function payloadFor(operationId: string): CheckpointPayload {
  return {
    id: operationId,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: { capturedThroughSeq: 3, sourceHash: "sha256:src" },
    artifactProvenance: null,
    versions: {
      generatorVersion: "gen-1",
      builderVersion: "builder-1",
      normalizerVersion: "norm-1",
    },
    modelSelection: { modelId: "claude-opus-5", parameters: {} },
    sections: { workingState: {}, recentDialogue: [], recoveryMap: {} },
    seedText: SEED_TEXT,
    seedSha256: SEED_SHA,
    sectionBytes: {
      total: Buffer.byteLength(SEED_TEXT, "utf8"),
      workingState: 1,
      recentDialogue: 1,
      recoveryFraming: 1,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: "2026-09-08T00:00:00.000Z",
  };
}

const gateway: CheckpointConversationGateway = {
  exists: () => true,
  find: () => makeConversationState({ id: KEY.conversationId }),
  clearBackendRef: () => true,
};

let db: Db;
let repo: ConversationCheckpointsRepo;
let clock = 0;
const now = () => `2026-09-08T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  repo = createConversationCheckpointsRepo(db, createWriteQueue(), gateway);
  clock = 0;
});

afterEach(() => {
  db.close();
});

async function readyOperation(
  operationId = "op-1",
): Promise<CheckpointOperation> {
  const admitted = await repo.admitOperation({
    key: KEY,
    requestId: operationId,
    sourceBasis: { capturedThroughSeq: 3, sourceHash: "sha256:src" },
    priorBackendRef: "sdk-session-retired",
    requestedAt: now(),
  });
  if (!admitted.ok) throw new Error(admitted.refusal.code);
  const frozen = await repo.freezePayload({
    key: KEY,
    operationId,
    payload: payloadFor(operationId),
    at: now(),
  });
  if (!frozen.ok) throw new Error(frozen.refusal.code);
  const ready = await repo.commitReady({ key: KEY, operationId, at: now() });
  if (!ready.ok) throw new Error(ready.refusal.code);
  return ready.value;
}

function prepare(
  operationId: string,
  options: {
    repo?: CheckpointDeliveryDependencies["repo"];
    closeAttemptedRuntime?: () => Promise<void>;
  } = {},
): PreparedCheckpointSeed {
  return prepareCheckpointSeed(
    {
      checkpoint: { repo: options.repo ?? (async () => repo), now },
      log: createCapturingLogger(),
    },
    {
      key: KEY,
      operationId,
      payload: payloadFor(operationId),
      closeAttemptedRuntime: options.closeAttemptedRuntime ?? (async () => {}),
    },
  );
}

async function operation(id: string) {
  const op = await repo.getOperation(KEY, id);
  if (!op) throw new Error("operation missing");
  return op;
}

describe("prepareCheckpointSeed", () => {
  it("carries the exact frozen bytes and binds the admitted attempt before any provider event", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    expect(seed.block).toBe(SEED_TEXT);
    expect(seed.seedSha256).toBe(SEED_SHA);
    await seed.bind(BINDING);
    expect(await operation(ready.id)).toMatchObject({
      phase: "delivering",
      delivery: BINDING,
      acceptance: null,
    });
  });

  it.each([
    ["input then reference", ["input", "init"]],
    ["reference then input", ["init", "input"]],
  ] as const)(
    "applies the seed once both events are known — %s — and repeats idempotently",
    async (_label, order) => {
      const ready = await readyOperation();
      const recordAcceptance = vi.spyOn(repo, "recordAcceptance");
      const seed = prepare(ready.id);
      await seed.bind(BINDING);
      seed.markDispatched();
      for (const event of order) {
        if (event === "input") await seed.onInputAccepted();
        else await seed.onBackendInit(FRESH);
        // Neither event alone applies the seed.
        if (event === order[0])
          expect((await operation(ready.id)).phase).toBe("delivering");
      }
      // Duplicate events and a repeated finish change nothing.
      await seed.onInputAccepted();
      await seed.onBackendInit(FRESH);
      await seed.finish();
      await seed.finish();
      expect(await operation(ready.id)).toMatchObject({
        phase: "applied",
        acceptance: { attemptId: BINDING.attemptId, seedHash: SEED_SHA },
        protectedReferences: { acceptedBackendRef: FRESH.ref },
      });
      expect(recordAcceptance).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves a reference-only delivery unapplied and holds it for reconciliation", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    await seed.onBackendInit(FRESH);
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
      acceptance: null,
      protectedReferences: { acceptedBackendRef: null },
    });
  });

  it("holds an accepted input that never produced a fresh reference", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    await seed.onInputAccepted();
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      failure: { code: "acceptance_without_reference" },
      acceptance: null,
    });
  });

  it("returns the seed to ready and closes the attempted runtime when the input was definitely never sent", async () => {
    const ready = await readyOperation();
    const closeAttemptedRuntime = vi.fn(async () => {});
    const seed = prepare(ready.id, { closeAttemptedRuntime });
    await seed.bind(BINDING);
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "ready",
      failure: { code: "delivery_not_sent" },
      acceptance: null,
    });
    expect(closeAttemptedRuntime).toHaveBeenCalledTimes(1);

    // A later attempt binds the same seed again.
    const next = prepare(ready.id);
    await next.bind({ ...BINDING, attemptId: "attempt-b" });
    expect((await operation(ready.id)).delivery?.attemptId).toBe("attempt-b");
  });

  it("treats an adapter-attested undelivered prompt as definitely not sent", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    seed.markDispatchFailure(makeUndeliveredPromptFailure());
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "ready",
      failure: { code: "delivery_not_sent" },
    });
  });

  it("treats any other dispatch failure as unknown delivery, never as proof of non-delivery", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    seed.markDispatchFailure(new Error("socket hang up"));
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
    });
  });

  it("refuses a second attempt's binding while the first holds the delivery, and its receipt then touches nothing", async () => {
    const ready = await readyOperation();
    const first = prepare(ready.id);
    await first.bind(BINDING);
    const second = prepare(ready.id);
    await expect(
      second.bind({ ...BINDING, attemptId: "attempt-b" }),
    ).rejects.toThrow(/illegal_transition/);
    await second.onInputAccepted();
    await second.onBackendInit(FRESH);
    await second.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "delivering",
      delivery: { attemptId: "attempt-a" },
      acceptance: null,
    });
  });

  it("retains a failed acceptance write for settlement and repairs it with the same evidence, without a second provider call", async () => {
    const ready = await readyOperation();
    let failWrites = true;
    const calls: Parameters<
      ConversationCheckpointsRepo["recordAcceptance"]
    >[0][] = [];
    const flaky: ConversationCheckpointsRepo = {
      ...repo,
      recordAcceptance: async (input) => {
        calls.push(input);
        if (failWrites) throw new Error("disk full");
        return repo.recordAcceptance(input);
      },
    };
    const seed = prepare(ready.id, { repo: async () => flaky });
    await seed.bind(BINDING);
    seed.markDispatched();
    await seed.onBackendInit(FRESH);
    await expect(seed.onInputAccepted()).rejects.toThrow("disk full");
    await expect(seed.finish()).rejects.toThrow("disk full");
    expect((await operation(ready.id)).phase).toBe("delivering");

    failWrites = false;
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: BINDING.attemptId, seedHash: SEED_SHA },
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(calls.map((call) => call.acceptance.acceptedAt)).size).toBe(
      1,
    );
  });

  it("closes the attempted runtime at settlement when the binding never landed, leaving the seed ready", async () => {
    const ready = await readyOperation();
    const closeAttemptedRuntime = vi.fn(async () => {});
    const seed = prepare(ready.id, { closeAttemptedRuntime });
    // A readiness check, a context write or the binding write itself failed
    // after the fresh runtime was installed: nothing was sent, and the
    // runtime must not survive to receive the seed as a reused one.
    await seed.finish();
    expect(closeAttemptedRuntime).toHaveBeenCalledTimes(1);
    expect(await operation(ready.id)).toMatchObject({
      phase: "ready",
      delivery: null,
      acceptance: null,
    });
  });

  it("treats a replacement send after an attested non-delivery as uncertain again", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    seed.markDispatchFailure(makeUndeliveredPromptFailure());
    // The retry policy replaced the runtime and sent once more; that send
    // ended without acceptance and without a failure, so the earlier
    // non-delivery proves nothing about it.
    seed.markDispatched();
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
      failure: { code: "delivery_unresolved" },
    });
  });

  it("releases the dependent acknowledgements only once the acceptance is durable, and a repaired receipt completes them", async () => {
    const ready = await readyOperation();
    let failWrites = true;
    const flaky: ConversationCheckpointsRepo = {
      ...repo,
      recordAcceptance: async (input) => {
        if (failWrites) throw new Error("disk full");
        return repo.recordAcceptance(input);
      },
    };
    const seed = prepare(ready.id, { repo: async () => flaky });
    await seed.bind(BINDING);
    seed.markDispatched();
    const acknowledge = vi.fn(async () => {});
    // Input first: the reference is unknown, so nothing can be released.
    await seed.onInputAccepted({ acknowledge });
    expect(acknowledge).not.toHaveBeenCalled();
    // The reference arrives but the write fails: still nothing is released.
    await expect(seed.onBackendInit(FRESH)).rejects.toThrow("disk full");
    expect(acknowledge).not.toHaveBeenCalled();
    await expect(seed.finish()).rejects.toThrow("disk full");
    expect(acknowledge).not.toHaveBeenCalled();

    failWrites = false;
    await seed.finish();
    expect((await operation(ready.id)).phase).toBe("applied");
    expect(acknowledge).toHaveBeenCalledTimes(1);
    // A repeated settlement acknowledges nothing twice.
    await seed.finish();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("acknowledges at once when the reference preceded the input, and repairs a failed acknowledgement without a second write", async () => {
    const ready = await readyOperation();
    const recordAcceptance = vi.spyOn(repo, "recordAcceptance");
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    await seed.onBackendInit(FRESH);
    let failAcknowledgement = true;
    const acknowledge = vi.fn(async () => {
      if (failAcknowledgement) throw new Error("queue unavailable");
    });
    await expect(seed.onInputAccepted({ acknowledge })).rejects.toThrow(
      "queue unavailable",
    );
    expect((await operation(ready.id)).phase).toBe("applied");
    await expect(seed.finish()).rejects.toThrow("queue unavailable");

    failAcknowledgement = false;
    await seed.finish();
    expect(acknowledge).toHaveBeenCalledTimes(3);
    expect(recordAcceptance).toHaveBeenCalledTimes(1);
  });

  it("keeps an observed acceptance when the archive of the accepted input fails: the write lands, nothing is released, and the repaired receipt archives before releasing", async () => {
    const ready = await readyOperation();
    const recordAcceptance = vi.spyOn(repo, "recordAcceptance");
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    await seed.onBackendInit(FRESH);
    let failArchive = true;
    const archive = vi.fn(async () => {
      if (failArchive) throw new Error("transcript unwritable");
    });
    const acknowledge = vi.fn(async () => {});
    await expect(
      seed.onInputAccepted({ archive, acknowledge }),
    ).rejects.toThrow("transcript unwritable");
    // The fact was recorded before the archive ran: the acceptance is durable
    // although the archive is still owed, and the release waits for it.
    expect(await operation(ready.id)).toMatchObject({
      phase: "applied",
      acceptance: { attemptId: BINDING.attemptId, seedHash: SEED_SHA },
    });
    expect(acknowledge).not.toHaveBeenCalled();
    await expect(seed.finish()).rejects.toThrow("transcript unwritable");
    expect(acknowledge).not.toHaveBeenCalled();

    failArchive = false;
    await seed.finish();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(archive.mock.invocationCallOrder.at(-1)).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0] ?? 0,
    );
    expect(recordAcceptance).toHaveBeenCalledTimes(1);
    // A repeated settlement archives and releases nothing twice.
    const archives = archive.mock.calls.length;
    await seed.finish();
    expect(archive).toHaveBeenCalledTimes(archives);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("archives an accepted input that never produced a reference, repairing a failed archive before holding the operation", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    let failArchive = true;
    const archive = vi.fn(async () => {
      if (failArchive) throw new Error("transcript unwritable");
    });
    await expect(seed.onInputAccepted({ archive })).rejects.toThrow(
      "transcript unwritable",
    );
    await expect(seed.finish()).rejects.toThrow("transcript unwritable");
    expect((await operation(ready.id)).phase).toBe("delivering");

    failArchive = false;
    await seed.finish();
    expect(archive).toHaveBeenCalledTimes(3);
    expect(await operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      failure: { code: "acceptance_without_reference" },
      acceptance: null,
    });
  });

  it("voids an earlier runtime's reference on a replacement send, so the seed applies only with the reference of the runtime that accepted it", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    // Runtime A reported its session, then attested that the prompt never
    // reached it; the retry policy replaced it with runtime B.
    seed.markDispatched();
    await seed.onBackendInit({ backend: "claude", ref: "sdk-session-a" });
    seed.markDispatchFailure(makeUndeliveredPromptFailure());
    seed.markDispatched();
    const acknowledge = vi.fn(async () => {});
    await seed.onInputAccepted({ acknowledge });
    // B's acceptance with A's reference is no acceptance at all.
    expect(await operation(ready.id)).toMatchObject({
      phase: "delivering",
      acceptance: null,
    });
    expect(acknowledge).not.toHaveBeenCalled();
    await seed.onBackendInit({ backend: "claude", ref: "sdk-session-b" });
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "applied",
      protectedReferences: { acceptedBackendRef: "sdk-session-b" },
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("holds a replacement send whose runtime accepted the input but never reported its own reference", async () => {
    const ready = await readyOperation();
    const seed = prepare(ready.id);
    await seed.bind(BINDING);
    seed.markDispatched();
    await seed.onBackendInit({ backend: "claude", ref: "sdk-session-a" });
    seed.markDispatchFailure(makeUndeliveredPromptFailure());
    seed.markDispatched();
    await seed.onInputAccepted();
    await seed.finish();
    expect(await operation(ready.id)).toMatchObject({
      phase: "needs_reconciliation",
      failure: { code: "acceptance_without_reference" },
      acceptance: null,
      protectedReferences: { acceptedBackendRef: null },
    });
  });
});

describe("classifyCheckpointDelivery", () => {
  it.each([
    [
      "applied",
      {
        inputAccepted: true,
        backendRef: "r",
        dispatched: true,
        undeliveredFailure: false,
      },
    ],
    [
      "accepted_without_reference",
      {
        inputAccepted: true,
        backendRef: null,
        dispatched: true,
        undeliveredFailure: false,
      },
    ],
    [
      "not_sent",
      {
        inputAccepted: false,
        backendRef: null,
        dispatched: false,
        undeliveredFailure: false,
      },
    ],
    [
      "not_sent",
      {
        inputAccepted: false,
        backendRef: null,
        dispatched: true,
        undeliveredFailure: true,
      },
    ],
    [
      "unknown",
      {
        inputAccepted: false,
        backendRef: "r",
        dispatched: true,
        undeliveredFailure: false,
      },
    ],
    [
      "unknown",
      {
        inputAccepted: false,
        backendRef: null,
        dispatched: true,
        undeliveredFailure: false,
      },
    ],
  ] as const)("classifies %s", (verdict, evidence) => {
    expect(classifyCheckpointDelivery(evidence)).toBe(verdict);
  });
});
