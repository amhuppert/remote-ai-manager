import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { pendingHandoff, capturedHandoff } from "./handoff-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import type { CheckpointConversationGateway } from "./continuation";
import {
  createConversationCheckpointsRepo,
  type CheckpointResult,
  type ConversationCheckpointsRepo,
} from "./repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  checkpointOperationSchema,
  checkpointPayloadSchema,
  type CheckpointOperation,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: "/projects/maximal",
  sessionName: "csm-maximal",
  conversationId: "conv-maximal",
};

/** The blocked original, the recovery that applied then broke, and its successor. */
const BLOCKED_ID = "operation-blocked";
const MAXIMAL_ID = "operation-maximal";
const SUCCESSOR_ID = "operation-successor";

const BLOCKED_BASIS = { capturedThroughSeq: 120, sourceHash: "sha256:basis-a" };
const MAXIMAL_BASIS = { capturedThroughSeq: 410, sourceHash: "sha256:basis-b" };
const SUCCESSOR_BASIS = {
  capturedThroughSeq: 902,
  sourceHash: "sha256:basis-c",
};

/**
 * The continuation seam as a recording double. These tests own phase and
 * transition behaviour over the checkpoint tables; the real writer's effect on
 * a conversation row is proved against real rows in `readiness.test.ts`.
 */
function recordingContinuation(): CheckpointConversationGateway & {
  cleared: CheckpointScopeKey[];
  present: boolean;
} {
  const state = {
    cleared: [] as CheckpointScopeKey[],
    present: true,
    insert() {
      throw new Error("fork insertion is outside this fixture");
    },
    exists(): boolean {
      return true;
    },
    find(): null {
      return null;
    },
    clearBackendRef(key: CheckpointScopeKey): boolean {
      state.cleared.push(key);
      return state.present;
    },
  };
  return state;
}

let db: Db;
let fixture: PersistenceFixture;
let repo: ConversationCheckpointsRepo;
let continuation: ReturnType<typeof recordingContinuation>;

beforeEach(() => {
  fixture = createPersistenceFixture();
  db = fixture.db;
  continuation = recordingContinuation();
  repo = createConversationCheckpointsRepo(
    db,
    createWriteQueue(),
    continuation,
  );
});

afterEach(() => {
  fixture.close();
});

