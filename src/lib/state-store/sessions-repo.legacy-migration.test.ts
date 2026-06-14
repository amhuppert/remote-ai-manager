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
import { createSessionsRepo, type SessionsRepo } from "./sessions-repo";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: SessionsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function insertProject(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
}

function buildLegacyExecutionJson(
  overrides: Record<string, unknown> = {},
): string {
  const exec = {
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
  return JSON.stringify(exec);
}

function buildCleanExecutionJson(): string {
  const exec: GraphWorkflowExecution = {
    id: "exec-clean-1",
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
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    history: [],
    startedAt: "2026-04-04T00:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
  };
  return JSON.stringify(exec);
}

function rawInsertSession(graphWorkflowExecutionJson: string | null): void {
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at, archived, finished, source,
       objective, creation_mode, tdd_enabled, target_branch,
       parent_session_name, graph_workflow_execution,
       graph_workflow_execution_history, workflow_envelopes,
       workflow_lanes, mcp_overrides
     ) VALUES (
       @project_path, @session_name, @worktree_path, @branch_name,
       @created_at, @last_activity_at, @archived, @finished, @source,
       @objective, @creation_mode, @tdd_enabled, @target_branch,
       @parent_session_name, @graph_workflow_execution,
       @graph_workflow_execution_history, @workflow_envelopes,
       @workflow_lanes, @mcp_overrides
     )`,
  ).run({
    project_path: PROJECT_PATH,
    session_name: SESSION_NAME,
    worktree_path: `/wt/${SESSION_NAME}`,
    branch_name: `csm/${SESSION_NAME}`,
    created_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T00:00:00Z",
    archived: 0,
    finished: 0,
    source: "cc",
    objective: null,
    creation_mode: "fast",
    tdd_enabled: 1,
    target_branch: "main",
    parent_session_name: null,
    graph_workflow_execution: graphWorkflowExecutionJson,
    graph_workflow_execution_history: "[]",
    workflow_envelopes: null,
    workflow_lanes: null,
    mcp_overrides: null,
  });
}

function readGraphWorkflowExecutionColumn(): string | null {
  const row = db
    .prepare(
      "SELECT graph_workflow_execution FROM sessions WHERE project_path = ? AND session_name = ?",
    )
    .get(PROJECT_PATH, SESSION_NAME) as {
    graph_workflow_execution: string | null;
  };
  return row.graph_workflow_execution;
}

beforeEach(() => {
  capturedLogs.length = 0;
  db = _createTestDb({ inMemory: true });
  insertProject();
  repo = createSessionsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("sessions-repo graph-workflow legacy migration on load", () => {
  it("(a) clean record passes through untouched without re-persisting or emitting migration event", () => {
    const cleanJson = buildCleanExecutionJson();
    rawInsertSession(cleanJson);

    const before = readGraphWorkflowExecutionColumn();
    const session = repo.findByKey(PROJECT_PATH, SESSION_NAME);
    const after = readGraphWorkflowExecutionColumn();

    expect(session?.graphWorkflowExecution?.id).toBe("exec-clean-1");
    expect(session?.graphWorkflowExecution?.status).toBe("paused");
    expect(before).toBe(after);

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(0);
  });

  it("(b) legacy record is migrated, re-persisted to disk, and structured event is emitted", () => {
    rawInsertSession(buildLegacyExecutionJson());

    const session = repo.findByKey(PROJECT_PATH, SESSION_NAME);
    const exec = session?.graphWorkflowExecution;
    expect(exec).not.toBeNull();
    if (!exec) return;

    expect(exec.id).toBe("exec-legacy-1");
    expect(exec.status).toBe("paused");
    expect(exec.activeContextIds).toEqual([]);
    const ctxA = exec.contextStates["ctx-a"];
    expect(ctxA?.status).toBe("ready");
    expect(ctxA?.worktreePath).toBe("/wt/sub");
    expect(ctxA?.branchName).toBe("csm/feature");
    expect(exec.contextStates["ctx-b"]?.status).toBe("completed");

    const onDisk = readGraphWorkflowExecutionColumn();
    expect(onDisk).not.toBeNull();
    if (!onDisk) return;
    const onDiskParsed = JSON.parse(onDisk) as Record<string, unknown>;
    expect("activeContextId" in onDiskParsed).toBe(false);
    expect(onDiskParsed.status).toBe("paused");
    expect(onDiskParsed.activeContextIds).toEqual([]);
    const onDiskCtxA = (onDiskParsed.contextStates as Record<string, unknown>)[
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

  it("(c) malformed record (post-migration parse fails) degrades the column to null in memory, loud-logs, and preserves the original on disk", () => {
    const malformed = JSON.stringify({
      id: "exec-bad-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: 42,
      status: "running",
      activeContextId: "ctx-a",
      contextStates: {},
      taskStates: {},
      startedAt: "2026-04-04T00:00:00.000Z",
    });
    rawInsertSession(malformed);

    const out = repo.findByKey(PROJECT_PATH, SESSION_NAME);
    expect(out).not.toBeNull();
    expect(out?.graphWorkflowExecution).toBeNull();

    const quarantineLogs = capturedLogs.filter(
      (e) =>
        e.level === "error" &&
        e.message === "state-store.sessions.column_quarantined",
    );
    expect(quarantineLogs).toHaveLength(1);
    expect(quarantineLogs[0]?.data).toMatchObject({
      column: "graphWorkflowExecution",
    });

    const onDisk = readGraphWorkflowExecutionColumn();
    expect(onDisk).toBe(malformed);
  });

  it("(d) new-schema record with a legitimately running context passes through untouched (no migration on every read mid-execution)", () => {
    const runningJson = JSON.stringify({
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
    });
    rawInsertSession(runningJson);

    const before = readGraphWorkflowExecutionColumn();
    const session = repo.findByKey(PROJECT_PATH, SESSION_NAME);
    const after = readGraphWorkflowExecutionColumn();

    expect(session?.graphWorkflowExecution?.id).toBe("exec-running-1");
    expect(session?.graphWorkflowExecution?.status).toBe("running");
    expect(session?.graphWorkflowExecution?.activeContextIds).toEqual([
      "ctx-a",
    ]);
    expect(
      session?.graphWorkflowExecution?.contextStates["ctx-a"]?.status,
    ).toBe("running");
    expect(before).toBe(after);

    const migrationEvents = capturedLogs.filter(
      (e) => e.message === "graph-workflow.parallel.legacy_migrated",
    );
    expect(migrationEvents).toHaveLength(0);
  });

  it("legacy detection happens on the raw object (legacy field present) before zod-strip would silently drop it", () => {
    rawInsertSession(buildLegacyExecutionJson());

    const session = repo.findByKey(PROJECT_PATH, SESSION_NAME);
    expect(session?.graphWorkflowExecution?.activeContextIds).toEqual([]);

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
    const flatLanesJson = JSON.stringify({
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
    });
    rawInsertSession(flatLanesJson);

    const session = repo.findByKey(PROJECT_PATH, SESSION_NAME);
    const exec = session?.graphWorkflowExecution;
    expect(exec).not.toBeNull();
    if (!exec) return;

    expect(exec.laneStates).toEqual({
      "execution-loop-fan-out-fan-in": {
        context_validator: expect.objectContaining({
          engine: "codex",
          lane: "context_validator",
        }),
        implementer: expect.objectContaining({
          engine: "claude",
          lane: "implementer",
        }),
      },
    });

    const onDisk = readGraphWorkflowExecutionColumn();
    expect(onDisk).not.toBeNull();
    if (!onDisk) return;
    const onDiskParsed = JSON.parse(onDisk) as Record<string, unknown>;
    const onDiskLanes = onDiskParsed.laneStates as Record<string, unknown>;
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
