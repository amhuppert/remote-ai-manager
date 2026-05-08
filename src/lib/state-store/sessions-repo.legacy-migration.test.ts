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
import { PersistenceError } from "../errors";
import type { GraphWorkflowExecution } from "@/types";

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
    machineSnapshot: null,
    startedAt: "2026-04-04T00:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
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
    status: "paused",
    activeContextIds: [],
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    laneStates: {},
    machineSnapshot: null,
    history: [],
    startedAt: "2026-04-04T00:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
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

  it("(c) malformed record (post-migration parse fails) preserves the original on disk and raises a typed load error", () => {
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

    expect(() => repo.findByKey(PROJECT_PATH, SESSION_NAME)).toThrow(
      PersistenceError,
    );
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
});
