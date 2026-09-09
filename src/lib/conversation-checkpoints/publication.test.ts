import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishOutcome } from "@/lib/events/publication";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { ConversationState } from "@/lib/conversations/schemas";

import type { CheckpointConversationGateway } from "./continuation";
import {
  conversationCheckpointUpdatedEventSchema,
  type ConversationCheckpointUpdatedEvent,
} from "./events";
import { withCheckpointPublication } from "./publication";
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
const ACCEPTED_REF = "fresh-provider-session-71ac";
const SEED_TEXT = "## Working state\nShip the widget before the demo.\n";

function stubContinuation(): CheckpointConversationGateway {
  return {
    exists: () => true,
    find: (): ConversationState | null => null,
    clearBackendRef: () => true,
  };
}

/**
 * A publish double that records, at publish time, what the database already
 * holds for the operation the frame describes. An event emitted before its
 * transaction committed would record the previous phase, so the ordering
 * assertion is a real read of durable state rather than a call-order proxy.
 */
interface RecordedFrame {
  event: ConversationCheckpointUpdatedEvent;
  durablePhase: string | null;
  durableUpdatedAt: string | null;
}

let db: Db;
let base: ConversationCheckpointsRepo;
let repo: ConversationCheckpointsRepo;
let frames: RecordedFrame[];
let logger: ReturnType<typeof createCapturingLogger>;
let publishOutcome: () => PublishOutcome;

function readRow(id: string): { phase: string; updated_at: string } | null {
  const row = db
    .prepare(
      `SELECT phase, updated_at FROM conversation_checkpoint_operations WHERE id = ?`,
    )
    .get(id);
  return (row as { phase: string; updated_at: string } | undefined) ?? null;
}

