import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowExecutionsRepo,
  splitExecution,
  DEFINITION_TIER_KEYS,
  RUNTIME_TIER_KEYS,
  type GraphWorkflowExecutionsRepo,
} from "./graph-workflow-executions-repo";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

let db: Db;
let repo: GraphWorkflowExecutionsRepo;

function seedSession(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function maximalExecution(): GraphWorkflowExecution {
  const base = graphWorkflowExecutionSchema.parse(
    buildMaximalGraphWorkflowExecution(),
  );
  // Alongside the "supported" implementer lane, carry a Claude validator lane
  // that ran a turn without occupancy metrics under a configured limit. Its
  // honest label is "metrics_unavailable"; keeping it here proves the widened
  // enum value survives the SQLite/Zod round-trip through the real repo.
  const validatorLane: GraphWorkflowAgentSessionState = {
    backend: "claude",
    refKind: "conversation",
    lane: "context_validator",
    contextId: "ctx-1",
    workflowConversationId: "conv-lane-2",
    sessionRef: { backend: "claude", ref: "conv-lane-2" },
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation: "metrics_unavailable",
    lastUsedAt: "2026-01-02T02:30:00Z",
  };
  return graphWorkflowExecutionSchema.parse({
    ...base,
    laneStates: {
      ...base.laneStates,
      "ctx-1": {
        ...base.laneStates["ctx-1"],
        context_validator: validatorLane,
      },
    },
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedSession();
  repo = createGraphWorkflowExecutionsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("graph-workflow-executions split symmetry", () => {
  it("assigns every top-level execution key to exactly one tier", () => {
    const allKeys = Object.keys(graphWorkflowExecutionSchema.shape).sort();
    const definitionKeys: string[] = [...DEFINITION_TIER_KEYS];
    const runtimeKeys: string[] = [...RUNTIME_TIER_KEYS];

    const overlap = definitionKeys.filter((k) => runtimeKeys.includes(k));
    expect(overlap, "a key must not appear in both tiers").toEqual([]);

    const union = [...definitionKeys, ...runtimeKeys].sort();
    expect(
      union,
      "union of definition+runtime tier keys must exactly equal the schema keys (no field unassigned, none duplicated)",
    ).toEqual(allKeys);
  });

  it("round-trips a maximal execution through splitExecution + JSON merge losslessly", () => {
    const execution = maximalExecution();
    const split = splitExecution(execution);
    const merged = {
      ...(JSON.parse(split.definitionJson) as Record<string, unknown>),
      ...(JSON.parse(split.runtimeJson) as Record<string, unknown>),
    };
    expect(graphWorkflowExecutionSchema.parse(merged)).toEqual(execution);
  });
});

describe("graph-workflow-executions-repo durability contract", () => {
  it("round-trips every persisted execution key path through setActive -> getActive", async () => {
    await assertRoundTripDurability({
      label: "graph-workflow-executions",
      schema: graphWorkflowExecutionSchema,
      buildMaximalFixture: maximalExecution,
      persist: (fixture) => {
        repo.setActive(
          PROJECT_PATH,
          SESSION_NAME,
          fixture,
          "2026-03-01T00:00:00Z",
        );
        return fixture;
      },
      reload: () => repo.getActive(PROJECT_PATH, SESSION_NAME),
    });
  });
});

describe("graph-workflow-executions-repo behavior", () => {
  it("returns null when no active execution exists", () => {
    expect(repo.getActive(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("round-trips the awaiting_user_input status and a populated pendingUserInput record", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    // A fresh repo instance bypasses the parsed-row cache so the read decodes
    // the persisted blob rather than returning the in-memory object.
    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const ctx = reloaded?.contextStates["ctx-1"];
    expect(ctx?.status).toBe("awaiting_user_input");
    expect(ctx?.pendingUserInput).toEqual(
      execution.contextStates["ctx-1"]?.pendingUserInput,
    );
    expect(
      ctx?.pendingUserInput?.answers?.byQuestionId["q-1"]?.selected,
    ).toEqual(["Redis"]);
  });

  it("deletes the active row on setActive(null)", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    expect(repo.getActive(PROJECT_PATH, SESSION_NAME)).not.toBeNull();

    const removed = repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      null,
      "2026-03-02T00:00:00Z",
    );
    expect(removed).toBe(true);
    expect(repo.getActive(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("rewrites runtime-only when the definition tier is unchanged but the runtime changes", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const definitionBefore = db
      .prepare(
        `SELECT definition_json, runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as {
      definition_json: string;
      runtime_json: string;
    };

    // Mutate only a runtime-tier field; the definition tier is byte-identical.
    const next = graphWorkflowExecutionSchema.parse({
      ...execution,
      status: "completed",
      completedAt: "2026-03-05T00:00:00Z",
    });
    repo.setActive(PROJECT_PATH, SESSION_NAME, next, "2026-03-02T00:00:00Z");

    const after = db
      .prepare(
        `SELECT definition_json, runtime_json, status, completed_at
           FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as {
      definition_json: string;
      runtime_json: string;
      status: string;
      completed_at: string | null;
    };

    expect(after.definition_json).toBe(definitionBefore.definition_json);
    expect(after.runtime_json).not.toBe(definitionBefore.runtime_json);
    expect(after.status).toBe("completed");
    expect(after.completed_at).toBe("2026-03-05T00:00:00Z");

    const reloaded = repo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.completedAt).toBe("2026-03-05T00:00:00Z");
  });

  it("admits a pre-feature row with no bound-input snapshot via the additive default", () => {
    // Write a normal execution, then strip `boundInputs` from the stored
    // definition tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const definition = JSON.parse(row.definition_json) as Record<
      string,
      unknown
    >;
    expect(definition.boundInputs, "fixture must persist boundInputs").toEqual({
      feature: "search box",
      notes: "first line\nsecond line",
    });
    delete definition.boundInputs;
    db.prepare(
      `UPDATE graph_workflow_executions SET definition_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(definition), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default({})` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.boundInputs).toEqual({});
  });

  it("admits a pre-feature row with no launched-tier via the additive 'project' default", () => {
    // Write a normal execution, then strip `launchedTier` from the stored
    // definition tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const definition = JSON.parse(row.definition_json) as Record<
      string,
      unknown
    >;
    expect(
      definition.launchedTier,
      "fixture must persist a non-default launchedTier",
    ).toBe("global");
    delete definition.launchedTier;
    db.prepare(
      `UPDATE graph_workflow_executions SET definition_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(definition), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default("project")` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.launchedTier).toBe("project");
  });

  it("admits a pre-feature row with no liveRevision via the additive default of 1", () => {
    // Write a normal execution, then strip `liveRevision` from the stored
    // runtime tier to simulate a row persisted before the field existed.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const row = db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { runtime_json: string };
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    expect(
      runtime.liveRevision,
      "fixture must persist a non-default liveRevision",
    ).toBe(4);
    delete runtime.liveRevision;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default(1)` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.liveRevision).toBe(1);
  });

  it("recreates the row via a full upsert when the runtime-only UPDATE matches zero rows", () => {
    const execution = maximalExecution();
    // First write warms the per-instance definition-hash cache.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    // Delete the row out-of-band WITHOUT going through setActive(null), so the
    // hash cache still believes the (unchanged) definition is already on disk.
    db.prepare(
      `DELETE FROM graph_workflow_executions
        WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, SESSION_NAME);

    // A re-write with the SAME definition tier takes the runtime-only UPDATE
    // path (hash matches). Without the defensive fallback the UPDATE would
    // match 0 rows and the execution would be lost while events accumulate.
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-02T00:00:00Z",
    );

    const row = db
      .prepare(
        `SELECT execution_id, definition_json, runtime_json
           FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as
      | { execution_id: string; definition_json: string; runtime_json: string }
      | undefined;
    expect(row, "row must be recreated, not silently dropped").toBeDefined();
    expect(row?.execution_id).toBe(execution.id);

    // The merged read reconstructs the full execution from the recreated row.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    expect(freshRepo.getActive(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      execution.id,
    );
  });

  it("bumps cacheVersion on every write", () => {
    const v0 = repo.cacheVersion;
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    const v1 = repo.cacheVersion;
    expect(v1).toBeGreaterThan(v0);
    repo.setActive(PROJECT_PATH, SESSION_NAME, null, "2026-03-02T00:00:00Z");
    expect(repo.cacheVersion).toBeGreaterThan(v1);
  });

  it("lists active executions across sessions keyed by project+session", () => {
    db.prepare(
      `INSERT INTO sessions (
         project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "s2",
      `${PROJECT_PATH}/.worktrees/s2`,
      "csm/s2",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    repo.setActive(
      PROJECT_PATH,
      "s2",
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );

    const all = repo.listActive();
    expect(all.size).toBe(2);
    const SEP = String.fromCharCode(0);
    expect(all.get(`${PROJECT_PATH}${SEP}${SESSION_NAME}`)?.id).toBe(
      "wf-maximal",
    );
    expect(all.get(`${PROJECT_PATH}${SEP}s2`)?.id).toBe("wf-maximal");
  });

  it("quarantines a corrupt runtime_json blob on read", () => {
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      maximalExecution(),
      "2026-03-01T00:00:00Z",
    );
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run("{not valid json", PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the in-memory parsed-row cache so the read
    // actually hits the corrupt blob.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    expect(() => freshRepo.getActive(PROJECT_PATH, SESSION_NAME)).toThrow();
  });
});
