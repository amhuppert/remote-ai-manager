/**
 * Restart rules over the real checkpoint repository and real conversation
 * rows: what hydration does to an operation a crash interrupted at each
 * durable boundary, and what it leaves alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { hydrateCheckpointAuthority } from "./checkpoint-restart";

const PROJECT = "/projects/restart";
const SESSION = "csm-restart";
const CONVERSATION = "conv-restart";
const PRIOR_REF = { backend: "claude", ref: "sdk-session-retired" } as const;
const BASIS = { capturedThroughSeq: 12, sourceHash: "sha256:restart" };

const SESSION_KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: PROJECT,
  sessionName: SESSION,
  conversationId: CONVERSATION,
};
const PROJECT_KEY: CheckpointScopeKey = {
  scope: "project",
  projectPath: PROJECT,
  sessionName: null,
  conversationId: CONVERSATION,
};

let fx: PersistenceFixture;
let repo: ReturnType<typeof createConversationCheckpointsRepo>;
let log: CapturingLogger;
let clock = 0;
const now = () => `2026-09-08T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(async () => {
  fx = createPersistenceFixture();
  log = createCapturingLogger();
  clock = 0;
  repo = createConversationCheckpointsRepo(
    fx.db,
    createWriteQueue(),
    fx.store.checkpointContinuation,
  );
  fx.seedProject(PROJECT);
  fx.seedSession(PROJECT, SESSION);
  await fx.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({
      id: CONVERSATION,
      promptCount: 3,
      transcriptPath: "/transcripts/restart.jsonl",
      backendRef: PRIOR_REF,
    }),
  );
  await fx.seedProjectConversation(
    PROJECT,
    makeConversationState({
      id: CONVERSATION,
      promptCount: 3,
      transcriptPath: "/transcripts/restart-project.jsonl",
      backendRef: PRIOR_REF,
    }),
  );
});

afterEach(() => {
  fx.close();
});

function infra() {
  return { repo, now, log };
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; refusal: { code: string } },
): T {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  return result.value;
}

function payload(operationId: string): CheckpointPayload {
  const seedText = "## Working state\nfinish the restart rules\n";
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
    sections: { workingState: {}, recentDialogue: [], recoveryMap: {} },
    seedText,
    seedSha256: "sha256:seed-restart",
    sectionBytes: {
      total: Buffer.byteLength(seedText, "utf8"),
      workingState: 10,
      recentDialogue: 0,
      recoveryFraming: 0,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: now(),
  };
}

async function building(key: CheckpointScopeKey, requestId = "req-1") {
  return unwrap(
    await repo.admitOperation({
      key,
      requestId,
      sourceBasis: BASIS,
      priorBackendRef: PRIOR_REF.ref,
      requestedAt: now(),
    }),
  ).operation;
}

async function retiring(key: CheckpointScopeKey, requestId = "req-1") {
  const admitted = await building(key, requestId);
  return unwrap(
    await repo.freezePayload({
      key,
      operationId: admitted.id,
      payload: payload(admitted.id),
      at: now(),
    }),
  );
}

async function ready(key: CheckpointScopeKey, requestId = "req-1") {
  const frozen = await retiring(key, requestId);
  return unwrap(
    await repo.commitReady({ key, operationId: frozen.id, at: now() }),
  );
}

async function delivering(key: CheckpointScopeKey, requestId = "req-1") {
  const readied = await ready(key, requestId);
  return unwrap(
    await repo.beginDelivery({
      key,
      operationId: readied.id,
      binding: {
        attemptId: "attempt-crashed",
        inputFingerprint: "sha256:input",
        submittedInputFingerprint: "sha256:input",
        queuedAttemptId: "queued-attempt-1",
        queuedMessageId: "queued-message-1",
      },
      at: now(),
    }),
  );
}

async function rowRef(key: CheckpointScopeKey) {
  const store = fx.recreateStore();
  const row =
    key.scope === "project"
      ? await store.getProjectConversation(key.projectPath, key.conversationId)
      : await store.getConversation(
          key.projectPath,
          key.sessionName ?? "",
          key.conversationId,
        );
  return row?.backendRef ?? null;
}

describe("hydrateCheckpointAuthority", () => {
  it("reports nothing when no operation owns the conversation", async () => {
    const hydration = await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(hydration).toMatchObject({
      projection: null,
      outcome: { kind: "none" },
      continuationRetired: false,
    });
    expect(hydration.state.active).toBeNull();
  });

  it.each([
    ["session", SESSION_KEY],
    ["project", PROJECT_KEY],
  ] as const)(
    "fails an interrupted %s build before any drain and keeps the prior reference",
    async (_scope, key) => {
      const admitted = await building(key);
      const hydration = await hydrateCheckpointAuthority(key, infra());
      expect(hydration.outcome).toMatchObject({
        kind: "build_interrupted",
        operation: {
          id: admitted.id,
          phase: "failed",
          failure: { code: "interrupted" },
        },
      });
      expect(hydration.projection).toBeNull();
      expect(hydration.continuationRetired).toBe(false);
      expect(await rowRef(key)).toEqual(PRIOR_REF);
      expect((await repo.getOperation(key, admitted.id))?.phase).toBe("failed");
      expect(log.entries).toContainEqual(
        expect.objectContaining({
          message: "checkpoint.restart.build_interrupted",
          fields: expect.objectContaining({ operationId: admitted.id }),
        }),
      );
    },
  );

  it.each([
    ["session", SESSION_KEY],
    ["project", PROJECT_KEY],
  ] as const)(
    "completes an interrupted %s retirement from the saved payload and clears the reference",
    async (_scope, key) => {
      const frozen = await retiring(key);
      const hydration = await hydrateCheckpointAuthority(key, infra());
      expect(hydration.outcome).toMatchObject({
        kind: "retirement_completed",
        operation: { id: frozen.id, phase: "ready" },
      });
      expect(hydration.projection).toEqual({
        operationId: frozen.id,
        phase: "ready",
      });
      expect(hydration.continuationRetired).toBe(true);
      expect(await rowRef(key)).toBeNull();
      expect(await repo.getPayload(key, frozen.id)).not.toBeNull();
      expect(
        (await repo.getOperation(key, frozen.id))?.protectedReferences
          .priorBackendRef,
      ).toBe(PRIOR_REF.ref);
    },
  );

  it("keeps a ready checkpoint ready without writing", async () => {
    const readied = await ready(SESSION_KEY);
    const before = await repo.getOperation(SESSION_KEY, readied.id);
    const hydration = await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(hydration.outcome).toMatchObject({
      kind: "ready",
      operation: { id: readied.id, phase: "ready" },
    });
    expect(hydration.projection).toEqual({
      operationId: readied.id,
      phase: "ready",
    });
    expect(hydration.continuationRetired).toBe(true);
    expect(await repo.getOperation(SESSION_KEY, readied.id)).toEqual(before);
    expect(await rowRef(SESSION_KEY)).toBeNull();
  });

  it("holds an attempted delivery for reconciliation without inferring acceptance", async () => {
    const attempted = await delivering(SESSION_KEY);
    const hydration = await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(hydration.outcome).toMatchObject({
      kind: "delivery_unresolved",
      operation: {
        id: attempted.id,
        phase: "needs_reconciliation",
        lastStablePhase: "delivering",
        failure: { code: "delivery_unresolved" },
        acceptance: null,
        delivery: { attemptId: "attempt-crashed" },
      },
    });
    expect(hydration.projection).toEqual({
      operationId: attempted.id,
      phase: "needs_reconciliation",
    });
    expect(hydration.continuationRetired).toBe(true);
    expect(await rowRef(SESSION_KEY)).toBeNull();
    // The provider reference the checkpoint retired is never handed back.
    expect(
      (await repo.getOperation(SESSION_KEY, attempted.id))?.protectedReferences,
    ).toEqual({ priorBackendRef: PRIOR_REF.ref, acceptedBackendRef: null });
  });

  it("keeps a reconciliation hold exactly as it is", async () => {
    const attempted = await delivering(SESSION_KEY);
    await hydrateCheckpointAuthority(SESSION_KEY, infra());
    const held = await repo.getOperation(SESSION_KEY, attempted.id);
    const again = await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(again.outcome).toMatchObject({
      kind: "held",
      operation: { id: attempted.id, phase: "needs_reconciliation" },
    });
    expect(await repo.getOperation(SESSION_KEY, attempted.id)).toEqual(held);
  });

  it("holds a retirement whose close failed with the reference still standing", async () => {
    const frozen = await retiring(SESSION_KEY);
    unwrap(
      await repo.recordOutcome({
        key: SESSION_KEY,
        operationId: frozen.id,
        expectedPhase: "retiring",
        phase: "needs_reconciliation",
        failure: { code: "runtime_close_failed", message: "close hung" },
        at: now(),
      }),
    );
    const hydration = await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(hydration.outcome).toMatchObject({
      kind: "held",
      operation: { id: frozen.id, lastStablePhase: "retiring" },
    });
    expect(hydration.continuationRetired).toBe(true);
    expect(await rowRef(SESSION_KEY)).toEqual(PRIOR_REF);
  });

  it("treats an accepted continuation as retired authority even with no active operation", async () => {
    const attempted = await delivering(SESSION_KEY);
    unwrap(
      await repo.recordAcceptance({
        key: SESSION_KEY,
        operationId: attempted.id,
        acceptance: {
          attemptId: "attempt-crashed",
          seedHash: "sha256:seed-restart",
          acceptedAt: now(),
        },
        acceptedBackendRef: "sdk-session-fresh",
      }),
    );
    const hydration = await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(hydration.outcome).toEqual({ kind: "none" });
    expect(hydration.projection).toBeNull();
    expect(hydration.continuationRetired).toBe(true);
    expect(hydration.state.latestAccepted?.operationId).toBe(attempted.id);
  });

  it("scopes every write: a session operation is untouched by project hydration", async () => {
    const admitted = await building(SESSION_KEY);
    const hydration = await hydrateCheckpointAuthority(PROJECT_KEY, infra());
    expect(hydration.outcome).toEqual({ kind: "none" });
    expect((await repo.getOperation(SESSION_KEY, admitted.id))?.phase).toBe(
      "building",
    );
  });

  it("never logs a provider reference", async () => {
    await retiring(SESSION_KEY);
    await hydrateCheckpointAuthority(SESSION_KEY, infra());
    expect(log.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.entries)).not.toContain(PRIOR_REF.ref);
  });
});
