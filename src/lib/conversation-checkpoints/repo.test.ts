import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

import type { CheckpointConversationGateway } from "./continuation";
import {
  createConversationCheckpointsRepo,
  type CheckpointResult,
  type ConversationCheckpointsRepo,
} from "./repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointOperation,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const SESSION_KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: "/projects/alpha",
  sessionName: "csm-alpha",
  conversationId: "conv-session",
};

const PROJECT_KEY: CheckpointScopeKey = {
  scope: "project",
  projectPath: "/projects/alpha",
  sessionName: null,
  conversationId: "conv-project",
};

const BASIS = { capturedThroughSeq: 120, sourceHash: "sha256:source-a" };
const PRIOR_REF = "prior-provider-session-9d3f";

/**
 * The continuation seam as a recording double. These tests own phase and
 * transition behaviour over the checkpoint tables; the real writer's effect on
 * a conversation row is proved against real rows in `readiness.test.ts`.
 */
function recordingContinuation(): CheckpointConversationGateway & {
  cleared: CheckpointScopeKey[];
  present: boolean;
  targetExists: boolean;
  /** What `find` answers inside a freeze; the fence's durable observation. */
  row: ConversationState | null;
  finds: CheckpointScopeKey[];
} {
  const state = {
    cleared: [] as CheckpointScopeKey[],
    present: true,
    targetExists: true,
    row: null as ConversationState | null,
    finds: [] as CheckpointScopeKey[],
    insert() {
      throw new Error("fork insertion is outside this fixture");
    },
    exists(): boolean {
      return state.targetExists;
    },
    find(key: CheckpointScopeKey): ConversationState | null {
      state.finds.push(key);
      return state.row;
    },
    clearBackendRef(key: CheckpointScopeKey): boolean {
      state.cleared.push(key);
      return state.present;
    },
  };
  return state;
}

let db: Db;
let repo: ConversationCheckpointsRepo;
let continuation: ReturnType<typeof recordingContinuation>;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  continuation = recordingContinuation();
  repo = createConversationCheckpointsRepo(
    db,
    createWriteQueue(),
    continuation,
  );
});

afterEach(() => {
  db.close();
});

