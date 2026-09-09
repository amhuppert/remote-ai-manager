/**
 * Atomic readiness: the phase change and the conversation's provider-reference
 * clear are one commit.
 *
 * These tests use real conversation rows through the real conversation
 * repositories rather than the recording double `repo.test.ts` injects, because
 * the claim under test is precisely that a write to ANOTHER table lands — or
 * rolls back — with the checkpoint transition.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createConversationCheckpointsRepo,
  type CheckpointResult,
  type ConversationCheckpointsRepo,
} from "./repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "./schemas";

const PROJECT = "/projects/readiness";
const SESSION = "csm-readiness";
const SESSION_CONVERSATION = "conv-session-readiness";
const PROJECT_CONVERSATION = "conv-project-readiness";

const SESSION_KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: PROJECT,
  sessionName: SESSION,
  conversationId: SESSION_CONVERSATION,
};
const PROJECT_KEY: CheckpointScopeKey = {
  scope: "project",
  projectPath: PROJECT,
  sessionName: null,
  conversationId: PROJECT_CONVERSATION,
};

const BASIS = { capturedThroughSeq: 310, sourceHash: "sha256:readiness" };
const AT = "2026-09-02T00:00:00.000Z";

let fx: PersistenceFixture;
let repo: ConversationCheckpointsRepo;

beforeEach(() => {
  fx = createPersistenceFixture();
  // The production seam: the writer the shared store composes over its own
  // repositories, not a private pair built here.
  repo = createConversationCheckpointsRepo(
    fx.db,
    createWriteQueue(),
    fx.store.checkpointContinuation,
  );
});

afterEach(() => {
  fx.close();
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

function withBackendRef(id: string, ref: string): ConversationState {
  return makeConversationState({
    id,
    agentBackend: "claude",
    backendRef: { backend: "claude", ref },
  });
}

function storedBackendRef(table: string, id: string): string | null {
  return fx.db
    .prepare(`SELECT backend_ref FROM ${table} WHERE id = ?`)
    .pluck()
    .get(id) as string | null;
}

function payload(id: string): CheckpointPayload {
  const seedText = "## Working state\nObjective: prove readiness is atomic.\n";
  return {
    id,
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
      workingState: { objective: "Prove readiness is atomic" },
      recentDialogue: [{ role: "user", text: "keep going" }],
      recoveryMap: { commands: ["cctl conversation read conv-session"] },
    },
    seedText,
    seedSha256: "sha256:seed-readiness",
    sectionBytes: {
      total: Buffer.byteLength(seedText, "utf8"),
      workingState: 25,
      recentDialogue: 12,
      recoveryFraming: 18,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: AT,
  };
}

/** Admit and freeze so the operation is `retiring` — readiness's only entry. */
async function retiringOperation(
  key: CheckpointScopeKey,
  operationId: string,
  priorBackendRef: string,
): Promise<void> {
  unwrap(
    await repo.admitOperation({
      key,
      requestId: operationId,
      sourceBasis: BASIS,
      priorBackendRef,
      requestedAt: AT,
    }),
  );
  unwrap(
    await repo.freezePayload({
      key,
      operationId,
      payload: payload(operationId),
      at: AT,
    }),
  );
}

async function seedBothScopes(): Promise<void> {
  fx.seedProject(PROJECT);
  fx.seedSession(PROJECT, SESSION);
  await fx.seedConversation(
    PROJECT,
    SESSION,
    withBackendRef(SESSION_CONVERSATION, "sdk-session-live"),
  );
  await fx.seedProjectConversation(
    PROJECT,
    withBackendRef(PROJECT_CONVERSATION, "sdk-project-live"),
  );
}

describe("commitReady clears the retired continuation", () => {
  it("clears the session conversation's backend reference as it publishes readiness", async () => {
    await seedBothScopes();
    await retiringOperation(SESSION_KEY, "op-session", "sdk-session-live");

    const operation = unwrap(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: "op-session",
        at: AT,
      }),
    );

    expect(operation.phase).toBe("ready");
    expect(storedBackendRef("conversations", SESSION_CONVERSATION)).toBeNull();
  });

  it("clears only the addressed scope when both scopes hold a live reference", async () => {
    await seedBothScopes();
    await retiringOperation(PROJECT_KEY, "op-project", "sdk-project-live");

    unwrap(
      await repo.commitReady({
        key: PROJECT_KEY,
        operationId: "op-project",
        at: AT,
      }),
    );

    expect(
      storedBackendRef("project_conversations", PROJECT_CONVERSATION),
    ).toBeNull();
    expect(
      storedBackendRef("conversations", SESSION_CONVERSATION),
    ).not.toBeNull();
  });

  it("leaves a sibling conversation in the same session untouched", async () => {
    await seedBothScopes();
    await fx.seedConversation(
      PROJECT,
      SESSION,
      withBackendRef("conv-sibling", "sdk-sibling-live"),
    );
    await retiringOperation(SESSION_KEY, "op-session", "sdk-session-live");

    unwrap(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: "op-session",
        at: AT,
      }),
    );

    expect(storedBackendRef("conversations", "conv-sibling")).not.toBeNull();
  });

  it("preserves the reference when the operation is not retiring", async () => {
    await seedBothScopes();
    unwrap(
      await repo.admitOperation({
        key: SESSION_KEY,
        requestId: "op-building",
        sourceBasis: BASIS,
        priorBackendRef: "sdk-session-live",
        requestedAt: AT,
      }),
    );

    const refusal = refusalOf(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: "op-building",
        at: AT,
      }),
    );

    expect(refusal.code).toBe("illegal_transition");
    expect(
      storedBackendRef("conversations", SESSION_CONVERSATION),
    ).not.toBeNull();
  });

  it("carries the checkpoint obligation away when the target conversation is deleted mid-operation", async () => {
    // Admission now checks the target, so the only way readiness meets a
    // missing conversation is a deletion landing INSIDE the operation. Against
    // real rows that deletion also fires the cleanup trigger, so there is no
    // orphan obligation left to publish and readiness has nothing to commit.
    // (The clear-matched-no-row rollback itself is proved over the injected
    // seam in repo.test.ts, where that state is reachable.)
    await seedBothScopes();
    await retiringOperation(SESSION_KEY, "op-doomed", "sdk-session-live");

    await fx.store.mutateSession(
      PROJECT,
      SESSION,
      "deleteConversation",
      (session) => {
        session.conversations = session.conversations.filter(
          (candidate) => candidate.id !== SESSION_KEY.conversationId,
        );
      },
    );

    const refusal = refusalOf(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: "op-doomed",
        at: AT,
      }),
    );

    expect(refusal.code).toBe("checkpoint_not_found");
    expect(await repo.getOperation(SESSION_KEY, "op-doomed")).toBeNull();
    // The project-scoped sibling keeps its live reference throughout.
    expect(
      storedBackendRef("project_conversations", PROJECT_CONVERSATION),
    ).toContain("sdk-project-live");
  });

  it("keeps the frozen payload readable after readiness", async () => {
    await seedBothScopes();
    await retiringOperation(SESSION_KEY, "op-session", "sdk-session-live");

    unwrap(
      await repo.commitReady({
        key: SESSION_KEY,
        operationId: "op-session",
        at: AT,
      }),
    );

    expect((await repo.getPayload(SESSION_KEY, "op-session"))?.seedSha256).toBe(
      "sha256:seed-readiness",
    );
  });
});
