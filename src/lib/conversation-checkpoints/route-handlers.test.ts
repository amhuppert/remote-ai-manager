import { createHistoryRouteHandlers } from "@/lib/conversations/history-route-handlers";
import { createHistoryEntryService } from "@/lib/conversations/history-entry-service";
import { createHistoryImageService } from "@/lib/conversations/history-image-service";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { ConversationAddress } from "@/lib/workflows/conversation/turn-spec";
import type {
  ConversationCheckpointCancel,
  ConversationCheckpointCheck,
  ConversationCheckpointReconcile,
  ConversationCheckpointStart,
} from "@/lib/workflows/conversation/manager";

import type { CheckpointRefusal } from "./admission";
import type { CheckpointConversationGateway } from "./continuation";
import { CHECKPOINT_CAPTURE_POLICY, checkpointReceipt } from "./receipt";
import {
  createConversationCheckpointsRepo,
  type ConversationCheckpointsRepo,
} from "./repo";
import { createCheckpointRouteHandlers } from "./route-handlers";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointHandoffRequest,
  type CheckpointOperation,
  type CheckpointPayload,
  type CheckpointScopeKey,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "alpha";
const PROJECT_PATH = "/projects/alpha";
const SESSION_NAME = "csm-alpha";
const CONVERSATION_ID = "conv-1";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const BASIS = { capturedThroughSeq: 120, sourceHash: "sha256:source-a" };

interface ScopeCase {
  scope: "session" | "project";
  params: Record<string, string>;
  key: CheckpointScopeKey;
  base: string;
}

const SESSION_CASE: ScopeCase = {
  scope: "session",
  params: {
    name: PROJECT_NAME,
    session: SESSION_NAME,
    conversationId: CONVERSATION_ID,
  },
  key: {
    scope: "session",
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
  },
  base: `/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/conversations/${CONVERSATION_ID}`,
};

const PROJECT_CASE: ScopeCase = {
  scope: "project",
  params: { name: PROJECT_NAME, conversationId: CONVERSATION_ID },
  key: {
    scope: "project",
    projectPath: PROJECT_PATH,
    sessionName: null,
    conversationId: CONVERSATION_ID,
  },
  base: `/api/projects/${PROJECT_NAME}/conversations/${CONVERSATION_ID}`,
};

/** Every conversation the repository is asked about exists in this fixture. */
function gateway(): CheckpointConversationGateway {
  return {
    insert() {
      throw new Error("fork insertion is outside this fixture");
    },
    exists: () => true,
    find: () => null,
    clearBackendRef: () => true,
  };
}

const SEED_TEXT = "## Working state\nShip the widget.\n";

function buildPayload(operationId: string): CheckpointPayload {
  const seedText = SEED_TEXT;
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
      recoveryMap: { commands: ["cctl conversation read conv-1"] },
    },
    seedText,
    seedSha256: "sha256:seed-a",
    sectionBytes: {
      total: Buffer.byteLength(seedText, "utf8"),
      workingState: 20,
      recentDialogue: 8,
      recoveryFraming: 6,
    },
    omissions: [{ category: "tool_results", detail: "3 large results" }],
    generationPassCount: 2,
    createdAt: "2026-09-07T12:00:00.000Z",
  };
}

interface ManagerCalls {
  start: {
    address: ConversationAddress;
    requestId: string;
    handoff?: CheckpointHandoffRequest;
    recover?: string | null;
  }[];
  check: { address: ConversationAddress; recover: string | null | undefined }[];
  cancel: { address: ConversationAddress; operationId: string }[];
  reconcile: {
    address: ConversationAddress;
    operationId: string;
    captureExecutionStopped?: boolean;
    source?: string;
  }[];
  skip: { address: ConversationAddress; operationId: string }[];
}

/** What the injected manager commands answer, mutable per test. */
interface ManagerState {
  start: ConversationCheckpointStart;
  check: ConversationCheckpointCheck;
  cancel: ConversationCheckpointCancel;
  reconcile: ConversationCheckpointReconcile;
  conversations: ConversationState[];
}

interface Harness {
  db: Db;
  repo: ConversationCheckpointsRepo;
  calls: ManagerCalls;
  handlers: ReturnType<typeof createCheckpointRouteHandlers>;
  state: ManagerState;
  log: CapturingLogger;
}