function unwrap<T>(result: CheckpointResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success, got refusal ${result.refusal.code}: ${result.refusal.reason}`,
    );
  }
  return result.value;
}

function refusalOf<T>(result: CheckpointResult<T>) {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
}

function buildPayload(
  operationId: string,
  overrides: Partial<CheckpointPayload> = {},
): CheckpointPayload {
  const seedText = "## Working state\nShip the widget.\n";
  return {
    id: operationId,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: BASIS,
    artifactProvenance: null,
    versions: {
      generatorVersion: "gen-1",
      builderVersion: "builder-1",
      normalizerVersion: "norm-1",
    },
    modelSelection: { modelId: "claude-opus-5", parameters: {} },
    sections: {
      workingState: { objective: "Ship the widget" },
      recentDialogue: [{ role: "user", text: "keep going" }],
      recoveryMap: { commands: ["cctl conversation read conv-session"] },
    },
    seedText,
    seedSha256: "sha256:seed-a",
    sectionBytes: {
      total: Buffer.byteLength(seedText, "utf8"),
      workingState: 20,
      recentDialogue: 8,
      recoveryFraming: 6,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: "2026-09-07T12:00:00.000Z",
    ...overrides,
  };
}

async function admit(
  key: CheckpointScopeKey,
  requestId: string,
): Promise<CheckpointOperation> {
  return unwrap(
    await repo.admitOperation({
      key,
      requestId,
      sourceBasis: BASIS,
      priorBackendRef: PRIOR_REF,
      requestedAt: "2026-09-07T11:59:00.000Z",
    }),
  ).operation;
}

/** Drive an admitted operation all the way to `ready`. */
async function makeReady(
  key: CheckpointScopeKey,
  requestId: string,
): Promise<CheckpointOperation> {
  const admitted = await admit(key, requestId);
  unwrap(
    await repo.freezePayload({
      key,
      operationId: admitted.id,
      payload: buildPayload(admitted.id),
      at: "2026-09-07T12:00:00.000Z",
    }),
  );
  return unwrap(
    await repo.commitReady({
      key,
      operationId: admitted.id,
      at: "2026-09-07T12:00:05.000Z",
    }),
  );
}

/** Drive an operation from `ready` to `applied`. */
async function apply(
  key: CheckpointScopeKey,
  operationId: string,
  attemptId = "attempt-1",
): Promise<CheckpointOperation> {
  unwrap(
    await repo.beginDelivery({
      key,
      operationId,
      binding: {
        attemptId,
        inputFingerprint: "sha256:input-a",
        submittedInputFingerprint: "sha256:input-a",
        queuedAttemptId: null,
        queuedMessageId: null,
      },
      at: "2026-09-07T12:01:00.000Z",
    }),
  );
  return unwrap(
    await repo.recordAcceptance({
      key,
      operationId,
      acceptance: {
        attemptId,
        seedHash: "sha256:seed-a",
        acceptedAt: "2026-09-07T12:01:02.000Z",
      },
      acceptedBackendRef: "fresh-provider-session-71ac",
    }),
  );
}

describe("checkpoint admission", () => {
  it("persists a durable building operation before any generation happens", async () => {
    const operation = await admit(SESSION_KEY, "req-1");

    expect(operation.phase).toBe("building");
    expect(operation.ordinal).toBe(1);
    expect(operation.payloadId).toBeNull();
    expect(operation.sourceBasis).toEqual(BASIS);

    const reloaded = await repo.getOperation(SESSION_KEY, operation.id);
    expect(reloaded).toEqual(operation);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversation_checkpoints WHERE id = ?",
        )
        .get(operation.id),
    ).toEqual({ n: 0 });
  });

  it("returns the existing operation when the same request UUID is reused", async () => {
    const first = await admit(SESSION_KEY, "req-1");
    const again = await repo.admitOperation({
      key: SESSION_KEY,
      requestId: "req-1",
      sourceBasis: { capturedThroughSeq: 999, sourceHash: "sha256:later" },
      priorBackendRef: "some-other-ref",
      requestedAt: "2026-09-07T12:30:00.000Z",
    });

    const reused = unwrap(again);
    expect(reused.outcome).toBe("reused");
    // Idempotent replay returns the DURABLE operation, not the retry's inputs.
    expect(reused.operation).toEqual(first);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversation_checkpoint_operations WHERE conversation_id = ?",
        )
        .get(SESSION_KEY.conversationId),
    ).toEqual({ n: 1 });
  });

  it("refuses a different ordinary request while one is active and leaves it untouched", async () => {
    const active = await admit(SESSION_KEY, "req-1");
    const refusal = refusalOf(
      await repo.admitOperation({
        key: SESSION_KEY,
        requestId: "req-2",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:05:00.000Z",
      }),
    );

    expect(refusal.code).toBe("checkpoint_pending");
    expect(refusal.operationId).toBe(active.id);
    expect(refusal.phase).toBe("building");
    expect(await repo.getOperation(SESSION_KEY, active.id)).toEqual(active);
    expect(await repo.getOperation(SESSION_KEY, "req-2")).toBeNull();
  });

  it("refuses a request UUID that already addresses a different conversation", async () => {
    await admit(SESSION_KEY, "req-1");
    const refusal = refusalOf(
      await repo.admitOperation({
        key: PROJECT_KEY,
        requestId: "req-1",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:05:00.000Z",
      }),
    );

    expect(refusal.code).toBe("request_id_conflict");
    // The other conversation learns nothing about the operation it collided with.
    expect(refusal.operationId).toBeNull();
    expect(refusal.phase).toBeNull();
  });

  it("increases ordinals per conversation and keeps conversations independent", async () => {
    const first = await makeReady(SESSION_KEY, "req-1");
    await apply(SESSION_KEY, first.id);
    const second = await makeReady(SESSION_KEY, "req-2");
    const otherScope = await admit(PROJECT_KEY, "req-3");

    expect(first.ordinal).toBe(1);
    expect(second.ordinal).toBe(2);
    expect(otherScope.ordinal).toBe(1);
  });

  it("admits exactly one of several operations competing for the same conversation", async () => {
    const results = await Promise.all(
      ["req-a", "req-b", "req-c", "req-d"].map((requestId) =>
        repo.admitOperation({
          key: SESSION_KEY,
          requestId,
          sourceBasis: BASIS,
          priorBackendRef: PRIOR_REF,
          requestedAt: "2026-09-07T11:59:00.000Z",
        }),
      ),
    );

    const admitted = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(3);
    for (const result of refused) {
      expect(refusalOf(result).code).toBe("checkpoint_pending");
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversation_checkpoint_operations WHERE conversation_id = ?",
        )
        .get(SESSION_KEY.conversationId),
    ).toEqual({ n: 1 });
  });

  it("allocates a fresh ordinal for concurrent admissions on different conversations", async () => {
    const keys = ["c1", "c2", "c3"].map((id) => ({
      ...SESSION_KEY,
      conversationId: id,
    }));
    const results = await Promise.all(
      keys.map((key, index) =>
        repo.admitOperation({
          key,
          requestId: `req-${index}`,
          sourceBasis: BASIS,
          priorBackendRef: PRIOR_REF,
          requestedAt: "2026-09-07T11:59:00.000Z",
        }),
      ),
    );

    for (const result of results) {
      expect(unwrap(result).operation.ordinal).toBe(1);
    }
  });
});

describe("checkpoint scope isolation", () => {
  it("exposes no operation, seed, or provider reference to the wrong scope", async () => {
    const sessionOp = await makeReady(SESSION_KEY, "req-session");
    const projectKeyWithSessionId: CheckpointScopeKey = {
      ...PROJECT_KEY,
      conversationId: SESSION_KEY.conversationId,
    };

    expect(
      await repo.getOperation(projectKeyWithSessionId, sessionOp.id),
    ).toBeNull();
    expect(
      await repo.getReceipt(projectKeyWithSessionId, sessionOp.id),
    ).toBeNull();
    expect(
      await repo.getPayload(projectKeyWithSessionId, sessionOp.id),
    ).toBeNull();
    expect((await repo.listReceipts(projectKeyWithSessionId)).receipts).toEqual(
      [],
    );
  });

  it("refuses a wrong-scope mutation instead of moving the real operation", async () => {
    const sessionOp = await makeReady(SESSION_KEY, "req-session");
    const wrongScope: CheckpointScopeKey = {
      ...PROJECT_KEY,
      conversationId: SESSION_KEY.conversationId,
    };

    const refusal = refusalOf(
      await repo.beginDelivery({
        key: wrongScope,
        operationId: sessionOp.id,
        binding: {
          attemptId: "attempt-x",
          inputFingerprint: "sha256:input-x",
          submittedInputFingerprint: "sha256:input-x",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:10:00.000Z",
      }),
    );

    expect(refusal.code).toBe("checkpoint_not_found");
    expect((await repo.getOperation(SESSION_KEY, sessionOp.id))?.phase).toBe(
      "ready",
    );
  });

  it("keeps a different session's conversation out of another session's list", async () => {
    await makeReady(SESSION_KEY, "req-session");
    const otherSession: CheckpointScopeKey = {
      ...SESSION_KEY,
      sessionName: "csm-beta",
    };

    expect((await repo.listReceipts(otherSession)).receipts).toEqual([]);
    expect(await repo.getOperation(otherSession, "req-session")).toBeNull();
  });
});

describe("immutable payload freeze", () => {
  it("inserts the payload once and advances to retiring in one durable step", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const frozen = unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id),
        at: "2026-09-07T12:00:00.000Z",
      }),
    );

    expect(frozen.phase).toBe("retiring");
    expect(frozen.payloadId).toBe(admitted.id);
    const payload = await repo.getPayload(SESSION_KEY, admitted.id);
    expect(payload).toEqual(buildPayload(admitted.id));
  });

  it("refuses a payload whose source basis differs from the captured one, writing nothing", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const refusal = refusalOf(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id, {
          sourceBasis: {
            capturedThroughSeq: 121,
            sourceHash: BASIS.sourceHash,
          },
        }),
        at: "2026-09-07T12:00:00.000Z",
      }),
    );

    expect(refusal.code).toBe("source_basis_mismatch");
    expect(await repo.getPayload(SESSION_KEY, admitted.id)).toBeNull();
    expect((await repo.getOperation(SESSION_KEY, admitted.id))?.phase).toBe(
      "building",
    );
  });

  it("refuses a payload whose declared total bytes disagree with the seed", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const payload = buildPayload(admitted.id);
    const refusal = refusalOf(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: {
          ...payload,
          sectionBytes: { ...payload.sectionBytes, total: 1 },
        },
        at: "2026-09-07T12:00:00.000Z",
      }),
    );

    expect(refusal.code).toBe("invalid_payload");
    expect(await repo.getPayload(SESSION_KEY, admitted.id)).toBeNull();
  });

  it("refuses a second freeze and leaves the first payload's bytes untouched", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id),
        at: "2026-09-07T12:00:00.000Z",
      }),
    );

    const refusal = refusalOf(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id, {
          seedText: "REWRITTEN",
          seedSha256: "sha256:rewritten",
          sectionBytes: {
            total: Buffer.byteLength("REWRITTEN", "utf8"),
            workingState: 9,
            recentDialogue: 0,
            recoveryFraming: 0,
          },
        }),
        at: "2026-09-07T12:00:10.000Z",
      }),
    );

    expect(refusal.code).toBe("illegal_transition");
    const payload = await repo.getPayload(SESSION_KEY, admitted.id);
    expect(payload?.seedText).toBe(buildPayload(admitted.id).seedText);
    expect(payload?.seedSha256).toBe("sha256:seed-a");
  });

  it("aborts a direct UPDATE against a frozen payload at the storage layer", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id),
        at: "2026-09-07T12:00:00.000Z",
      }),
    );

    expect(() =>
      db
        .prepare(
          "UPDATE conversation_checkpoints SET seed_text = ? WHERE id = ?",
        )
        .run("rewritten out of band", admitted.id),
    ).toThrow(/immutable/i);
    expect((await repo.getPayload(SESSION_KEY, admitted.id))?.seedText).toBe(
      buildPayload(admitted.id).seedText,
    );
  });

  it("keeps the frozen payload when a later operation on the same conversation is built", async () => {
    const first = await makeReady(SESSION_KEY, "req-1");
    await apply(SESSION_KEY, first.id);
    const firstPayload = await repo.getPayload(SESSION_KEY, first.id);

    const second = await makeReady(SESSION_KEY, "req-2");
    expect(second.id).not.toBe(first.id);
    expect(await repo.getPayload(SESSION_KEY, first.id)).toEqual(firstPayload);
  });
});

describe("checkpoint transitions", () => {
  it("asks the continuation seam to clear the addressed target as it publishes readiness", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");

    expect(ready.phase).toBe("ready");
    expect(continuation.cleared).toEqual([SESSION_KEY]);
  });

  it("refuses readiness and leaves the operation retiring when the target is gone", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id),
        at: "2026-09-07T12:00:00.000Z",
      }),
    );
    continuation.present = false;

    const refusal = refusalOf(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: admitted.id,
        at: "2026-09-07T12:00:05.000Z",
      }),
    );

    expect(refusal.code).toBe("target_conversation_missing");
    expect((await repo.getOperation(SESSION_KEY, admitted.id))?.phase).toBe(
      "retiring",
    );
  });

  it("refuses a transition the lifecycle does not allow", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const refusal = refusalOf(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: admitted.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    expect(refusal.code).toBe("illegal_transition");
    expect(refusal.phase).toBe("building");
  });

  it("refuses an outcome whose expected phase is stale", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "building",
        phase: "failed",
        failure: { code: "generation_failed", message: "schema guard" },
        at: "2026-09-07T12:02:00.000Z",
      }),
    );

    expect(refusal.code).toBe("stale_operation");
    expect(refusal.phase).toBe("ready");
    expect((await repo.getOperation(SESSION_KEY, ready.id))?.phase).toBe(
      "ready",
    );
  });

  it("binds the delivery attempt before the provider is called", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const delivering = unwrap(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: "queued-attempt-3",
          queuedMessageId: "queued-message-3",
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    expect(delivering.phase).toBe("delivering");
    expect(delivering.delivery).toEqual({
      attemptId: "attempt-1",
      inputFingerprint: "sha256:input-a",
      submittedInputFingerprint: "sha256:input-a",
      queuedAttemptId: "queued-attempt-3",
      queuedMessageId: "queued-message-3",
    });
  });

  it("refuses acceptance evidence from a different attempt", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    const refusal = refusalOf(
      await repo.recordAcceptance({
        key: SESSION_KEY,
        operationId: ready.id,
        acceptance: {
          attemptId: "attempt-2",
          seedHash: "sha256:seed-a",
          acceptedAt: "2026-09-07T12:01:02.000Z",
        },
        acceptedBackendRef: "fresh-provider-session-71ac",
      }),
    );

    expect(refusal.code).toBe("attempt_mismatch");
    expect((await repo.getOperation(SESSION_KEY, ready.id))?.phase).toBe(
      "delivering",
    );
  });

  it("refuses acceptance whose seed hash does not match the frozen payload", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    const refusal = refusalOf(
      await repo.recordAcceptance({
        key: SESSION_KEY,
        operationId: ready.id,
        acceptance: {
          attemptId: "attempt-1",
          seedHash: "sha256:some-other-seed",
          acceptedAt: "2026-09-07T12:01:02.000Z",
        },
        acceptedBackendRef: "fresh-provider-session-71ac",
      }),
    );

    expect(refusal.code).toBe("attempt_mismatch");
  });

  it("treats a repeated acceptance with identical evidence as idempotent", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const applied = await apply(SESSION_KEY, ready.id);
    const again = unwrap(
      await repo.recordAcceptance({
        key: SESSION_KEY,
        operationId: ready.id,
        acceptance: {
          attemptId: "attempt-1",
          seedHash: "sha256:seed-a",
          acceptedAt: "2026-09-07T12:01:02.000Z",
        },
        acceptedBackendRef: "fresh-provider-session-71ac",
      }),
    );

    expect(again).toEqual(applied);
  });

  it("returns a delivering seed to ready for a definite pre-acceptance failure", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    const returned = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-1",
        expectedPhase: "delivering",
        phase: "ready",
        at: "2026-09-07T12:01:03.000Z",
      }),
    );

    expect(returned.phase).toBe("ready");
    expect(returned.payloadId).toBe(ready.id);
    expect(await repo.getPayload(SESSION_KEY, ready.id)).not.toBeNull();
  });

  it("records the last stable phase when an operation needs reconciliation", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const blocked = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "needs_reconciliation",
        failure: { code: "close_failed", message: "runtime close rejected" },
        at: "2026-09-07T12:02:00.000Z",
      }),
    );

    expect(blocked.lastStablePhase).toBe("ready");
    expect(blocked.failure).toEqual({
      code: "close_failed",
      message: "runtime close rejected",
    });
  });

  it("retains accepted provenance after an applied operation later needs recovery", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const applied = await apply(SESSION_KEY, ready.id);
    const recovering = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "applied",
        phase: "needs_reconciliation",
        failure: {
          code: "continuation_unusable",
          message: "provider session rejected",
        },
        at: "2026-09-07T12:30:00.000Z",
      }),
    );

    expect(recovering.acceptance).toEqual(applied.acceptance);
    expect(recovering.protectedReferences.acceptedBackendRef).toBe(
      "fresh-provider-session-71ac",
    );
    expect(recovering.lastStablePhase).toBe("applied");

    const state = await repo.getStateForAdmission(SESSION_KEY);
    expect(state.latestAccepted).toMatchObject({
      operationId: ready.id,
      currentPhase: "needs_reconciliation",
    });
  });

  it("records measured usage and generation passes without inventing zeroes", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const failed = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: admitted.id,
        expectedPhase: "building",
        phase: "failed",
        failure: { code: "generation_failed", message: "guard rejected" },
        usage: {
          inputTokens: 1200,
          cachedInputTokens: 9600,
          outputTokens: null,
          costUsd: null,
          durationMs: 640,
        },
        generationPassCount: 2,
        at: "2026-09-07T12:00:20.000Z",
      }),
    );

    expect(failed.usage).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 9600,
      outputTokens: null,
      costUsd: null,
      durationMs: 640,
    });
    expect(failed.generationPassCount).toBe(2);
  });

  it("releases the conversation's slot once an operation reaches a terminal phase", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: admitted.id,
        expectedPhase: "building",
        phase: "cancelled",
        at: "2026-09-07T12:00:20.000Z",
      }),
    );

    const next = await admit(SESSION_KEY, "req-2");
    expect(next.ordinal).toBe(2);
    expect(next.phase).toBe("building");
  });
});

describe("checkpoint recovery admission", () => {
  async function blockedOperation(requestId: string) {
    const ready = await makeReady(SESSION_KEY, requestId);
    return unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "needs_reconciliation",
        failure: { code: "delivery_unknown", message: "send outcome unknown" },
        at: "2026-09-07T12:02:00.000Z",
      }),
    );
  }

  it("refuses an ordinary start against a blocked operation", async () => {
    const blocked = await blockedOperation("req-1");
    const refusal = refusalOf(
      await repo.admitOperation({
        key: SESSION_KEY,
        requestId: "req-2",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:03:00.000Z",
      }),
    );

    expect(refusal.code).toBe("checkpoint_pending");
    expect(refusal.operationId).toBe(blocked.id);
    expect(refusal.phase).toBe("needs_reconciliation");
  });

  it("admits one linked recovery build and supersedes the addressed operation", async () => {
    const blocked = await blockedOperation("req-1");
    const recovery = unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recover",
        sourceBasis: { capturedThroughSeq: 400, sourceHash: "sha256:later" },
        priorBackendRef: "suspect-provider-session",
        requestedAt: "2026-09-07T12:04:00.000Z",
        recoversOperationId: blocked.id,
      }),
    );

    expect(recovery.operation.phase).toBe("building");
    expect(recovery.operation.recoversOperationId).toBe(blocked.id);
    expect(recovery.operation.ordinal).toBe(blocked.ordinal + 1);

    const superseded = await repo.getOperation(SESSION_KEY, blocked.id);
    // The blocked operation still records WHY it was blocked; only its hold
    // on the conversation's slot is released.
    expect(superseded?.phase).toBe("needs_reconciliation");
    expect(superseded?.failure?.code).toBe("delivery_unknown");
    expect(superseded?.supersededByOperationId).toBe(recovery.operation.id);
  });

  it("lets only one of several competing recovery requests win", async () => {
    const blocked = await blockedOperation("req-1");
    const results = await Promise.all(
      ["rec-a", "rec-b", "rec-c"].map((requestId) =>
        repo.admitRecovery({
          key: SESSION_KEY,
          requestId,
          sourceBasis: BASIS,
          priorBackendRef: PRIOR_REF,
          requestedAt: "2026-09-07T12:04:00.000Z",
          recoversOperationId: blocked.id,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((r) => !r.ok)) {
      expect(refusalOf(result).code).toBe("checkpoint_pending");
    }
  });

  it("refuses recovery addressed at an operation that is not recovery-required", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const refusal = refusalOf(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recover",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:04:00.000Z",
        recoversOperationId: ready.id,
      }),
    );

    expect(refusal.code).toBe("recovery_target_mismatch");
    expect((await repo.getOperation(SESSION_KEY, ready.id))?.phase).toBe(
      "ready",
    );
  });

  it("restores the prior recovery gate when the recovery build fails", async () => {
    const blocked = await blockedOperation("req-1");
    const recovery = unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recover",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:04:00.000Z",
        recoversOperationId: blocked.id,
      }),
    );

    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: recovery.operation.id,
        expectedPhase: "building",
        phase: "failed",
        failure: { code: "generation_failed", message: "guard rejected" },
        at: "2026-09-07T12:05:00.000Z",
      }),
    );

    const restored = await repo.getOperation(SESSION_KEY, blocked.id);
    expect(restored?.phase).toBe("needs_reconciliation");
    expect(restored?.supersededByOperationId).toBeNull();

    // The gate is genuinely back: an ordinary start is refused again.
    const refusal = refusalOf(
      await repo.admitOperation({
        key: SESSION_KEY,
        requestId: "req-after",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:06:00.000Z",
      }),
    );
    expect(refusal.code).toBe("checkpoint_pending");
    expect(refusal.operationId).toBe(blocked.id);
  });

  it("keeps both operation records and their linkage after a successful recovery", async () => {
    const blocked = await blockedOperation("req-1");
    const recovery = unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recover",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:04:00.000Z",
        recoversOperationId: blocked.id,
      }),
    );
    unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: recovery.operation.id,
        payload: buildPayload(recovery.operation.id),
        at: "2026-09-07T12:05:00.000Z",
      }),
    );
    unwrap(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: recovery.operation.id,
        at: "2026-09-07T12:05:05.000Z",
      }),
    );

    const receipts = (await repo.listReceipts(SESSION_KEY)).receipts;
    expect(receipts.map((receipt) => receipt.operationId)).toEqual([
      recovery.operation.id,
      blocked.id,
    ]);
    expect(receipts[0]?.recoversOperationId).toBe(blocked.id);
    expect(receipts[1]?.supersededByOperationId).toBe(recovery.operation.id);
  });
});

describe("checkpoint admission state", () => {
  it("reports no active operation and no accepted provenance for a fresh conversation", async () => {
    expect(await repo.getStateForAdmission(SESSION_KEY)).toEqual({
      active: null,
      latestAccepted: null,
    });
  });

  it("reports the active operation while one holds the slot", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const state = await repo.getStateForAdmission(SESSION_KEY);

    expect(state.active?.id).toBe(ready.id);
    expect(state.active?.phase).toBe("ready");
    expect(state.latestAccepted).toBeNull();
  });

  it("stops reporting a superseded operation as the active one", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "needs_reconciliation",
        failure: { code: "delivery_unknown", message: "unknown send" },
        at: "2026-09-07T12:02:00.000Z",
      }),
    );
    const recovery = unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recover",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:04:00.000Z",
        recoversOperationId: ready.id,
      }),
    );

    const state = await repo.getStateForAdmission(SESSION_KEY);
    expect(state.active?.id).toBe(recovery.operation.id);
  });

  it("selects the newest accepted provenance across several applied checkpoints", async () => {
    const first = await makeReady(SESSION_KEY, "req-1");
    await apply(SESSION_KEY, first.id, "attempt-1");
    const second = await makeReady(SESSION_KEY, "req-2");
    await apply(SESSION_KEY, second.id, "attempt-2");

    const state = await repo.getStateForAdmission(SESSION_KEY);
    expect(state.latestAccepted).toMatchObject({
      operationId: second.id,
      ordinal: 2,
      currentPhase: "applied",
    });
    expect(state.latestAccepted?.acceptance.attemptId).toBe("attempt-2");
  });

  it("keeps another scope's accepted provenance out of this conversation's state", async () => {
    const sessionOp = await makeReady(SESSION_KEY, "req-1");
    await apply(SESSION_KEY, sessionOp.id);

    expect(await repo.getStateForAdmission(PROJECT_KEY)).toEqual({
      active: null,
      latestAccepted: null,
    });
  });
});

describe("checkpoint receipt projections", () => {
  it("never selects a payload body or a provider reference into a list", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    await apply(SESSION_KEY, ready.id);

    const page = await repo.listReceipts(SESSION_KEY);
    const serialized = JSON.stringify(page);

    expect(serialized).not.toContain(PRIOR_REF);
    expect(serialized).not.toContain("fresh-provider-session-71ac");
    expect(serialized).not.toContain(buildPayload(ready.id).seedText);
    expect(page.receipts[0]?.checkpoint?.seedSha256).toBe("sha256:seed-a");
  });

  it("returns the saved seed only through the explicit payload read", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");

    expect(
      JSON.stringify(await repo.getReceipt(SESSION_KEY, ready.id)),
    ).not.toContain(buildPayload(ready.id).seedText);
    expect((await repo.getPayload(SESSION_KEY, ready.id))?.seedText).toBe(
      buildPayload(ready.id).seedText,
    );
  });

  it("defaults to 20 receipts, caps at 100, and pages by descending ordinal", async () => {
    for (let index = 0; index < 25; index += 1) {
      const ready = await makeReady(SESSION_KEY, `req-${index}`);
      await apply(SESSION_KEY, ready.id, `attempt-${index}`);
    }

    const firstPage = await repo.listReceipts(SESSION_KEY);
    expect(firstPage.receipts).toHaveLength(20);
    expect(firstPage.receipts.map((r) => r.ordinal)).toEqual(
      Array.from({ length: 20 }, (_, i) => 25 - i),
    );
    expect(firstPage.nextBefore).toBe(6);

    const secondPage = await repo.listReceipts(SESSION_KEY, {
      before: firstPage.nextBefore ?? undefined,
    });
    expect(secondPage.receipts.map((r) => r.ordinal)).toEqual([5, 4, 3, 2, 1]);
    expect(secondPage.nextBefore).toBeNull();

    expect(
      (await repo.listReceipts(SESSION_KEY, { limit: 500 })).receipts,
    ).toHaveLength(25);
  });

  it("exposes payload metadata on a receipt without the payload itself", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const receipt = await repo.getReceipt(SESSION_KEY, ready.id);

    expect(receipt?.checkpoint).toMatchObject({
      checkpointId: ready.id,
      schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
      seedSha256: "sha256:seed-a",
    });
    expect(receipt?.checkpoint?.sectionBytes.total).toBe(
      Buffer.byteLength(buildPayload(ready.id).seedText, "utf8"),
    );
    expect(receipt?.boundary).toEqual(BASIS);
  });

  it("reports a building operation with no checkpoint metadata yet", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const receipt = await repo.getReceipt(SESSION_KEY, admitted.id);

    expect(receipt?.phase).toBe("building");
    expect(receipt?.checkpoint).toBeNull();
  });
});

describe("project-scope parity", () => {
  it("runs the same lifecycle for a project conversation", async () => {
    const ready = await makeReady(PROJECT_KEY, "req-project");
    const applied = await apply(PROJECT_KEY, ready.id);

    expect(applied.phase).toBe("applied");
    expect(applied.scope).toBe("project");
    expect(applied.sessionName).toBeNull();

    const receipt = await repo.getReceipt(PROJECT_KEY, ready.id);
    expect(receipt?.scope).toBe("project");
    expect(JSON.stringify(receipt)).not.toContain("__project__");
  });
});

/**
 * A CAS on `(id, phase)` alone is not transition authority. Phase is a shared
 * slot that a later attempt can legitimately re-enter, so an outcome that names
 * only a phase can land on work it never performed. These are the three ways a
 * stale writer reaches an operation that has moved on beneath it.
 */
describe("stale attempt and recovery authority", () => {
  it("refuses a delayed outcome from an attempt other than the one now bound", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const deliver = async (attemptId: string) =>
      unwrap(
        await repo.beginDelivery({
          key: SESSION_KEY,
          operationId: ready.id,
          binding: {
            attemptId,
            inputFingerprint: `sha256:input-${attemptId}`,
            submittedInputFingerprint: `sha256:input-${attemptId}`,
            queuedAttemptId: null,
            queuedMessageId: null,
          },
          at: "2026-09-07T12:01:00.000Z",
        }),
      );

    // Attempt A definitely failed before acceptance, so the seed returns to ready.
    await deliver("attempt-a");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-a",
        expectedPhase: "delivering",
        phase: "ready",
        at: "2026-09-07T12:01:10.000Z",
      }),
    );

    // Attempt B now holds the seed.
    await deliver("attempt-b");

    // A's outcome arrives late. It still names a delivering operation, but not
    // the delivery it is about.
    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-a",
        expectedPhase: "delivering",
        phase: "ready",
        at: "2026-09-07T12:01:20.000Z",
      }),
    );

    expect(refusal.code).toBe("attempt_mismatch");
    const current = await repo.getOperation(SESSION_KEY, ready.id);
    expect(current?.phase).toBe("delivering");
    expect(current?.delivery?.attemptId).toBe("attempt-b");
  });

  it("accepts an outcome from a phase the attempt does not own, even when one is supplied", async () => {
    // The CAS backstop must state the same rule as the guard: an operation that
    // never bound a delivery is not attempt-scoped. A caller that passes its
    // attempt on a build failure would otherwise be refused for a binding that
    // does not exist.
    const admitted = await admit(SESSION_KEY, "req-1");

    const failed = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: admitted.id,
        attemptId: "attempt-unrelated",
        expectedPhase: "building",
        phase: "failed",
        failure: {
          code: "generation_failed",
          message: "the build did not finish",
        },
        at: "2026-09-07T12:00:30.000Z",
      }),
    );

    expect(failed.phase).toBe("failed");
    expect(failed.failure?.code).toBe("generation_failed");
  });

  it("refuses an outcome on an operation a recovery build has superseded", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:02:00.000Z",
      }),
    );
    unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recovery",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:03:00.000Z",
        recoversOperationId: ready.id,
      }),
    );

    // The recovery build owns the conversation now; the superseded operation
    // must keep recording WHY it was blocked.
    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:03:30.000Z",
      }),
    );

    expect(refusal.code).toBe("stale_operation");
    const current = await repo.getOperation(SESSION_KEY, ready.id);
    expect(current?.phase).toBe("needs_reconciliation");
    expect(current?.supersededByOperationId).toBe("req-recovery");
  });

  it("refuses a replayed acceptance against an operation that lost its applied continuation", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const applied = await apply(SESSION_KEY, ready.id, "attempt-1");

    // The accepted provider reference is gone; the operation needs a fresh
    // recovery checkpoint, not a replay of this one.
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "applied",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:04:00.000Z",
      }),
    );

    const refusal = refusalOf(
      await repo.recordAcceptance({
        key: SESSION_KEY,
        operationId: ready.id,
        acceptance: applied.acceptance ?? {
          attemptId: "attempt-1",
          seedHash: "sha256:seed-a",
          acceptedAt: "2026-09-07T12:01:02.000Z",
        },
        acceptedBackendRef: "fresh-provider-session-71ac",
      }),
    );

    expect(refusal.code).toBe("stale_operation");
    const current = await repo.getOperation(SESSION_KEY, ready.id);
    expect(current?.phase).toBe("needs_reconciliation");
    expect(current?.lastStablePhase).toBe("applied");
    // The proof this seed was once applied survives the refusal.
    expect(current?.acceptance).toEqual(applied.acceptance);
  });
});

describe("admission target existence", () => {
  it("refuses to admit an operation for a conversation that is not there", async () => {
    continuation.targetExists = false;

    const refusal = refusalOf(
      await repo.admitOperation({
        key: SESSION_KEY,
        requestId: "req-orphan",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T11:59:00.000Z",
      }),
    );

    expect(refusal.code).toBe("target_conversation_missing");
    // Nothing is left holding the conversation's checkpoint slot: an operation
    // for a conversation that does not exist would never be cleaned by the
    // deletion triggers, because no row remains whose delete could fire them.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversation_checkpoint_operations WHERE id = ?",
        )
        .get("req-orphan"),
    ).toEqual({ n: 0 });
  });

  it("refuses a recovery build whose conversation disappeared", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:02:00.000Z",
      }),
    );
    continuation.targetExists = false;

    const refusal = refusalOf(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recovery",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:03:00.000Z",
        recoversOperationId: ready.id,
      }),
    );

    expect(refusal.code).toBe("target_conversation_missing");
    // The gate the recovery would have released stays shut.
    const target = await repo.getOperation(SESSION_KEY, ready.id);
    expect(target?.supersededByOperationId).toBeNull();
  });
});

describe("outcome edge authority", () => {
  /** Drive an operation to `retiring` with its payload frozen. */
  async function makeRetiring(requestId: string): Promise<CheckpointOperation> {
    const admitted = await admit(SESSION_KEY, requestId);
    return unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id),
        at: "2026-09-07T12:00:00.000Z",
      }),
    );
  }

  it("refuses a generic outcome that would retire without a frozen payload", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");

    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: admitted.id,
        expectedPhase: "building",
        phase: "retiring",
        at: "2026-09-07T12:00:30.000Z",
      }),
    );

    expect(refusal.code).toBe("illegal_transition");
    expect(refusal.reason).toContain("freezePayload");
    expect((await repo.getOperation(SESSION_KEY, admitted.id))?.phase).toBe(
      "building",
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversation_checkpoints WHERE id = ?",
        )
        .get(admitted.id),
    ).toEqual({ n: 0 });
  });

  it("refuses a generic outcome that would publish readiness without retiring the runtime", async () => {
    const retiring = await makeRetiring("req-1");

    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: retiring.id,
        expectedPhase: "retiring",
        phase: "ready",
        at: "2026-09-07T12:00:30.000Z",
      }),
    );

    expect(refusal.code).toBe("illegal_transition");
    expect(refusal.reason).toContain("commitReady");
    expect((await repo.getOperation(SESSION_KEY, retiring.id))?.phase).toBe(
      "retiring",
    );
    // The reference the checkpoint retires is untouched by a refused outcome.
    expect(continuation.cleared).toEqual([]);
  });

  it("refuses a generic outcome that would enter delivery with nothing bound", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");

    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "delivering",
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    expect(refusal.code).toBe("illegal_transition");
    expect(refusal.reason).toContain("beginDelivery");
    const current = await repo.getOperation(SESSION_KEY, ready.id);
    expect(current?.phase).toBe("ready");
    expect(current?.delivery).toBeNull();
  });

  it("refuses a generic outcome that would record acceptance from either phase", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );

    const fromDelivering = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-1",
        expectedPhase: "delivering",
        phase: "applied",
        at: "2026-09-07T12:01:05.000Z",
      }),
    );
    expect(fromDelivering.code).toBe("illegal_transition");
    expect(fromDelivering.reason).toContain("recordAcceptance");

    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-1",
        expectedPhase: "delivering",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:01:10.000Z",
      }),
    );
    const fromReconciliation = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-1",
        expectedPhase: "needs_reconciliation",
        phase: "applied",
        at: "2026-09-07T12:01:15.000Z",
      }),
    );

    expect(fromReconciliation.code).toBe("illegal_transition");
    expect(fromReconciliation.reason).toContain("recordAcceptance");
    const current = await repo.getOperation(SESSION_KEY, ready.id);
    expect(current?.phase).toBe("needs_reconciliation");
    expect(current?.acceptance).toBeNull();
  });

  it("completes an interrupted retirement through readiness rather than an outcome", async () => {
    const retiring = await makeRetiring("req-1");
    const blocked = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: retiring.id,
        expectedPhase: "retiring",
        phase: "needs_reconciliation",
        failure: { code: "close_failed", message: "runtime close rejected" },
        at: "2026-09-07T12:00:40.000Z",
      }),
    );
    expect(blocked.lastStablePhase).toBe("retiring");

    // The repair is the retirement itself, so an outcome cannot declare it done.
    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: retiring.id,
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:00:50.000Z",
      }),
    );
    expect(refusal.code).toBe("illegal_transition");
    expect(refusal.reason).toContain("commitReady");
    expect(continuation.cleared).toEqual([]);

    const repaired = unwrap(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: retiring.id,
        at: "2026-09-07T12:00:55.000Z",
      }),
    );

    expect(repaired.phase).toBe("ready");
    // The interruption is repaired, so it is no longer the operation's state.
    expect(repaired.lastStablePhase).toBeNull();
    expect(continuation.cleared).toEqual([SESSION_KEY]);
  });

  it("refuses readiness for an operation a recovery build has superseded", async () => {
    const retiring = await makeRetiring("req-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: retiring.id,
        expectedPhase: "retiring",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:00:40.000Z",
      }),
    );
    unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "req-recovery",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:00:45.000Z",
        recoversOperationId: retiring.id,
      }),
    );

    const refusal = refusalOf(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: retiring.id,
        at: "2026-09-07T12:00:50.000Z",
      }),
    );

    expect(refusal.code).toBe("stale_operation");
    expect(continuation.cleared).toEqual([]);
    expect((await repo.getOperation(SESSION_KEY, retiring.id))?.phase).toBe(
      "needs_reconciliation",
    );
  });

  it("refuses returning a lost applied continuation's seed to ready", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const applied = await apply(SESSION_KEY, ready.id, "attempt-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "applied",
        phase: "needs_reconciliation",
        failure: {
          code: "continuation_unusable",
          message: "provider session rejected",
        },
        at: "2026-09-07T12:30:00.000Z",
      }),
    );

    // R8: a reference loss needs a fresh recovery checkpoint covering the
    // history since. Handing this seed back would let beginDelivery bind it
    // again and omit every turn the accepted runtime took.
    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-1",
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:30:10.000Z",
      }),
    );

    expect(refusal.code).toBe("stale_operation");
    const current = await repo.getOperation(SESSION_KEY, ready.id);
    expect(current?.phase).toBe("needs_reconciliation");
    expect(current?.acceptance).toEqual(applied.acceptance);
    expect(current?.lastStablePhase).toBe("applied");

    // The seed stays out of reach of a new attempt as well.
    const rebind = refusalOf(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-2",
          inputFingerprint: "sha256:input-b",
          submittedInputFingerprint: "sha256:input-b",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:30:20.000Z",
      }),
    );
    expect(rebind.code).toBe("illegal_transition");
  });

  it("refuses a reconciliation exit that names a different attempt than the blocked delivery", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    const deliver = async (attemptId: string) =>
      unwrap(
        await repo.beginDelivery({
          key: SESSION_KEY,
          operationId: ready.id,
          binding: {
            attemptId,
            inputFingerprint: `sha256:input-${attemptId}`,
            submittedInputFingerprint: `sha256:input-${attemptId}`,
            queuedAttemptId: null,
            queuedMessageId: null,
          },
          at: "2026-09-07T12:01:00.000Z",
        }),
      );

    await deliver("attempt-a");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-a",
        expectedPhase: "delivering",
        phase: "ready",
        at: "2026-09-07T12:01:10.000Z",
      }),
    );
    await deliver("attempt-b");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-b",
        expectedPhase: "delivering",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:01:20.000Z",
      }),
    );

    // Attempt A's reconciliation outcome arrives late. It proves nothing about
    // attempt B, whose delivery is the one now blocked.
    const stale = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-a",
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:01:30.000Z",
      }),
    );
    expect(stale.code).toBe("attempt_mismatch");
    expect((await repo.getOperation(SESSION_KEY, ready.id))?.phase).toBe(
      "needs_reconciliation",
    );

    const repaired = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-b",
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:01:40.000Z",
      }),
    );
    expect(repaired.phase).toBe("ready");
    expect(repaired.lastStablePhase).toBeNull();
  });

  it("requires a blocked delivery's reconciliation exit to name its attempt", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.beginDelivery({
        key: SESSION_KEY,
        operationId: ready.id,
        binding: {
          attemptId: "attempt-1",
          inputFingerprint: "sha256:input-a",
          submittedInputFingerprint: "sha256:input-a",
          queuedAttemptId: null,
          queuedMessageId: null,
        },
        at: "2026-09-07T12:01:00.000Z",
      }),
    );
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        attemptId: "attempt-1",
        expectedPhase: "delivering",
        phase: "needs_reconciliation",
        at: "2026-09-07T12:01:10.000Z",
      }),
    );

    const refusal = refusalOf(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:01:20.000Z",
      }),
    );

    expect(refusal.code).toBe("attempt_mismatch");
    expect((await repo.getOperation(SESSION_KEY, ready.id))?.phase).toBe(
      "needs_reconciliation",
    );
  });

  it("returns a reconciled ready operation to ready without an attempt it never had", async () => {
    const ready = await makeReady(SESSION_KEY, "req-1");
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "ready",
        phase: "needs_reconciliation",
        failure: { code: "receipt_write_failed", message: "snapshot rejected" },
        at: "2026-09-07T12:02:00.000Z",
      }),
    );

    const repaired = unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: ready.id,
        expectedPhase: "needs_reconciliation",
        phase: "ready",
        at: "2026-09-07T12:02:10.000Z",
      }),
    );

    expect(repaired.phase).toBe("ready");
    expect(repaired.lastStablePhase).toBeNull();
    expect(repaired.payloadId).toBe(ready.id);
  });
});

describe("freeze fence durable observation", () => {
  it("hands the fence the addressed conversation row as it is inside the freeze, and writes nothing when the fence refuses", async () => {
    const admitted = await admit(SESSION_KEY, "req-1");
    const claimed = makeConversationState({
      id: SESSION_KEY.conversationId,
      owner: { kind: "collaboration", workflowId: "wf", attemptEpoch: 0 },
    });
    continuation.row = claimed;
    const seen: (ConversationState | null)[] = [];
    const refusal = refusalOf(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: admitted.id,
        payload: buildPayload(admitted.id),
        at: "2026-09-07T12:00:00.000Z",
        fence: (conversation) => {
          seen.push(conversation);
          return conversation?.owner
            ? { code: "conversation_owned", message: "claimed" }
            : null;
        },
      }),
    );
    expect(refusal.code).toBe("fence_refused");
    expect(seen).toEqual([claimed]);
    expect(continuation.finds).toEqual([SESSION_KEY]);
    expect(await repo.getPayload(SESSION_KEY, admitted.id)).toBeNull();
    expect((await repo.getOperation(SESSION_KEY, admitted.id))?.phase).toBe(
      "building",
    );
  });
});
