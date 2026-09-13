import { createCheckpointRouteHandlers } from "./route-handlers";
import {
  admitCheckpointForkSubmission,
  assertCheckpointForkBackend,
} from "./fork-submission";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConversation } from "@/lib/conversations/build-conversation";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createConversationCheckpointsRepo,
  type ConversationCheckpointsRepo,
  type CreateCheckpointForkInput,
} from "./repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "./schemas";
import { createCheckpointForkService } from "./fork-service";
import { NO_OP_SNAPSHOT_FIXTURE } from "@/lib/conversations/testing/profile-snapshot-fixtures";

const PROJECT = "/projects/checkpoint-fork";
const SESSION = "fork-session";
const AT = "2026-09-12T15:00:00.000Z";
const SEED = "Historical constraint: use resource Q-137. The retry failed.\n";
let fx: PersistenceFixture;
let repo: ConversationCheckpointsRepo;

beforeEach(() => {
  fx = createPersistenceFixture();
  fx.seedProject(PROJECT);
  fx.seedSession(PROJECT, SESSION);
  repo = createConversationCheckpointsRepo(
    fx.db,
    createWriteQueue(),
    fx.store.checkpointContinuation,
  );
});
afterEach(() => fx.close());

async function source(
  scope: "session" | "project",
): Promise<CreateCheckpointForkInput> {
  const sourceKey: CheckpointScopeKey = {
    scope,
    projectPath: PROJECT,
    sessionName: scope === "session" ? SESSION : null,
    conversationId: "source",
  };
  const conversation = buildConversation({
    id: "source",
    scope,
    name: "Source",
    createdAt: AT,
    agentBackend: "claude",
  });
  if (scope === "session")
    await fx.seedConversation(PROJECT, SESSION, conversation);
  else await fx.seedProjectConversation(PROJECT, conversation);
  const payload: CheckpointPayload = {
    id: "source-checkpoint",
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: { capturedThroughSeq: 42, sourceHash: "source-hash" },
    artifactProvenance: null,
    versions: {
      generatorVersion: "1",
      builderVersion: "1",
      normalizerVersion: "1",
    },
    modelSelection: { modelId: "claude-opus-5", parameters: {} },
    sections: {
      workingState: { constraint: "Q-137" },
      recentDialogue: [],
      recoveryMap: {},
    },
    seedText: SEED,
    seedSha256: createHash("sha256").update(SEED).digest("hex"),
    sectionBytes: {
      total: Buffer.byteLength(SEED),
      workingState: Buffer.byteLength(SEED),
      recentDialogue: 0,
      recoveryFraming: 0,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: AT,
  };
  expect(
    (
      await repo.admitOperation({
        key: sourceKey,
        requestId: payload.id,
        sourceBasis: payload.sourceBasis,
        priorBackendRef: null,
        requestedAt: AT,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.freezePayload({
        key: sourceKey,
        operationId: payload.id,
        payload,
        at: AT,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.commitReady({
        key: sourceKey,
        operationId: payload.id,
        at: AT,
      })
    ).ok,
  ).toBe(true);
  const target = buildConversation({
    id: "fork-request",
    scope,
    name: "Next phase",
    createdAt: AT,
    agentBackend: "codex",
    pendingPromptText: "Implement Q-137",
  });
  return {
    sourceKey,
    sourceOperationId: payload.id,
    key: { ...sourceKey, conversationId: target.id },
    conversation: target,
    origin: {
      source:
        scope === "session"
          ? {
              scope,
              projectName: "checkpoint-fork",
              sessionName: SESSION,
              conversationId: "source",
            }
          : { scope, projectName: "checkpoint-fork", conversationId: "source" },
      evidenceSource:
        scope === "session"
          ? {
              scope,
              projectName: "checkpoint-fork",
              sessionName: SESSION,
              conversationId: "source",
            }
          : { scope, projectName: "checkpoint-fork", conversationId: "source" },
      sourceOperationId: payload.id,
      ordinal: 1,
      schemaVersion: payload.schemaVersion,
      seedSha256: payload.seedSha256,
      capturedThroughSeq: 42,
      operationId: target.id,
      requestHash: "request-hash",
      relatedWork: { kind: "ticket", ticketNumber: 131 },
      initialSelection: {
        backend: "codex",
        modelSelection: { modelId: "gpt-6-astra", parameters: {} },
      },
    },
  };
}

describe.each(["session", "project"] as const)(
  "checkpoint fork persistence at %s scope",
  (scope) => {
    it("creates an admitted cross-backend fork through the service and preserves the editable task and model choice", async () => {
      const input = await source(scope);
      const service = createCheckpointForkService({
        repo: () => repo,
        load: async (_projectPath, target) =>
          fx.store.checkpointContinuation.find({
            ...input.sourceKey,
            conversationId: target.conversationId,
          }),
        admit: async (_projectPath, _backend, selection) => selection,
        resolveWork: async () => {},
        profile: async () => NO_OP_SNAPSHOT_FIXTURE,
        publish: () => {},
        now: () => AT,
      });
      const result = await service.create({
        projectPath: PROJECT,
        source: input.origin.source,
        operationId: input.sourceOperationId,
        request: {
          requestId: "34614a95-aac2-4314-bc69-cb889cfd207c",
          name: "Next",
          task: "Implement Q-137",
          backend: "codex",
          modelSelection: {
            modelId: "gpt-6-astra",
            parameters: { reasoning: "high" },
          },
          relatedWork: { kind: "ticket", ticketNumber: 131 },
        },
      });
      expect(result.conversation).toMatchObject({
        promptCount: 0,
        agentBackend: "codex",
        pendingPromptText: "Implement Q-137",
        backendRef: null,
      });
      expect(result.conversation.checkpointFork).toMatchObject({
        source: input.origin.source,
        initialSelection: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-6-astra",
            parameters: { reasoning: "high" },
          },
        },
      });
      expect(
        await repo.getPayload(
          { ...input.key, conversationId: result.conversation.id },
          result.operation.id,
        ),
      ).toMatchObject({ seedText: SEED });
    });

    it("recovers an already-created fork after its source disappears and current model admission changes", async () => {
      const input = await source(scope);
      let refuseAdmission = false;
      const service = createCheckpointForkService({
        repo: () => repo,
        load: async (_path, target) =>
          fx.store.checkpointContinuation.find({
            ...input.sourceKey,
            conversationId: target.conversationId,
          }),
        admit: async (_path, _backend, selection) => {
          if (refuseAdmission) throw new Error("Model removed");
          return selection;
        },
        resolveWork: async () => {},
        profile: async () => NO_OP_SNAPSHOT_FIXTURE,
        publish: () => {},
        now: () => AT,
      });
      const request = {
        requestId: "34614a95-aac2-4314-bc69-cb889cfd207c",
        name: "Next",
        task: "Implement Q-137",
        backend: "codex" as const,
        modelSelection: { modelId: "gpt-6-astra", parameters: {} },
        relatedWork: { kind: "ticket" as const, ticketNumber: 131 },
      };
      const invocation = {
        projectPath: PROJECT,
        source: input.origin.source,
        operationId: input.sourceOperationId,
        request,
      };
      const created = await service.create(invocation);
      fx.db
        .prepare(
          `DELETE FROM ${scope === "session" ? "conversations" : "project_conversations"} WHERE id = ?`,
        )
        .run("source");
      refuseAdmission = true;
      const handlers = createCheckpointRouteHandlers({
        resolveProjectPath: async (name) =>
          name === "checkpoint-fork" ? PROJECT : null,
        getSession: fx.store.getSession,
        getProjectConversation: fx.store.getProjectConversation,
        repo: async () => repo,
        forkService: service,
        startCheckpoint: async () => {
          throw new Error("No compaction expected");
        },
        checkCheckpoint: async () => {
          throw new Error("No compaction expected");
        },
        cancelCheckpoint: async () => {
          throw new Error("No compaction expected");
        },
        reconcileCheckpoint: async () => {
          throw new Error("No compaction expected");
        },
        auth: {
          requireToken: async () => null,
          validateOptionalToken: async () => ({ kind: "absent" }),
        },
      });
      const handler =
        scope === "session" ? handlers.sessionFork : handlers.projectFork;
      const response = await handler(
        new Request("http://localhost/fork", {
          method: "POST",
          body: JSON.stringify(request),
        }),
        {
          params: Promise.resolve({
            name: "checkpoint-fork",
            session: SESSION,
            conversationId: "source",
            checkpointId: input.sourceOperationId,
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        reused: true,
        conversation: {
          id: created.conversation.id,
          checkpointFork: { source: input.origin.source },
        },
      });
      const retry = await service.create(invocation);
      expect(retry).toMatchObject({
        reused: true,
        conversation: { id: created.conversation.id },
      });
      await expect(service.check(invocation)).resolves.toBeUndefined();
      const key = { ...input.key, conversationId: created.conversation.id };
      expect(await repo.getPayload(key, created.operation.id)).toMatchObject({
        seedText: SEED,
      });
      await expect(
        service.create({
          ...invocation,
          request: { ...request, task: "Different task" },
        }),
      ).rejects.toMatchObject({ code: "request_id_conflict" });
    });

    it("refuses a corrupt frozen seed during preflight and creation without leaving a target", async () => {
      const input = await source(scope);
      const service = createCheckpointForkService({
        repo: () => ({
          ...repo,
          getPayload: async (key, id) => {
            const payload = await repo.getPayload(key, id);
            return (
              payload && { ...payload, seedText: payload.seedText + "corrupt" }
            );
          },
        }),
        load: async (_path, target) =>
          fx.store.checkpointContinuation.find({
            ...input.sourceKey,
            conversationId: target.conversationId,
          }),
        admit: async (_path, _backend, selection) => selection,
        resolveWork: async () => {},
        profile: async () => NO_OP_SNAPSHOT_FIXTURE,
        publish: () => {},
        now: () => AT,
      });
      const invocation = {
        projectPath: PROJECT,
        source: input.origin.source,
        operationId: input.sourceOperationId,
        request: {
          requestId: "34614a95-aac2-4314-bc69-cb889cfd207c",
          name: "Next",
          task: "Implement Q-137",
          backend: "codex" as const,
          modelSelection: { modelId: "gpt-6-astra", parameters: {} },
          relatedWork: { kind: "ticket" as const, ticketNumber: 131 },
        },
      };
      await expect(service.check(invocation)).rejects.toMatchObject({
        code: "invalid_payload",
      });
      await expect(service.create(invocation)).rejects.toMatchObject({
        code: "invalid_payload",
      });
      expect(
        fx.store.checkpointContinuation.find({
          ...input.key,
          conversationId: invocation.request.requestId,
        }),
      ).toBeNull();
    });

    it("leaves a cancelled admission editable when the persistence queue reaches its commit", async () => {
      const input = await source(scope);
      expect((await repo.createFork(input)).ok).toBe(true);
      await admitCheckpointForkSubmission(
        fx.store,
        {
          projectPath: PROJECT,
          sessionName:
            scope === "session"
              ? SESSION
              : PROJECT_CONVERSATION_SESSION_SENTINEL,
          conversationId: input.key.conversationId,
        },
        "claude",
        () => false,
      );
      const row = fx.recreateStore().checkpointContinuation.find(input.key);
      expect(row?.agentBackend).toBe("codex");
      expect(row?.checkpointFork?.submission).toBeUndefined();
    });

    it("serializes a first edited backend with its submission lock and preserves it across reload", async () => {
      const input = await source(scope);
      expect((await repo.createFork(input)).ok).toBe(true);
      const identity = {
        projectPath: PROJECT,
        sessionName:
          scope === "session" ? SESSION : PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: input.key.conversationId,
      };
      const change = (backend: "claude" | "codex") =>
        fx.store.mutateConversation(
          PROJECT,
          identity.sessionName,
          identity.conversationId,
          "edit-backend",
          (conversation) => {
            assertCheckpointForkBackend(conversation, backend);
            conversation.agentBackend = backend;
          },
        );
      await change("claude");
      const submission = admitCheckpointForkSubmission(
        fx.store,
        identity,
        "claude",
      );
      const retarget = change("codex");
      const outcomes = await Promise.allSettled([submission, retarget]);
      expect(outcomes[0].status).toBe("fulfilled");
      expect(outcomes[1]).toMatchObject({
        status: "rejected",
        reason: { code: "checkpoint_fork_backend_locked" },
      });
      const reloaded = fx
        .recreateStore()
        .checkpointContinuation.find(input.key)!;
      expect(reloaded).toMatchObject({
        promptCount: 0,
        agentBackend: "claude",
        checkpointFork: { submission: { backend: "claude" } },
      });
      expect(() => assertCheckpointForkBackend(reloaded, "codex")).toThrow(
        "first submission",
      );
      expect(() =>
        assertCheckpointForkBackend(reloaded, "claude"),
      ).not.toThrow();
      expect(
        await repo.getPayload(input.key, input.key.conversationId),
      ).toMatchObject({ seedText: SEED, seedSha256: input.origin.seedSha256 });
    });

    it("atomically creates a fresh ordinary conversation with an independent ready seed and durable lineage", async () => {
      const input = await source(scope);
      const before = await repo.getOperation(
        input.sourceKey,
        input.sourceOperationId,
      );
      const result = await repo.createFork(input);
      expect(result).toMatchObject({
        ok: true,
        value: {
          reused: false,
          operation: {
            phase: "ready",
            conversationId: input.key.conversationId,
          },
        },
      });
      const restarted = fx.recreateStore();
      const target = restarted.checkpointContinuation.find(input.key);
      expect(target).toMatchObject({
        id: "fork-request",
        agentBackend: "codex",
        promptCount: 0,
        backendRef: null,
        forkedFrom: null,
        transcriptPath: null,
        role: null,
        owner: null,
        pendingPromptText: "Implement Q-137",
        checkpointFork: input.origin,
      });
      const reloaded = createConversationCheckpointsRepo(
        fx.db,
        createWriteQueue(),
        restarted.checkpointContinuation,
      );
      expect(
        await reloaded.getPayload(input.key, "fork-request"),
      ).toMatchObject({ seedText: SEED, seedSha256: input.origin.seedSha256 });
      expect(
        await reloaded.getReceipt(input.key, "fork-request"),
      ).toMatchObject({ forkOrigin: input.origin });
      expect(
        await reloaded.getOperation(input.key, "fork-request"),
      ).toMatchObject({
        phase: "ready",
        protectedReferences: {
          priorBackendRef: null,
          acceptedBackendRef: null,
        },
        delivery: null,
        acceptance: null,
        generationPassCount: 0,
      });
      expect(
        await repo.getOperation(input.sourceKey, input.sourceOperationId),
      ).toEqual(before);
      expect((await fx.store.getSession(PROJECT, SESSION))?.worktreePath).toBe(
        `${PROJECT}/.worktrees/${SESSION}`,
      );
    });

    it("reuses an identical request and refuses a conflicting retry without overwriting the draft", async () => {
      const input = await source(scope);
      expect((await repo.createFork(input)).ok).toBe(true);
      expect(await repo.createFork(input)).toMatchObject({
        ok: true,
        value: { reused: true },
      });
      expect(
        await repo.createFork({
          ...input,
          origin: { ...input.origin, requestHash: "different" },
        }),
      ).toMatchObject({ ok: false, refusal: { code: "request_id_conflict" } });
      expect(
        fx.recreateStore().checkpointContinuation.find(input.key)
          ?.pendingPromptText,
      ).toBe("Implement Q-137");
    });

    it("refuses a missing or mismatched source without leaving a target conversation", async () => {
      const input = await source(scope);
      expect(
        await repo.createFork({ ...input, sourceOperationId: "absent" }),
      ).toMatchObject({ ok: false, refusal: { code: "checkpoint_not_found" } });
      expect(
        fx.recreateStore().checkpointContinuation.find(input.key),
      ).toBeNull();
      expect(
        await repo.createFork({
          ...input,
          origin: { ...input.origin, seedSha256: "wrong" },
        }),
      ).toMatchObject({ ok: false, refusal: { code: "invalid_payload" } });
      expect(
        fx.recreateStore().checkpointContinuation.find(input.key),
      ).toBeNull();
    });

    it("rolls back the target conversation when storing its seed fails", async () => {
      const input = await source(scope);
      fx.db.exec(
        "CREATE TRIGGER fail_fork_payload BEFORE INSERT ON conversation_checkpoints WHEN NEW.id = 'fork-request' BEGIN SELECT RAISE(ABORT, 'seed write failed'); END",
      );
      await expect(repo.createFork(input)).rejects.toThrow("seed write failed");
      expect(
        fx.recreateStore().checkpointContinuation.find(input.key),
      ).toBeNull();
      expect(await repo.getOperation(input.key, "fork-request")).toBeNull();
      expect(
        await repo.getPayload(input.sourceKey, input.sourceOperationId),
      ).toMatchObject({ seedText: SEED });
    });
  },
);