let harness: Harness;

function refusal(code: CheckpointRefusal["code"]): CheckpointRefusal {
  return { code, reason: `refused: ${code}`, operationId: null, phase: null };
}

function makeHarness(): Harness {
  const db = _createTestDb({ inMemory: true });
  const log = createCapturingLogger();
  const repo = createConversationCheckpointsRepo(
    db,
    createWriteQueue(),
    gateway(),
  );
  const calls: ManagerCalls = {
    start: [],
    check: [],
    cancel: [],
    reconcile: [],
    skip: [],
  };
  const state: ManagerState = {
    start: { kind: "refused", refusal: refusal("conversation_busy") },
    check: {
      eligible: true,
      refusals: [],
      active: null,
      hosted: false,
      handoff: {
        available: true,
        mode: "tool-disabled",
        reason: null,
        policy: CHECKPOINT_CAPTURE_POLICY,
      },
    },
    cancel: { kind: "refused", refusal: refusal("not_cancellable") },
    reconcile: { kind: "refused", refusal: refusal("checkpoint_not_found") },
    conversations: [makeConversationState({ id: CONVERSATION_ID })],
  };
  const handlers = createCheckpointRouteHandlers({
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === PROJECT_PATH && sessionName === SESSION_NAME
        ? { conversations: state.conversations }
        : null,
    getProjectConversation: async (projectPath, conversationId) =>
      projectPath === PROJECT_PATH
        ? (state.conversations.find((c) => c.id === conversationId) ?? null)
        : null,
    repo: async () => repo,
    startCheckpoint: async (input) => {
      calls.start.push({
        address: input.address,
        requestId: input.requestId,
        recover: input.recover,
        ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      });
      return state.start;
    },
    checkCheckpoint: async (address, options) => {
      calls.check.push({ address, recover: options?.recover });
      return state.check;
    },
    cancelCheckpoint: async (input) => {
      calls.cancel.push(input);
      return state.cancel;
    },
    skipHandoff: async (input) => {
      calls.skip.push(input);
      return { kind: "refused", refusal: refusal("checkpoint_not_found") };
    },
    reconcileCheckpoint: async (input) => {
      calls.reconcile.push(input);
      return state.reconcile;
    },
    auth: {
      requireToken: async () => null,
      validateOptionalToken: async () => ({ kind: "absent" }) as const,
    },
    log,
  });
  return { db, repo, calls, handlers, state, log };
}

beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => harness.db.close());

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

async function admit(
  key: CheckpointScopeKey,
  requestId: string,
): Promise<CheckpointOperation> {
  const result = await harness.repo.admitOperation({
    key,
    requestId,
    sourceBasis: BASIS,
    priorBackendRef: "prior-ref",
    requestedAt: "2026-09-07T12:00:00.000Z",
  });
  if (!result.ok) throw new Error(`admit failed: ${result.refusal.code}`);
  return result.value.operation;
}

