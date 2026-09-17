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

function buildCleanExecution(): GraphWorkflowExecution {
  return {
    id: "exec-clean-1",
    origin: {
      kind: "template",
      definitionId: "seed-1",
      definitionRevision: 1,
      tier: "project",
    },
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    launchDocument: null,
    liveSessionReadOnlyPinned: false,
    abandonment: null,
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
    ownerConversationId: null,
    definitionApproval: null,
    definitionApprovalClaim: null,
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
    laneReservations: {},
    joins: {},
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

/** Store raw merged tiers to exercise validation without the writer's parse. */
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

describe("graph-workflow-executions-repo read validation", () => {
  it("clean record passes through untouched without re-persisting", () => {
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
  });

  it("loads a lane row that still carries the retired ignored-content baseline", () => {
    rawInsertExecution({
      ...buildCleanExecution(),
      executionLanes: {
        "lane-1": {
          laneId: "lane-1",
          kind: "worktree",
          status: "active",
          worktreePath: "/wt/lane-1",
          branchName: "csm/lane-1",
          includedContextIds: ["ctx-a"],
          lastCommittingContextId: null,
          commitSnapshots: [],
          ignoredBaseline: [
            { path: "node_modules", digest: "digest-node-modules" },
          ],
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      },
    });

    const lane = repo.getActive(PROJECT_PATH, SESSION_NAME)?.executionLanes[
      "lane-1"
    ];

    expect(lane?.branchName).toBe("csm/lane-1");
    expect(lane).not.toHaveProperty("ignoredBaseline");
  });

  it("loads a candidate_unstable halt stored before it carried an incident kind or a repair verdict", () => {
    rawInsertExecution({
      ...buildCleanExecution(),
      status: "halted",
      haltReason: {
        type: "candidate_unstable",
        contextId: "ctx-a",
        stage: "post_script",
        driftedComponents: "candidateTreeHash",
        consecutiveCount: 5,
        message: "the reviewed candidate kept moving",
      },
    });

    const halt = repo.getActive(PROJECT_PATH, SESSION_NAME)?.haltReason;

    expect(halt?.type).toBe("candidate_unstable");
    if (halt?.type !== "candidate_unstable") return;
    // Every stored row of this kind was written by the moved-candidate path,
    // so the default is the one claim those rows' own message already makes.
    expect(halt.lastIncident).toBe("candidate_mismatch");
    // Nothing has spoken about the halt: repair could not write a verdict onto
    // this variant when the row was stored.
    expect(halt.summary).toBeNull();
  });

  it("malformed record throws (fail-loud) and preserves the original on disk", () => {
    const malformed = {
      id: "exec-bad-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: 42,
      status: "running",
      activeContextIds: ["ctx-a"],
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

  it("running context passes through untouched", () => {
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
      laneReservations: {},
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
  });
});