function unwrap<T>(result: CheckpointResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success, got refusal ${result.refusal.code}: ${result.refusal.reason}`,
    );
  }
  return result.value;
}

/**
 * A payload with every optional and nullable field populated and every array
 * non-empty: artifact provenance present, omissions recorded, more than one
 * generation pass, distinct per-section byte counts.
 */
function buildMaximalPayload(id: string): CheckpointPayload {
  const seedText =
    "## Working state\nObjective: land the checkpoint store.\n\n## Recent dialogue\n> keep going\n";
  return {
    id,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: MAXIMAL_BASIS,
    artifactProvenance: {
      artifactId: "artifact-reused-7",
      artifactSourceHash: "sha256:basis-b",
    },
    versions: {
      generatorVersion: "generator-4",
      builderVersion: "builder-2",
      normalizerVersion: "normalizer-9",
    },
    modelSelection: {
      modelId: "claude-opus-5",
      parameters: { reasoning: "high", fast: "false" },
    },
    sections: {
      workingState: {
        objective: "land the checkpoint store",
        decisions: [{ id: "d1", status: "superseded" }],
      },
      recentDialogue: [
        { role: "user", text: "keep going", seqStart: 402, seqEnd: 404 },
      ],
      recoveryMap: {
        commands: ["cctl conversation read conv-maximal --outline"],
      },
    },
    seedText,
    seedSha256: "sha256:seed-maximal",
    sectionBytes: {
      total: Buffer.byteLength(seedText, "utf8"),
      workingState: 44,
      recentDialogue: 30,
      recoveryFraming: 14,
    },
    omissions: [
      { category: "evidence_map_entries", detail: "3 entries dropped" },
      { category: "recent_dialogue", detail: "oldest exchange excerpted" },
    ],
    generationPassCount: 3,
    createdAt: "2026-09-07T12:05:00.000Z",
  };
}

/**
 * Maximal mapping fixture: the baseline columns follow the delivery/recovery
 * lifecycle below. Handoff metadata combines mutually exclusive lifecycle
 * fields to exercise every persisted key without excluding nullable paths from
 * the durability harness. Reachable capture outcomes are tested separately.
 */
function buildMaximalOperation(): CheckpointOperation {
  return {
    handoff: capturedHandoff({
      categoryCounts: {
        plan: 1,
        hypotheses: 1,
        failedApproaches: 1,
        blockers: 1,
        nextStep: 1,
      },
      stage: "omitted",
      omissionReason: "cancelled",
      stopIntent: "cancel",
      finalizedAt: "finalized",
      executionStopAttestation: { at: "attested", source: "cli" },
    }),
    id: MAXIMAL_ID,
    scope: "session",
    projectPath: KEY.projectPath,
    sessionName: KEY.sessionName,
    conversationId: KEY.conversationId,
    ordinal: 2,
    phase: "needs_reconciliation",
    lastStablePhase: "applied",
    sourceBasis: MAXIMAL_BASIS,
    protectedReferences: {
      priorBackendRef: "prior-provider-session-maximal",
      acceptedBackendRef: "accepted-provider-session-maximal",
    },
    payloadId: MAXIMAL_ID,
    delivery: {
      attemptId: "attempt-maximal",
      inputFingerprint: "sha256:assembled-input",
      submittedInputFingerprint: "sha256:submitted-input",
      queuedAttemptId: "queued-attempt-maximal",
      queuedMessageId: "queued-message-maximal",
    },
    acceptance: {
      attemptId: "attempt-maximal",
      seedHash: "sha256:seed-maximal",
      acceptedAt: "2026-09-07T12:06:00.000Z",
    },
    failure: {
      code: "continuation_unusable",
      message: "provider rejected the accepted session",
    },
    recoversOperationId: BLOCKED_ID,
    supersededByOperationId: SUCCESSOR_ID,
    generationPassCount: 3,
    usage: {
      inputTokens: 31_500,
      cachedInputTokens: 118_200,
      outputTokens: 2_100,
      costUsd: 0.87,
      durationMs: 12_400,
    },
    requestedAt: "2026-09-07T12:04:00.000Z",
    updatedAt: "2026-09-07T12:08:00.000Z",
  };
}

/** Block an original operation on an unknown delivery outcome. */
async function seedBlockedOperation(): Promise<void> {
  unwrap(
    await repo.admitOperation({
      key: KEY,
      requestId: BLOCKED_ID,
      sourceBasis: BLOCKED_BASIS,
      priorBackendRef: "prior-provider-session-blocked",
      requestedAt: "2026-09-07T11:00:00.000Z",
    }),
  );
  unwrap(
    await repo.freezePayload({
      key: KEY,
      operationId: BLOCKED_ID,
      payload: {
        ...buildMaximalPayload(BLOCKED_ID),
        sourceBasis: BLOCKED_BASIS,
        artifactProvenance: null,
        seedSha256: "sha256:seed-blocked",
      },
      at: "2026-09-07T11:01:00.000Z",
    }),
  );
  unwrap(
    await repo.commitReady({
      key: KEY,
      operationId: BLOCKED_ID,
      at: "2026-09-07T11:02:00.000Z",
    }),
  );
  unwrap(
    await repo.recordOutcome({
      key: KEY,
      operationId: BLOCKED_ID,
      expectedPhase: "ready",
      phase: "needs_reconciliation",
      failure: { code: "delivery_unknown", message: "send outcome unknown" },
      at: "2026-09-07T11:03:00.000Z",
    }),
  );
}

async function persistMaximalMappingFixture(
  fixture: CheckpointOperation,
): Promise<CheckpointOperation> {
  await seedBlockedOperation();

  unwrap(
    await repo.admitRecovery({
      key: KEY,
      requestId: fixture.id,
      sourceBasis: fixture.sourceBasis,
      priorBackendRef: fixture.protectedReferences.priorBackendRef,
      requestedAt: fixture.requestedAt,
      recoversOperationId: BLOCKED_ID,
    }),
  );
  unwrap(
    await repo.freezePayload({
      key: KEY,
      operationId: fixture.id,
      payload: buildMaximalPayload(fixture.id),
      at: "2026-09-07T12:05:00.000Z",
    }),
  );
  unwrap(
    await repo.commitReady({
      key: KEY,
      operationId: fixture.id,
      at: "2026-09-07T12:05:30.000Z",
    }),
  );
  if (fixture.delivery === null || fixture.acceptance === null) {
    throw new Error("the maximal fixture must carry delivery and acceptance");
  }
  unwrap(
    await repo.beginDelivery({
      key: KEY,
      operationId: fixture.id,
      binding: fixture.delivery,
      at: "2026-09-07T12:05:45.000Z",
    }),
  );
  const acceptedRef = fixture.protectedReferences.acceptedBackendRef;
  if (acceptedRef === null) {
    throw new Error("the maximal fixture must carry an accepted reference");
  }
  unwrap(
    await repo.recordAcceptance({
      key: KEY,
      operationId: fixture.id,
      acceptance: fixture.acceptance,
      acceptedBackendRef: acceptedRef,
    }),
  );
  if (fixture.failure === null || fixture.generationPassCount === null) {
    throw new Error("the maximal fixture must carry failure and pass count");
  }
  unwrap(
    await repo.recordOutcome({
      key: KEY,
      operationId: fixture.id,
      expectedPhase: "applied",
      phase: "needs_reconciliation",
      failure: fixture.failure,
      usage: fixture.usage,
      generationPassCount: fixture.generationPassCount,
      at: "2026-09-07T12:07:00.000Z",
    }),
  );
  unwrap(
    await repo.admitRecovery({
      key: KEY,
      requestId: SUCCESSOR_ID,
      sourceBasis: SUCCESSOR_BASIS,
      priorBackendRef: "prior-provider-session-successor",
      requestedAt: fixture.updatedAt,
      recoversOperationId: fixture.id,
    }),
  );
  // This explicit row fixture proves the reader's complete handoff mapping;
  // it does not claim that cancellation and accepted delivery coexist at runtime.
  db.prepare(
    "UPDATE conversation_checkpoint_operations SET handoff_json = ? WHERE id = ?",
  ).run(JSON.stringify(fixture.handoff), fixture.id);
  return fixture;
}

describe("conversation-checkpoints repo durability contract", () => {
  it("round-trips every persisted operation key path from the maximal mapping fixture", async () => {
    await assertRoundTripDurability({
      label: "conversation-checkpoint-operation",
      schema: checkpointOperationSchema,
      buildMaximalFixture: buildMaximalOperation,
      persist: persistMaximalMappingFixture,
      reload: (expected) => repo.getOperation(KEY, expected.id),
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted payload key path through the freeze", async () => {
    await assertRoundTripDurability({
      label: "conversation-checkpoint-payload",
      schema: checkpointPayloadSchema,
      buildMaximalFixture: () => buildMaximalPayload(MAXIMAL_ID),
      persist: async (fixture) => {
        unwrap(
          await repo.admitOperation({
            key: KEY,
            requestId: MAXIMAL_ID,
            sourceBasis: fixture.sourceBasis,
            priorBackendRef: "prior-provider-session-maximal",
            requestedAt: "2026-09-07T12:04:00.000Z",
          }),
        );
        unwrap(
          await repo.freezePayload({
            key: KEY,
            operationId: MAXIMAL_ID,
            payload: fixture,
            at: "2026-09-07T12:05:00.000Z",
          }),
        );
        return fixture;
      },
      reload: (expected) => repo.getPayload(KEY, expected.id),
      fieldPolicies: {},
    });
  });

  it("exposes focused transitions without a whole-row write API", () => {
    // A mapping fixture must not turn into a production whole-row write API.
    const surface = Object.keys(repo);
    expect(surface).not.toContain("upsert");
    expect(surface).not.toContain("save");
    expect(surface).not.toContain("update");
  });
});

describe("handoff persistence", () => {
  it("round-trips admitted capture intent and hides it from a different scope", async () => {
    const input = {
      key: KEY,
      requestId: MAXIMAL_ID,
      sourceBasis: MAXIMAL_BASIS,
      priorBackendRef: "prior",
      requestedAt: "now",
    };
    const handoff = pendingHandoff();
    unwrap(await repo.admitOperation({ ...input, handoff }));
    const reloaded = await createConversationCheckpointsRepo(
      db,
      createWriteQueue(),
      continuation,
    ).getOperation(KEY, MAXIMAL_ID);
    expect(reloaded?.handoff).toEqual(handoff);
    expect(
      await repo.getOperation({ ...KEY, projectPath: "/wrong" }, MAXIMAL_ID),
    ).toBeNull();
  });
});

describe("handoff admission validation", () => {
  it("refuses settled metadata at admission before any operation is durable", async () => {
    const result = await repo.admitOperation({
      key: KEY,
      requestId: MAXIMAL_ID,
      sourceBasis: MAXIMAL_BASIS,
      priorBackendRef: "prior",
      requestedAt: "now",
      handoff: capturedHandoff(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("invalid_handoff");
    expect(await repo.getOperation(KEY, MAXIMAL_ID)).toBeNull();
  });

  it("loads an ordinary pre-feature operation with no capture metadata", async () => {
    unwrap(
      await repo.admitOperation({
        key: KEY,
        requestId: MAXIMAL_ID,
        sourceBasis: MAXIMAL_BASIS,
        priorBackendRef: "prior",
        requestedAt: "now",
      }),
    );
    expect((await repo.getOperation(KEY, MAXIMAL_ID))?.handoff).toBeNull();
  });
});

describe("reachable capture durability contract", () => {
  it("persists candidate fields through settlement and keeps their audit metadata when the frozen seed omits the handoff", async () => {
    const pending = pendingHandoff();
    unwrap(
      await repo.admitOperation({
        key: KEY,
        requestId: MAXIMAL_ID,
        sourceBasis: MAXIMAL_BASIS,
        priorBackendRef: "source-continuity",
        requestedAt: pending.requestedAt,
        handoff: pending,
      }),
    );
    const captured = capturedHandoff();
    const startedAt = captured.startedAt;
    const settledAt = captured.settledAt;
    const finalSourceBasis = captured.finalSourceBasis;
    if (startedAt === null || settledAt === null || finalSourceBasis === null) {
      throw new Error(
        "Captured fixture requires timestamps and a final source",
      );
    }
    unwrap(
      await repo.beginCapture({
        key: KEY,
        operationId: MAXIMAL_ID,
        captureId: pending.captureId,
        expectedSourceBasis: MAXIMAL_BASIS,
        at: startedAt,
      }),
    );
    unwrap(
      await repo.settleCapture({
        key: KEY,
        operationId: MAXIMAL_ID,
        captureId: pending.captureId,
        expectedStage: "running",
        expectedSourceBasis: MAXIMAL_BASIS,
        at: settledAt,
        settlement: { kind: "result", handoff: captured },
      }),
    );
    const reloaded = createConversationCheckpointsRepo(
      db,
      createWriteQueue(),
      continuation,
    );
    expect((await reloaded.getOperation(KEY, MAXIMAL_ID))?.handoff).toEqual(
      captured,
    );
    const payload = {
      ...buildMaximalPayload(MAXIMAL_ID),
      sourceBasis: finalSourceBasis,
    };
    const at = "2026-09-07T12:05:00.000Z";
    unwrap(
      await repo.freezePayload({
        key: KEY,
        operationId: MAXIMAL_ID,
        payload,
        handoffDecision: "seed_budget",
        at,
      }),
    );
    expect((await reloaded.getOperation(KEY, MAXIMAL_ID))?.handoff).toEqual({
      ...captured,
      stage: "omitted",
      omissionReason: "seed_budget",
      finalizedAt: at,
      candidate: null,
      categoryCounts: {
        plan: 1,
        hypotheses: 1,
        failedApproaches: 1,
        blockers: 1,
        nextStep: 1,
      },
    });
    expect(await reloaded.getPayload(KEY, MAXIMAL_ID)).toEqual(payload);
  });
});