function checkpointFrames(): ConversationCheckpointUpdatedEvent[] {
  return frames.map((frame) => frame.event);
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  frames = [];
  logger = createCapturingLogger();
  publishOutcome = () => ({ delivered: true });
  base = createConversationCheckpointsRepo(
    db,
    createWriteQueue(),
    stubContinuation(),
  );
  repo = withCheckpointPublication(base, {
    projectName: (projectPath) => projectPath.split("/").pop() ?? projectPath,
    publish: (event: SSEEvent): PublishOutcome => {
      if (event.type === "conversation-checkpoint-updated") {
        const row = readRow(event.receipt.operationId);
        frames.push({
          event,
          durablePhase: row?.phase ?? null,
          durableUpdatedAt: row?.updated_at ?? null,
        });
      }
      return publishOutcome();
    },
    log: logger,
  });
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

function buildPayload(operationId: string): CheckpointPayload {
  return {
    id: operationId,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: BASIS,
    artifactProvenance: {
      artifactId: "artifact-9",
      artifactSourceHash: "sha256:artifact-source",
    },
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
    seedText: SEED_TEXT,
    seedSha256: "sha256:seed-a",
    sectionBytes: {
      total: Buffer.byteLength(SEED_TEXT, "utf8"),
      workingState: 20,
      recentDialogue: 8,
      recoveryFraming: 6,
    },
    omissions: [{ category: "evidence_map_entries", detail: "3 dropped" }],
    generationPassCount: 3,
    createdAt: "2026-09-07T12:00:00.000Z",
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

async function driveToApplied(key: CheckpointScopeKey, requestId: string) {
  const operation = await admit(key, requestId);
  unwrap(
    await repo.freezePayload({
      key,
      operationId: operation.id,
      payload: buildPayload(operation.id),
      usage: {
        inputTokens: 31_500,
        cachedInputTokens: 118_200,
        outputTokens: 2_100,
        costUsd: 0.87,
        durationMs: 12_400,
      },
      at: "2026-09-07T12:00:00.000Z",
    }),
  );
  unwrap(
    await repo.commitReady({
      key,
      operationId: operation.id,
      at: "2026-09-07T12:00:05.000Z",
    }),
  );
  unwrap(
    await repo.beginDelivery({
      key,
      operationId: operation.id,
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
    await repo.recordAcceptance({
      key,
      operationId: operation.id,
      acceptance: {
        attemptId: "attempt-1",
        seedHash: "sha256:seed-a",
        acceptedAt: "2026-09-07T12:01:30.000Z",
      },
      acceptedBackendRef: ACCEPTED_REF,
    }),
  );
  return operation;
}

describe("checkpoint publication", () => {
  it("publishes one frame per durable phase change across the lifecycle", async () => {
    await driveToApplied(SESSION_KEY, "11111111-1111-4111-8111-111111111111");

    expect(checkpointFrames().map((event) => event.receipt.phase)).toEqual([
      "building",
      "retiring",
      "ready",
      "delivering",
      "applied",
    ]);
  });

  it("publishes only after the phase change is durable", async () => {
    await driveToApplied(SESSION_KEY, "11111111-1111-4111-8111-111111111111");

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.durablePhase).toBe(frame.event.receipt.phase);
      expect(frame.durableUpdatedAt).toBe(frame.event.receipt.updatedAt);
    }
  });

  it("carries the receipt metadata a client needs and nothing else", async () => {
    await driveToApplied(SESSION_KEY, "11111111-1111-4111-8111-111111111111");

    const applied = checkpointFrames().at(-1);
    expect(applied).toBeDefined();
    const parsed = conversationCheckpointUpdatedEventSchema.safeParse(applied);
    expect(parsed.success).toBe(true);
    expect(applied?.receipt).toMatchObject({
      mechanism: "cc_checkpoint",
      phase: "applied",
      ordinal: 1,
      generationPassCount: 3,
      boundary: BASIS,
      hasAcceptedContinuation: true,
    });
    expect(applied?.receipt.checkpoint).toMatchObject({
      seedSha256: "sha256:seed-a",
      sectionBytes: { total: Buffer.byteLength(SEED_TEXT, "utf8") },
      omissions: [{ category: "evidence_map_entries", detail: "3 dropped" }],
      versions: {
        generatorVersion: "gen-1",
        builderVersion: "builder-1",
        normalizerVersion: "norm-1",
      },
      artifactProvenance: {
        artifactId: "artifact-9",
        artifactSourceHash: "sha256:artifact-source",
      },
    });
    expect(applied?.receipt.compactionUsage).toEqual({
      inputTokens: 31_500,
      cachedInputTokens: 118_200,
      outputTokens: 2_100,
      costUsd: 0.87,
      durationMs: 12_400,
    });
  });

  it("never puts seed text, a provider reference or a project path on the wire", async () => {
    await driveToApplied(SESSION_KEY, "11111111-1111-4111-8111-111111111111");

    const serialized = JSON.stringify(checkpointFrames());
    expect(serialized).not.toContain(SEED_TEXT);
    expect(serialized).not.toContain("Ship the widget before the demo");
    expect(serialized).not.toContain(PRIOR_REF);
    expect(serialized).not.toContain(ACCEPTED_REF);
    expect(serialized).not.toContain("/projects/alpha");
  });

  it("names the scoped identity of a session conversation", async () => {
    await admit(SESSION_KEY, "11111111-1111-4111-8111-111111111111");

    expect(checkpointFrames()[0]).toMatchObject({
      type: "conversation-checkpoint-updated",
      scope: "session",
      projectName: "alpha",
      sessionName: "csm-alpha",
      conversationId: "conv-session",
    });
  });

  it("names a project conversation without any session key at all", async () => {
    await admit(PROJECT_KEY, "22222222-2222-4222-8222-222222222222");

    const frame = checkpointFrames()[0];
    expect(frame).toMatchObject({
      scope: "project",
      projectName: "alpha",
      conversationId: "conv-project",
    });
    expect(Object.keys(frame ?? {})).not.toContain("sessionName");
  });

  it("publishes nothing when the write was refused", async () => {
    await admit(SESSION_KEY, "11111111-1111-4111-8111-111111111111");
    frames = [];

    const refused = await repo.admitOperation({
      key: SESSION_KEY,
      requestId: "33333333-3333-4333-8333-333333333333",
      sourceBasis: BASIS,
      priorBackendRef: PRIOR_REF,
      requestedAt: "2026-09-07T11:59:30.000Z",
    });

    expect(refused.ok).toBe(false);
    expect(frames).toEqual([]);
  });

  it("publishes nothing when a request id is reused, because nothing changed", async () => {
    await admit(SESSION_KEY, "11111111-1111-4111-8111-111111111111");
    frames = [];

    const reused = unwrap(
      await repo.admitOperation({
        key: SESSION_KEY,
        requestId: "11111111-1111-4111-8111-111111111111",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T11:59:00.000Z",
      }),
    );

    expect(reused.outcome).toBe("reused");
    expect(frames).toEqual([]);
  });

  it("publishes the superseded gate alongside the recovery it admitted", async () => {
    const blocked = await admit(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );
    unwrap(
      await repo.freezePayload({
        key: SESSION_KEY,
        operationId: blocked.id,
        payload: buildPayload(blocked.id),
        at: "2026-09-07T12:01:00.000Z",
      }),
    );
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: blocked.id,
        expectedPhase: "retiring",
        phase: "needs_reconciliation",
        failure: { code: "close_failed", message: "runtime close failed" },
        at: "2026-09-07T12:02:00.000Z",
      }),
    );
    frames = [];

    unwrap(
      await repo.admitRecovery({
        key: SESSION_KEY,
        requestId: "44444444-4444-4444-8444-444444444444",
        sourceBasis: BASIS,
        priorBackendRef: PRIOR_REF,
        requestedAt: "2026-09-07T12:03:00.000Z",
        recoversOperationId: blocked.id,
      }),
    );

    const published = checkpointFrames().map((event) => ({
      operationId: event.receipt.operationId,
      supersededBy: event.receipt.supersededByOperationId,
    }));
    expect(published).toEqual([
      {
        operationId: "44444444-4444-4444-8444-444444444444",
        supersededBy: null,
      },
      {
        operationId: blocked.id,
        supersededBy: "44444444-4444-4444-8444-444444444444",
      },
    ]);
  });

  it("keeps the mutation successful when publication fails", async () => {
    publishOutcome = () => ({
      delivered: false,
      error: new Error("transport closed"),
    });

    const operation = await admit(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(await base.getOperation(SESSION_KEY, operation.id)).not.toBeNull();
    expect(
      logger.entries.some(
        (entry) => entry.message === "checkpoint.event.publish_failed",
      ),
    ).toBe(true);
  });

  /**
   * The publisher is shared infrastructure whose default failure field is the
   * exception message. A transport that names the provider session it lost, or
   * quotes the frame it refused, would put that in a `checkpoint.*` log through
   * a helper this module does not own — so the decorator projects the failure
   * itself. Both failure shapes the helper reports are covered: a throw and a
   * `delivered: false` outcome.
   */
  it.each([
    [
      "a throwing publisher",
      (): PublishOutcome => {
        throw new Error(
          `wire refused seed "${SEED_TEXT}" for session ${PRIOR_REF}`,
        );
      },
    ],
    [
      "a reported failed delivery",
      (): PublishOutcome => ({
        delivered: false,
        error: new Error(
          `wire refused seed "${SEED_TEXT}" for session ${PRIOR_REF}`,
        ),
      }),
    ],
  ])("reports %s structurally, without the exception text", async (_, fail) => {
    publishOutcome = fail;

    const operation = await admit(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(await base.getOperation(SESSION_KEY, operation.id)).not.toBeNull();
    const entry = logger.entries.find(
      (candidate) => candidate.message === "checkpoint.event.publish_failed",
    );
    expect(entry?.fields).toMatchObject({
      conversationId: SESSION_KEY.conversationId,
      operationId: operation.id,
      phase: "building",
      errorKind: "Error",
      errorCode: null,
      errorChars: `wire refused seed "${SEED_TEXT}" for session ${PRIOR_REF}`
        .length,
    });
    const rendered = JSON.stringify(logger.allFieldValues());
    expect(rendered).not.toContain("Ship the widget");
    expect(rendered).not.toContain(PRIOR_REF);
  });

  it("leaves GET authoritative after a client misses every frame", async () => {
    const operation = await driveToApplied(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );
    const lastFrame = checkpointFrames().at(-1);

    // A reconnecting client reads the operation instead of replaying frames.
    const authoritative = await repo.getReceipt(SESSION_KEY, operation.id);
    expect(authoritative).toEqual(lastFrame?.receipt);
  });

  /**
   * The read that builds the frame runs against a row the checkpoint wrote, so
   * a failure here surfaces exactly what storage refused. R9.2 keeps that out
   * of the log: the class and the platform code identify the fault, and the
   * elided length says detail existed.
   */
  it("reports a failed receipt read structurally, without the exception text", async () => {
    const operation = await admit(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );
    const thrown = Object.assign(
      new Error(`row rejected: seed body "${SEED_TEXT}" from ${PRIOR_REF}`),
      { code: "SQLITE_CORRUPT" },
    );
    const failing = withCheckpointPublication(
      {
        ...base,
        getReceipt: () => Promise.reject(thrown),
      },
      {
        projectName: (projectPath) =>
          projectPath.split("/").pop() ?? projectPath,
        publish: () => ({ delivered: true }),
        log: logger,
      },
    );

    const result = await failing.recordOutcome({
      key: SESSION_KEY,
      operationId: operation.id,
      expectedPhase: "building",
      phase: "failed",
      failure: { code: "build_error", message: "the build failed" },
      at: "2026-02-01T00:00:05.000Z",
    });

    expect(result.ok).toBe(true);
    const entry = logger.entries.find(
      (candidate) =>
        candidate.message === "checkpoint.event.receipt_read_failed",
    );
    expect(entry?.fields).toMatchObject({
      conversationId: SESSION_KEY.conversationId,
      operationId: operation.id,
      errorKind: "Error",
      errorCode: "SQLITE_CORRUPT",
      errorChars: thrown.message.length,
    });
    const rendered = JSON.stringify(logger.allFieldValues());
    expect(rendered).not.toContain("Ship the widget");
    expect(rendered).not.toContain(PRIOR_REF);
  });

  it("wraps the composed production repository", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./service-factory.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("withCheckpointPublication");
  });
});