describe.each([SESSION_CASE, PROJECT_CASE])(
  "checkpoint route handlers ($scope scope)",
  (scopeCase) => {
    const pick = <T>(session: T, project: T): T =>
      scopeCase.scope === "session" ? session : project;

    const list = () =>
      pick(harness.handlers.sessionList, harness.handlers.projectList);
    const start = () =>
      pick(harness.handlers.sessionStart, harness.handlers.projectStart);
    const eligibility = () =>
      pick(
        harness.handlers.sessionEligibility,
        harness.handlers.projectEligibility,
      );
    const get = () =>
      pick(harness.handlers.sessionGet, harness.handlers.projectGet);
    const cancel = () =>
      pick(harness.handlers.sessionCancel, harness.handlers.projectCancel);
    const reconcile = () =>
      pick(
        harness.handlers.sessionReconcile,
        harness.handlers.projectReconcile,
      );

    it.each(["tool-disabled", "instruction-only", null] as const)(
      "preserves explicit disclosed mode %s at start",
      async (mode) => {
        const response = await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID, handoff: { mode } }),
          }),
          ctx(scopeCase.params),
        );
        expect(response.status).toBe(409);
        expect(harness.calls.start[0]?.handoff).toEqual({ mode });
      },
    );
    it.each([
      true,
      null,
      {},
      { mode: "auto" },
      { mode: "tool-disabled", extra: true },
    ])("rejects malformed handoff %j before admission", async (handoff) => {
      const response = await start()(
        req(`${scopeCase.base}/checkpoints`, {
          method: "POST",
          body: JSON.stringify({ requestId: REQUEST_ID, handoff }),
        }),
        ctx(scopeCase.params),
      );
      expect(response.status).toBe(400);
      expect(
        (await response.json()).issues.some((issue: { path: string }) =>
          issue.path.startsWith("handoff"),
        ),
      ).toBe(true);
      expect(harness.calls.start).toEqual([]);
    });
    it("treats explicit false as baseline", async () => {
      await start()(
        req(`${scopeCase.base}/checkpoints`, {
          method: "POST",
          body: JSON.stringify({ requestId: REQUEST_ID, handoff: false }),
        }),
        ctx(scopeCase.params),
      );
      expect(harness.calls.start).toHaveLength(1);
      expect(harness.calls.start[0]).not.toHaveProperty("handoff");
    });
    it("validates reconciliation testimony before calling the manager", async () => {
      const response = await reconcile()(
        req(`${scopeCase.base}/checkpoints/${REQUEST_ID}/reconcile`, {
          method: "POST",
          body: JSON.stringify({ captureExecutionStopped: "yes" }),
        }),
        ctx({ ...scopeCase.params, checkpointId: REQUEST_ID }),
      );
      expect(response.status).toBe(400);
      expect(harness.calls.reconcile).toEqual([]);
    });
    it("forwards explicit stopped-execution testimony with its source", async () => {
      await reconcile()(
        req(`${scopeCase.base}/checkpoints/${REQUEST_ID}/reconcile`, {
          method: "POST",
          body: JSON.stringify({
            captureExecutionStopped: true,
            source: "cli",
          }),
        }),
        ctx({ ...scopeCase.params, checkpointId: REQUEST_ID }),
      );
      expect(harness.calls.reconcile[0]).toMatchObject({
        captureExecutionStopped: true,
        source: "cli",
      });
    });
    it("routes skip to the addressed manager operation", async () => {
      const skip = pick(
        harness.handlers.sessionSkipHandoff,
        harness.handlers.projectSkipHandoff,
      );
      const response = await skip(
        req(`${scopeCase.base}/checkpoints/${REQUEST_ID}/skip-handoff`, {
          method: "POST",
        }),
        ctx({ ...scopeCase.params, checkpointId: REQUEST_ID }),
      );
      expect(response.status).toBe(404);
      expect(harness.calls.skip[0]).toMatchObject({
        operationId: REQUEST_ID,
        address: { target: { scope: scopeCase.scope } },
      });
    });

    describe("POST /checkpoints", () => {
      it("returns 202 with the durable receipt and status URL after admission", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        harness.state.start = {
          kind: "admitted",
          operation,
          receipt: checkpointReceipt(operation, null),
          completion: Promise.resolve(operation),
        };

        const response = await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(202);
        const body = await response.json();
        expect(body.outcome).toBe("admitted");
        expect(body.receipt.operationId).toBe(operation.id);
        expect(body.receipt.mechanism).toBe("cc_checkpoint");
        expect(body.statusUrl).toBe(
          `${scopeCase.base}/checkpoints/${operation.id}`,
        );
        expect(harness.calls.start).toEqual([
          {
            address: {
              projectPath: PROJECT_PATH,
              target:
                scopeCase.scope === "session"
                  ? {
                      scope: "session",
                      projectName: PROJECT_NAME,
                      sessionName: SESSION_NAME,
                      conversationId: CONVERSATION_ID,
                    }
                  : {
                      scope: "project",
                      projectName: PROJECT_NAME,
                      conversationId: CONVERSATION_ID,
                    },
            },
            requestId: REQUEST_ID,
            recover: null,
          },
        ]);
      });

      it("passes an explicit recovery target through to the manager", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        harness.state.start = {
          kind: "reused",
          operation,
          receipt: checkpointReceipt(operation, null),
          completion: Promise.resolve(operation),
        };

        const response = await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({
              requestId: REQUEST_ID,
              recoversOperationId: "op-prior",
            }),
          }),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(202);
        expect((await response.json()).outcome).toBe("reused");
        expect(harness.calls.start[0]?.recover).toBe("op-prior");
      });

      it("refuses an invalid body with 400 before reaching the manager", async () => {
        const response = await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: "not-a-uuid" }),
          }),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.code).toBe("invalid_checkpoint_request");
        expect(body.issues[0].path).toBe("requestId");
        expect(harness.calls.start).toEqual([]);
      });

      it.each([
        ["conversation_busy", 409],
        ["conversation_owned", 409],
        ["checkpoint_pending", 409],
        ["conversation_archived", 409],
        ["recovery_required", 409],
        ["backend_unsupported", 422],
        ["no_recorded_history", 422],
        ["conversation_not_found", 404],
      ] as const)("maps %s to HTTP %i", async (code, status) => {
        harness.state.start = { kind: "refused", refusal: refusal(code) };

        const response = await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(status);
        const body = await response.json();
        expect(body.code).toBe(code);
        expect(body.refusal.code).toBe(code);
        expect(body.details?.refusal).toEqual(body.refusal);
      });

      it("rejects an invalid bearer token with 401 before resolving anything", async () => {
        const rejecting = createCheckpointRouteHandlers({
          resolveProjectPath: async () => {
            throw new Error("resolution must not run for a rejected token");
          },
          getSession: async () => null,
          getProjectConversation: async () => null,
          repo: async () => harness.repo,
          startCheckpoint: async () => harness.state.start,
          checkCheckpoint: async () => harness.state.check,
          cancelCheckpoint: async () => harness.state.cancel,
          reconcileCheckpoint: async () => harness.state.reconcile,
          skipHandoff: async () => ({
            kind: "refused",
            refusal: refusal("checkpoint_not_found"),
          }),
          auth: {
            requireToken: async () => null,
            validateOptionalToken: async () => ({ kind: "invalid" }) as const,
          },
        });

        const handler =
          scopeCase.scope === "session"
            ? rejecting.sessionStart
            : rejecting.projectStart;
        const response = await handler(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(401);
      });

      it("404s a conversation that is not in this scope without calling the manager", async () => {
        const response = await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx({ ...scopeCase.params, conversationId: "conv-missing" }),
        );

        expect(response.status).toBe(404);
        expect(harness.calls.start).toEqual([]);
      });
    });

    describe("GET /checkpoints", () => {
      it("returns the scoped receipt index newest first with a continuation cursor", async () => {
        await admit(scopeCase.key, "aaaaaaaa-1111-4111-8111-111111111111");
        await harness.repo.recordOutcome({
          key: scopeCase.key,
          operationId: "aaaaaaaa-1111-4111-8111-111111111111",
          expectedPhase: "building",
          phase: "cancelled",
          at: "2026-09-07T12:01:00.000Z",
        });
        await admit(scopeCase.key, "bbbbbbbb-2222-4222-8222-222222222222");

        const response = await list()(
          req(`${scopeCase.base}/checkpoints?limit=1`),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.receipts).toHaveLength(1);
        expect(body.receipts[0].ordinal).toBe(2);
        expect(body.nextBefore).toBe(2);
        expect(body.receipts[0]).not.toHaveProperty("seedText");
      });

      it("refuses an out-of-range limit with 400", async () => {
        const response = await list()(
          req(`${scopeCase.base}/checkpoints?limit=500`),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(400);
        expect((await response.json()).issues[0].path).toBe("limit");
      });

      it("excludes operations belonging to the other scope", async () => {
        const other =
          scopeCase.scope === "session" ? PROJECT_CASE : SESSION_CASE;
        await admit(other.key, "cccccccc-3333-4333-8333-333333333333");

        const response = await list()(
          req(`${scopeCase.base}/checkpoints`),
          ctx(scopeCase.params),
        );

        expect((await response.json()).receipts).toEqual([]);
      });
    });

    describe("GET /checkpoints/<id>", () => {
      it("returns the receipt without the seed by default", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        await harness.repo.freezePayload({
          key: scopeCase.key,
          operationId: operation.id,
          payload: buildPayload(operation.id),
          at: "2026-09-07T12:05:00.000Z",
        });

        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.receipt.checkpoint.seedSha256).toBe("sha256:seed-a");
        expect(body.receipt.checkpoint.sectionBytes.total).toBe(
          Buffer.byteLength("## Working state\nShip the widget.\n", "utf8"),
        );
        expect(body.receipt.checkpoint.omissions).toEqual([
          { category: "tool_results", detail: "3 large results" },
        ]);
        expect(body.seed).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain("Ship the widget");
      });

      it("answers a reconnecting client with the current phase, not a replay", async () => {
        // No SSE frame is consumed here at all: the client that missed every
        // update reads the operation and learns where it actually stands.
        const operation = await admit(scopeCase.key, REQUEST_ID);
        await harness.repo.freezePayload({
          key: scopeCase.key,
          operationId: operation.id,
          payload: buildPayload(operation.id),
          usage: {
            inputTokens: 4_096,
            cachedInputTokens: 30_000,
            outputTokens: 512,
            costUsd: 0.42,
            durationMs: 8_100,
          },
          at: "2026-09-07T12:05:00.000Z",
        });
        const ready = await harness.repo.commitReady({
          key: scopeCase.key,
          operationId: operation.id,
          at: "2026-09-07T12:05:30.000Z",
        });
        if (!ready.ok) throw new Error("ready fixture failed");

        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        const body = await response.json();
        expect(body.receipt.phase).toBe("ready");
        expect(body.receipt.updatedAt).toBe("2026-09-07T12:05:30.000Z");
        expect(body.receipt.compactionUsage).toEqual({
          inputTokens: 4_096,
          cachedInputTokens: 30_000,
          outputTokens: 512,
          costUsd: 0.42,
          durationMs: 8_100,
        });
        expect(body.receipt.seedTokenEstimate).toBeNull();
        expect(body.receipt.contextOccupancy).toBeNull();
      });

      it("returns the immutable saved seed only for detail=seed", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        await harness.repo.freezePayload({
          key: scopeCase.key,
          operationId: operation.id,
          payload: buildPayload(operation.id),
          at: "2026-09-07T12:05:00.000Z",
        });

        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}?detail=seed`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        const body = await response.json();
        expect(body.seed.seedText).toBe("## Working state\nShip the widget.\n");
        expect(body.seed.sourceBasis.capturedThroughSeq).toBe(120);
        expect(body.seed.seedSha256).toBe("sha256:seed-a");
      });

      it("reads the immutable payload and its captured boundary, naming the rolling artifact it reused", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        const payload = buildPayload(operation.id);
        await harness.repo.freezePayload({
          key: scopeCase.key,
          operationId: operation.id,
          payload: {
            ...payload,
            artifactProvenance: {
              artifactId: "artifact-7",
              artifactSourceHash: "sha256:artifact-at-build",
            },
          },
          at: "2026-09-07T12:05:00.000Z",
        });

        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}?detail=seed`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        const body = await response.json();
        // The saved view is the frozen payload: its own boundary, its own
        // versions, and the artifact hash AS IT WAS at build time — the rolling
        // reading artifact is named, never read, so a newer one cannot silently
        // replace what this checkpoint actually carried.
        expect(body.seed.sourceBasis).toEqual(BASIS);
        expect(body.receipt.boundary).toEqual(BASIS);
        expect(body.seed.versions).toEqual(payload.versions);
        expect(body.seed.artifactProvenance).toEqual({
          artifactId: "artifact-7",
          artifactSourceHash: "sha256:artifact-at-build",
        });
        expect(body.seed.seedText).toBe(payload.seedText);
      });

      it("refuses an unknown detail level with 400", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}?detail=raw`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(400);
        expect((await response.json()).issues[0].path).toBe("detail");
      });

      it("404s an operation recorded under the other scope", async () => {
        const other =
          scopeCase.scope === "session" ? PROJECT_CASE : SESSION_CASE;
        const operation = await admit(
          other.key,
          "dddddddd-4444-4444-8444-444444444444",
        );

        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe("checkpoint_not_found");
      });

      it("serves a failed operation as a readable outcome, not an HTTP failure", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        await harness.repo.recordOutcome({
          key: scopeCase.key,
          operationId: operation.id,
          expectedPhase: "building",
          phase: "failed",
          failure: { code: "generation_failed", message: "pass 2 rejected" },
          at: "2026-09-07T12:09:00.000Z",
        });

        const response = await get()(
          req(`${scopeCase.base}/checkpoints/${operation.id}`),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.receipt.phase).toBe("failed");
        expect(body.receipt.failure.code).toBe("generation_failed");
      });
    });

    describe("cancel and reconcile", () => {
      it("returns the receipt after a cancellation", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        const cancelled = await harness.repo.recordOutcome({
          key: scopeCase.key,
          operationId: operation.id,
          expectedPhase: "building",
          phase: "cancelled",
          at: "2026-09-07T12:06:00.000Z",
        });
        if (!cancelled.ok) throw new Error("cancel fixture failed");
        harness.state.cancel = {
          kind: "cancelled",
          operation: cancelled.value,
        };

        const response = await cancel()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/cancel`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.outcome).toBe("cancelled");
        expect(body.receipt.phase).toBe("cancelled");
        expect(harness.calls.cancel).toEqual([
          {
            address: expect.objectContaining({ projectPath: PROJECT_PATH }),
            operationId: operation.id,
          },
        ]);
      });

      it("maps a not-cancellable refusal to 409", async () => {
        harness.state.cancel = {
          kind: "refused",
          refusal: refusal("not_cancellable"),
        };

        const response = await cancel()(
          req(`${scopeCase.base}/checkpoints/op-x/cancel`, { method: "POST" }),
          ctx({ ...scopeCase.params, checkpointId: "op-x" }),
        );

        expect(response.status).toBe(409);
        expect((await response.json()).refusal.code).toBe("not_cancellable");
      });

      it("returns the repaired receipt after reconciliation", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        harness.state.reconcile = { kind: "repaired", operation };

        const response = await reconcile()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.outcome).toBe("repaired");
        expect(body.receipt.operationId).toBe(operation.id);
        expect(harness.calls.reconcile[0]?.operationId).toBe(operation.id);
      });

      it("reports a blocked reconciliation as 409 with its receipt", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        harness.state.reconcile = {
          kind: "blocked",
          operation,
          refusal: refusal("reconciliation_failed"),
        };

        const response = await reconcile()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.refusal.code).toBe("reconciliation_failed");
        expect(body.details?.receipt).toEqual(body.receipt);
        expect(body.receipt.operationId).toBe(operation.id);
      });

      it("404s a reconcile for an unknown operation", async () => {
        harness.state.reconcile = {
          kind: "refused",
          refusal: refusal("checkpoint_not_found"),
        };

        const response = await reconcile()(
          req(`${scopeCase.base}/checkpoints/op-missing/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: "op-missing" }),
        );

        expect(response.status).toBe(404);
      });
    });

    describe("lifecycle diagnostics", () => {
      const events = (name: string) =>
        harness.log.entries.filter((entry) => entry.message === name);

      const scopeFields =
        scopeCase.scope === "session"
          ? { scope: "session", sessionName: SESSION_NAME }
          : { scope: "project" };

      it("records the admitted start with its operation correlation", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        harness.state.start = {
          kind: "admitted",
          operation,
          receipt: checkpointReceipt(operation, null),
          completion: Promise.resolve(operation),
        };

        await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx(scopeCase.params),
        );

        expect(
          events("checkpoint.route.start_admitted")[0]?.fields,
        ).toMatchObject({
          ...scopeFields,
          conversationId: CONVERSATION_ID,
          operationId: operation.id,
          ordinal: operation.ordinal,
        });
      });

      it("records a refused start with the refusal code", async () => {
        harness.state.start = {
          kind: "refused",
          refusal: refusal("conversation_archived"),
        };

        await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx(scopeCase.params),
        );

        expect(
          events("checkpoint.route.start_refused")[0]?.fields,
        ).toMatchObject({
          ...scopeFields,
          code: "conversation_archived",
        });
      });

      it("records a cancellation outcome and a cancel refusal", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        const cancelled = await harness.repo.recordOutcome({
          key: scopeCase.key,
          operationId: operation.id,
          expectedPhase: "building",
          phase: "cancelled",
          at: "2026-09-07T12:06:00.000Z",
        });
        if (!cancelled.ok) throw new Error("cancel fixture failed");
        harness.state.cancel = {
          kind: "cancelled",
          operation: cancelled.value,
        };

        await cancel()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/cancel`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(
          events("checkpoint.route.cancel_settled")[0]?.fields,
        ).toMatchObject({
          ...scopeFields,
          operationId: operation.id,
          outcome: "cancelled",
          phase: "cancelled",
        });

        harness.state.cancel = {
          kind: "refused",
          refusal: {
            code: "not_cancellable",
            reason: "already applied",
            operationId: operation.id,
            phase: "applied",
          },
        };
        await cancel()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/cancel`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(
          events("checkpoint.route.cancel_refused")[0]?.fields,
        ).toMatchObject({
          operationId: operation.id,
          code: "not_cancellable",
          phase: "applied",
        });
      });

      it("records reconciliation outcomes, blocked and refused alike", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        harness.state.reconcile = { kind: "repaired", operation };
        await reconcile()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        harness.state.reconcile = {
          kind: "blocked",
          operation,
          refusal: {
            code: "reconciliation_failed",
            reason: "close still failing",
            operationId: operation.id,
            phase: "needs_reconciliation",
          },
        };
        await reconcile()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        harness.state.reconcile = {
          kind: "refused",
          refusal: refusal("checkpoint_not_found"),
        };
        await reconcile()(
          req(`${scopeCase.base}/checkpoints/op-missing/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: "op-missing" }),
        );

        expect(
          events("checkpoint.route.reconcile_settled").map(
            (entry) => entry.fields.outcome,
          ),
        ).toEqual(["repaired"]);
        expect(
          events("checkpoint.route.reconcile_refused").map(
            (entry) => entry.fields.code,
          ),
        ).toEqual(["reconciliation_failed", "checkpoint_not_found"]);
      });

      it("keeps seed text, provider references and the sentinel out of every field", async () => {
        const operation = await admit(scopeCase.key, REQUEST_ID);
        const frozen = await harness.repo.freezePayload({
          key: scopeCase.key,
          operationId: operation.id,
          payload: buildPayload(operation.id),
          at: "2026-09-07T12:05:00.000Z",
        });
        if (!frozen.ok) throw new Error("freeze fixture failed");
        harness.state.start = {
          kind: "admitted",
          operation,
          receipt: checkpointReceipt(operation, null),
          completion: Promise.resolve(operation),
        };
        harness.state.cancel = { kind: "completed", operation };
        harness.state.reconcile = { kind: "repaired", operation };

        await start()(
          req(`${scopeCase.base}/checkpoints`, {
            method: "POST",
            body: JSON.stringify({ requestId: REQUEST_ID }),
          }),
          ctx(scopeCase.params),
        );
        await cancel()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/cancel`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );
        await reconcile()(
          req(`${scopeCase.base}/checkpoints/${operation.id}/reconcile`, {
            method: "POST",
          }),
          ctx({ ...scopeCase.params, checkpointId: operation.id }),
        );

        expect(harness.log.entries.length).toBeGreaterThan(0);
        const emitted = JSON.stringify(harness.log.entries);
        expect(emitted).not.toContain(SEED_TEXT);
        expect(emitted).not.toContain("prior-ref");
        expect(emitted).not.toContain("__project__");
      });
    });

    describe("GET /checkpoints/eligibility", () => {
      it("reports the admission predicates without mutating anything", async () => {
        harness.state.check = {
          eligible: false,
          refusals: [refusal("turn_active"), refusal("background_work")],
          active: null,
          hosted: true,
          handoff: {
            available: true,
            mode: "tool-disabled",
            reason: null,
            policy: CHECKPOINT_CAPTURE_POLICY,
          },
        };

        const response = await eligibility()(
          req(`${scopeCase.base}/checkpoints/eligibility`),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.eligible).toBe(false);
        expect(body.refusals.map((r: CheckpointRefusal) => r.code)).toEqual([
          "turn_active",
          "background_work",
        ]);
        expect(body.hosted).toBe(true);
        expect(body.handoff).toEqual(harness.state.check.handoff);
        expect(harness.calls.start).toEqual([]);
        expect(harness.calls.cancel).toEqual([]);
        expect(harness.calls.reconcile).toEqual([]);
        expect(
          (await harness.repo.listReceipts(scopeCase.key)).receipts,
        ).toEqual([]);
      });

      it("addresses the named recovery operation the start would supersede", async () => {
        const response = await eligibility()(
          req(
            `${scopeCase.base}/checkpoints/eligibility?recoversOperationId=op-prior`,
          ),
          ctx(scopeCase.params),
        );

        expect(response.status).toBe(200);
        expect(harness.calls.check[0]?.recover).toBe("op-prior");
      });

      it("404s a conversation outside this scope", async () => {
        const response = await eligibility()(
          req(`${scopeCase.base}/checkpoints/eligibility`),
          ctx({ ...scopeCase.params, conversationId: "conv-missing" }),
        );

        expect(response.status).toBe(404);
        expect(harness.calls.check).toEqual([]);
      });
    });
  },
);

// Retained entry/image success, exact bytes, thinking and oversized export cases
// live in conversations/history-route-handlers.test.ts. This matrix pins every
// public leaf to the same addressing boundary, including the new capture control.
describe.each([SESSION_CASE, PROJECT_CASE])(
  "complete scoped surface matrix ($scope)",
  (scopeCase) => {
    it.each([
      "eligibility",
      "start",
      "list",
      "detail",
      "cancel",
      "skip",
      "reconcile",
      "history-entry",
      "image",
    ] as const)(
      "refuses missing identity before %s can read or mutate",
      async (surface) => {
        const readTranscriptEntries = async () => {
          throw new Error("wrong-scope history read");
        };
        const history = createHistoryRouteHandlers({
          resolveProjectPath: async (name) =>
            name === PROJECT_NAME ? PROJECT_PATH : null,
          getSession: async (path, session) =>
            path === PROJECT_PATH && session === SESSION_NAME
              ? { conversations: harness.state.conversations }
              : null,
          getProjectConversation: async (path, id) =>
            path === PROJECT_PATH
              ? (harness.state.conversations.find((c) => c.id === id) ?? null)
              : null,
          entryService: createHistoryEntryService({ readTranscriptEntries }),
          imageService: createHistoryImageService({
            readTranscriptEntries,
            readImageBytes: async () => {
              throw new Error("wrong-scope image read");
            },
          }),
          auth: {
            requireToken: async () => null,
            validateOptionalToken: async () => ({ kind: "absent" }),
          },
        });
        const h = harness.handlers;
        const handlers =
          scopeCase.scope === "session"
            ? {
                eligibility: h.sessionEligibility,
                start: h.sessionStart,
                list: h.sessionList,
                detail: h.sessionGet,
                cancel: h.sessionCancel,
                skip: h.sessionSkipHandoff,
                reconcile: h.sessionReconcile,
                "history-entry": history.sessionEntry,
                image: history.sessionImage,
              }
            : {
                eligibility: h.projectEligibility,
                start: h.projectStart,
                list: h.projectList,
                detail: h.projectGet,
                cancel: h.projectCancel,
                skip: h.projectSkipHandoff,
                reconcile: h.projectReconcile,
                "history-entry": history.projectEntry,
                image: history.projectImage,
              };
        const before = await harness.repo.listReceipts(scopeCase.key);
        const invalidTargets: Record<string, string>[] = [
          { name: "neighbor" },
          { conversationId: "neighbor" },
          ...(scopeCase.scope === "session" ? [{ session: "neighbor" }] : []),
        ];
        for (const invalid of invalidTargets) {
          const response = await handlers[surface](
            req(scopeCase.base, {
              method: "POST",
              body: JSON.stringify({ requestId: REQUEST_ID }),
            }),
            ctx({
              ...scopeCase.params,
              checkpointId: REQUEST_ID,
              seq: "0",
              contentBlockIndex: "0",
              ...invalid,
            }),
          );
          expect(response.status).toBe(404);
        }
        expect(harness.calls).toEqual({
          start: [],
          check: [],
          cancel: [],
          skip: [],
          reconcile: [],
        });
        expect(await harness.repo.listReceipts(scopeCase.key)).toEqual(before);
      },
    );
  },
);
