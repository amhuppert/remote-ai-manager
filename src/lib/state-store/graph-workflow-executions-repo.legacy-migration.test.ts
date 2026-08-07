import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedLog {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: unknown;
}

const capturedLogs: CapturedLog[] = [];

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "info", message, data }),
    debug: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "debug", message, data }),
    warn: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "warn", message, data }),
    error: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "error", message, data }),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowExecutionsRepo,
  type GraphWorkflowExecutionsRepo,
} from "./graph-workflow-executions-repo";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: GraphWorkflowExecutionsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function insertProject(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
}

function insertSession(): void {
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `/wt/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function buildLegacyExecution(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "exec-legacy-1",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "running",
    activeContextId: "ctx-a",
    contextStates: {
      "ctx-a": {
        contextId: "ctx-a",
        status: "running",
        totalTaskCount: 2,
        completedTaskCount: 0,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        worktreePath: "/wt/sub",
        branchName: "csm/feature",
      },
      "ctx-b": {
        contextId: "ctx-b",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 1,
        consecutiveFailureCount: 0,
      },
    },
    taskStates: {},
    sharedDocuments: [],
    history: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    startedAt: "2026-04-04T00:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    pendingCollaborations: {},
    collaborationContinuations: {},
    ...overrides,
  };
}

function buildCleanExecution(): GraphWorkflowExecution {
  return {
    id: "exec-clean-1",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    liveRevision: 1,
    executionStateRevision: 0,
    structuralRevision: 0,
    charterAmendments: [],
    planRepairRounds: [],
    loopControlAmendments: [],
    contextOutputs: {},
    routeControlRevisions: {},
    routeSettlements: {},
    expansionReceipts: { accepted: [], refusals: [] },
    loopStates: {},
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    definitionApproval: null,
    workingDefinition: {
      schemaVersion: 1,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
      executionContexts: [],
      tasks: [],
      edges: [],
    },
    charter: makeTestCharter(),
    status: "paused",
    activeContextIds: [],
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    advisoryIndex: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    startedAt: "2026-04-04T00:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
  };
}

/**
 * Raw-insert one active execution row with the whole (possibly legacy-shaped)
 * record in `runtime_json` and an empty `definition_json`. The repo's read-time
 * merge is `{...definition_json, ...runtime_json}`, so the whole record is
 * reconstructed and the on-read legacy-upgrade path runs against it — exactly
 * what a freshly backfilled-then-stale row looks like before the first rewrite.
 */
function rawInsertExecution(execution: Record<string, unknown>): void {
  const status =
    typeof execution.status === "string" ? execution.status : "running";
  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    typeof execution.id === "string" ? execution.id : "exec-unknown",
    "seed-1",
    1,
    "2026-04-04T00:00:00.000Z",
    status,
    null,
    "{}",
    JSON.stringify(execution),
    "2026-01-01T00:00:00Z",
  );
}

/** The merged stored record (definition_json ⊕ runtime_json) as raw JSON. */
function readStoredExecution(): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT definition_json, runtime_json FROM graph_workflow_executions
        WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, SESSION_NAME) as
    | { definition_json: string; runtime_json: string }
    | undefined;
  if (!row) return null;
  return {
    ...(JSON.parse(row.definition_json) as Record<string, unknown>),
    ...(JSON.parse(row.runtime_json) as Record<string, unknown>),
  };
}

beforeEach(() => {
  capturedLogs.length = 0;
  db = _createTestDb({ inMemory: true });
  insertProject();
  insertSession();
  repo = createGraphWorkflowExecutionsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("graph-workflow-executions-repo legacy migration on read", () => {
  it("(a) clean record passes through untouched without re-persisting or emitting migration event", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      buildCleanExecution(),
      "2026-01-01T00:00:00Z",
    );
    const before = readStoredExecution();
    capturedLogs.length = 0;

    // A fresh repo instance bypasses the parsed-row cache so the read re-merges.
    const fresh = createGraphWorkflowExecutionsRepo(db);
    const execution = fresh.getActive(PROJECT_PATH, SESSION_NAME);
    const after = readStoredExecution();

    expect(execution?.id).toBe("exec-clean-1");
    expect(execution?.status).toBe("paused");
    expect(after).toEqual(before);

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(0);
  });

  it("(b) legacy record is migrated, re-persisted to disk, and structured event is emitted", () => {
    rawInsertExecution(buildLegacyExecution());

    const execution = repo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(execution).not.toBeNull();
    if (!execution) return;

    expect(execution.id).toBe("exec-legacy-1");
    expect(execution.status).toBe("paused");
    expect(execution.activeContextIds).toEqual([]);
    const ctxA = execution.contextStates["ctx-a"];
    expect(ctxA?.status).toBe("ready");
    expect(ctxA?.worktreePath).toBe("/wt/sub");
    expect(ctxA?.branchName).toBe("csm/feature");
    expect(execution.contextStates["ctx-b"]?.status).toBe("completed");

    const onDisk = readStoredExecution();
    expect(onDisk).not.toBeNull();
    if (!onDisk) return;
    expect("activeContextId" in onDisk).toBe(false);
    expect(onDisk.status).toBe("paused");
    expect(onDisk.activeContextIds).toEqual([]);
    const onDiskCtxA = (onDisk.contextStates as Record<string, unknown>)[
      "ctx-a"
    ] as Record<string, unknown>;
    expect(onDiskCtxA.status).toBe("ready");
    expect(onDiskCtxA.worktreePath).toBe("/wt/sub");
    expect(onDiskCtxA.branchName).toBe("csm/feature");

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(1);
    const data = migrationEvents[0]?.data as
      | { executionId?: string; repairedFields?: string[] }
      | undefined;
    expect(data?.executionId).toBe("exec-legacy-1");
    expect(data?.repairedFields).toEqual(
      expect.arrayContaining([
        "activeContextId",
        "status",
        "activeContextIds",
        "contextStates.running",
      ]),
    );
  });

  it("(c) malformed record (post-migration parse fails) throws (fail-loud) and preserves the original on disk", () => {
    const malformed = {
      id: "exec-bad-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: 42,
      status: "running",
      activeContextId: "ctx-a",
      contextStates: {},
      taskStates: {},
      startedAt: "2026-04-04T00:00:00.000Z",
    };
    rawInsertExecution(malformed);
    const before = readStoredExecution();

    expect(() => repo.getActive(PROJECT_PATH, SESSION_NAME)).toThrow();

    const validationLogs = capturedLogs.filter(
      (e) =>
        e.level === "error" &&
        e.message ===
          "state-store.graph-workflow-executions.schema_validation_failure",
    );
    expect(validationLogs).toHaveLength(1);

    // The corrupt blob is left intact on disk (a schema that understands it can
    // still parse it on a later read).
    expect(readStoredExecution()).toEqual(before);
  });

  it("(d) new-schema record with a legitimately running context passes through untouched (no migration on every read mid-execution)", () => {
    const running = {
      id: "exec-running-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: {
        schemaVersion: 1,
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      charter: makeTestCharter(),
      status: "running",
      activeContextIds: ["ctx-a"],
      contextStates: {
        "ctx-a": {
          contextId: "ctx-a",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
      },
      taskStates: {},
      sharedDocuments: [],
      laneStates: {},
      executionLanes: {},
      joins: {},
      machineSnapshot: null,
      history: [],
      startedAt: "2026-04-04T00:00:00.000Z",
      completedAt: null,
      haltReason: null,
      pendingHaltReason: null,
    };
    rawInsertExecution(running);
    const before = readStoredExecution();

    const execution = repo.getActive(PROJECT_PATH, SESSION_NAME);
    const after = readStoredExecution();

    expect(execution?.id).toBe("exec-running-1");
    expect(execution?.status).toBe("running");
    expect(execution?.activeContextIds).toEqual(["ctx-a"]);
    expect(execution?.contextStates["ctx-a"]?.status).toBe("running");
    expect(after).toEqual(before);

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(0);
  });

  it("legacy detection happens on the raw object (legacy field present) before zod-strip would silently drop it", () => {
    rawInsertExecution(buildLegacyExecution());

    const execution = repo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(execution?.activeContextIds).toEqual([]);

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(1);
    const data = migrationEvents[0]?.data as
      | { repairedFields?: string[] }
      | undefined;
    expect(data?.repairedFields).toContain("activeContextId");
  });

  it("flat laneStates record (pre-promotion shape) is reshaped to nested keying and re-persisted", () => {
    const flatLanes = {
      id: "exec-flat-lanes-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: {
        schemaVersion: 1,
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      charter: makeTestCharter(),
      status: "paused",
      activeContextIds: [],
      contextStates: {},
      taskStates: {},
      sharedDocuments: [],
      laneStates: {
        context_validator: {
          contextId: "execution-loop-fan-out-fan-in",
          engine: "codex",
          lane: "context_validator",
          lastTurnUsage: null,
          lastUsedAt: "2026-05-08T09:57:14.649Z",
          limitEvaluation: "disabled",
          rotateBeforeNextTurn: false,
          sessionRef: {
            engine: "codex",
            lane: "context_validator",
            threadId: "thread-1",
          },
        },
        implementer: {
          contextId: "execution-loop-fan-out-fan-in",
          engine: "claude",
          lane: "implementer",
          lastContextTokens: 49341,
          lastContextWindowMax: 200000,
          lastUsedAt: "2026-05-08T09:54:42.829Z",
          limitEvaluation: "disabled",
          rotateBeforeNextTurn: false,
          sessionRef: {
            conversationId: "conv-1",
            engine: "claude",
            lane: "implementer",
          },
          workflowConversationId: "conv-1",
        },
      },
      machineSnapshot: null,
      history: [],
      startedAt: "2026-05-08T00:00:00.000Z",
      completedAt: null,
      haltReason: null,
      pendingHaltReason: null,
    };
    rawInsertExecution(flatLanes);

    const execution = repo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(execution).not.toBeNull();
    if (!execution) return;

    expect(execution.laneStates).toEqual({
      "execution-loop-fan-out-fan-in": {
        context_validator: expect.objectContaining({
          backend: "codex",
          lane: "context_validator",
          refKind: "backend",
          sessionRef: { backend: "codex", ref: "thread-1" },
        }),
        implementer: expect.objectContaining({
          backend: "claude",
          lane: "implementer",
          refKind: "conversation",
          sessionRef: { backend: "claude", ref: "conv-1" },
          workflowConversationId: "conv-1",
        }),
      },
    });

    const onDisk = readStoredExecution();
    expect(onDisk).not.toBeNull();
    if (!onDisk) return;
    const onDiskLanes = onDisk.laneStates as Record<string, unknown>;
    expect(Object.keys(onDiskLanes)).toEqual(["execution-loop-fan-out-fan-in"]);

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(1);
    const data = migrationEvents[0]?.data as
      | { repairedFields?: string[] }
      | undefined;
    expect(data?.repairedFields).toContain("laneStates");
  });
});
