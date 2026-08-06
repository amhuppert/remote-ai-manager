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
import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  validateJsonSchemaSubset,
  validateOutputSchemaDeclaration,
} from "@/lib/workflows/primitives/output-schema-subset";

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
  // Alongside the "supported" implementer lane, carry TWO validator lanes for
  // one context — a cohort of two assignments of the same profile. They pin the
  // widened `laneStates` inner key (`context_validator:<assignmentId>`) and the
  // per-lane assignment identity through the real SQLite/Zod round-trip; the
  // first also carries "metrics_unavailable", the honest label for a turn with
  // no occupancy metrics under a configured limit.
  const validatorLane = (
    assignmentId: string,
    conversationId: string,
    limitEvaluation: GraphWorkflowAgentSessionState["limitEvaluation"],
  ): GraphWorkflowAgentSessionState => ({
    backend: "claude",
    refKind: "conversation",
    lane: "context_validator",
    contextId: "ctx-1",
    assignmentId,
    assignmentFingerprint: `sha256:${"b".repeat(64)}|conversation|true||claude|sonnet|medium`,
    workflowConversationId: conversationId,
    sessionRef: { backend: "claude", ref: conversationId },
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation,
    lastUsedAt: "2026-01-02T02:30:00Z",
  });
  return graphWorkflowExecutionSchema.parse({
    ...base,
    laneStates: {
      ...base.laneStates,
      "ctx-1": {
        ...base.laneStates["ctx-1"],
        [laneStateKey("context_validator", "general")]: validatorLane(
          "general",
          "conv-lane-2",
          "metrics_unavailable",
        ),
        [laneStateKey("context_validator", "security-reviewer")]: validatorLane(
          "security-reviewer",
          "conv-lane-3",
          "supported",
        ),
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

  it("carries the attributed validator infrastructure halt in the maximal SQLite fixture", () => {
    const execution = maximalExecution();
    repo.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      execution,
      "2026-03-01T00:00:00Z",
    );

    const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(
      reloaded?.secondaryHaltReasons.find(
        (reason) => reason.type === "validator_infra_error",
      ),
    ).toEqual({
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "claude",
      infraReason: "never_admitted",
      message: "The query semaphore never admitted security-reviewer.",
      summary: "security-reviewer was never heard in round 4.",
      assignmentId: "security-reviewer",
      attempts: 3,
      roundSeq: 4,
    });
  });
});

describe("graph-workflow-executions-repo captured context outputs", () => {
  // R4.1: the captured structured output is durable state, not an in-memory
  // convenience. The real persistence fixture supplies the production DDL and
  // the real FK-parent repositories, and the reload runs through a repo
  // instance that never saw the write, so nothing but the SQLite row can
  // satisfy the assertion.
  it("round-trips a non-trivial per-context structured output through setActive -> getActive", () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      // The maximal fixture's own captured output — one definition of the
      // payload, shared with the durability harness, so the two cannot drift.
      const execution = maximalExecution();
      const captured = execution.contextOutputs["ctx-1"];
      if (captured === undefined) throw new Error("fixture output missing");

      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        execution,
        "2026-03-01T00:00:00Z",
      );

      // A repo instance that never saw the write has no parsed-row cache to
      // answer from — this is the post-restart read.
      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      expect(reloaded?.contextOutputs["ctx-1"]).toEqual(captured);
      // Spot-check the nested payload survives whole: a dropped array element or
      // a null coerced to undefined would still satisfy a shallow key check.
      const value = reloaded?.contextOutputs["ctx-1"]?.value;
      expect(value).toMatchObject({
        verdict: "pass",
        taskValidation: "reviewed",
        score: 0.94,
        followUp: null,
      });
      expect(value?.["findings"]).toEqual([
        {
          id: "f-1",
          severity: "high",
          file: "src/lib/foo.ts",
          line: 42,
          tags: ["perf", "api"],
        },
      ]);

      // The reloaded payload is still an ACCEPTED output for its context — the
      // round-trip preserved conformance, not just bytes.
      const authored = execution.workingDefinition.executionContexts.find(
        (context) => context.id === "ctx-1",
      )?.outputSchema;
      if (authored === undefined) throw new Error("ctx-1 outputSchema missing");
      expect(validateJsonSchemaSubset(authored, value)).toEqual({
        valid: true,
      });
    } finally {
      fixture.close();
    }
  });

  // D5 admits only successfully validated candidates into contextOutputs —
  // rejected ones live in the validation-failure records. A durability fixture
  // is evidence about a real persisted state, so an entry its own context's
  // authored schema would reject proves nothing about a state the engine can
  // reach. Checked against the canonical validator rather than by eye, and over
  // EVERY entry, so it keeps holding as fixtures grow.
  it("only carries context outputs their own context's authored outputSchema accepts", () => {
    const execution = maximalExecution();
    const entries = Object.entries(execution.contextOutputs);
    expect(
      entries.length,
      "the maximal fixture must carry at least one captured output",
    ).toBeGreaterThan(0);

    for (const [contextId, output] of entries) {
      const authored = execution.workingDefinition.executionContexts.find(
        (context) => context.id === contextId,
      )?.outputSchema;
      expect(
        authored,
        `${contextId} has a captured output, so it must declare an outputSchema`,
      ).toBeDefined();
      if (authored === undefined) continue;
      // The declaration itself must be inside the supported subset, or the
      // acceptance below would be vacuous (unenforced keywords silently pass).
      expect(
        validateOutputSchemaDeclaration(authored),
        `${contextId} outputSchema must be a legal declaration`,
      ).toEqual([]);
      expect(
        validateJsonSchemaSubset(authored, output.value),
        `${contextId} captured output must be accepted by its authored schema`,
      ).toEqual({ valid: true });
    }
  });

  it("admits a pre-feature row with no contextOutputs via the additive default of {}", () => {
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
      Object.keys(runtime.contextOutputs as Record<string, unknown>).length > 0,
      "fixture must persist a non-default contextOutputs map",
    ).toBe(true);
    delete runtime.contextOutputs;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.contextOutputs).toEqual({});
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
    expect(ctx?.pendingUserInputs).toEqual(
      execution.contextStates["ctx-1"]?.pendingUserInputs,
    );
    expect(
      ctx?.pendingUserInputs["context_validator:security-reviewer"]?.answers
        ?.byQuestionId["q-1"]?.selected,
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

  it("admits a pre-feature row with no charterAmendments via the additive default of []", () => {
    // Write a normal execution, then strip `charterAmendments` from the stored
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
      Array.isArray(runtime.charterAmendments) &&
        runtime.charterAmendments.length > 0,
      "fixture must persist a non-default charterAmendments log",
    ).toBe(true);
    delete runtime.charterAmendments;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    // A fresh repo instance bypasses the parsed-row cache, decoding the edited
    // row; the schema's `.default([])` admits the legacy shape.
    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.charterAmendments).toEqual([]);
  });

  it("admits a pre-D1 row with no planRepairRounds via the additive default of []", () => {
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
      Array.isArray(runtime.planRepairRounds) &&
        runtime.planRepairRounds.length > 0,
      "fixture must persist a non-default planRepairRounds log",
    ).toBe(true);
    delete runtime.planRepairRounds;
    db.prepare(
      `UPDATE graph_workflow_executions SET runtime_json = ?
        WHERE project_path = ? AND session_name = ?`,
    ).run(JSON.stringify(runtime), PROJECT_PATH, SESSION_NAME);

    const freshRepo = createGraphWorkflowExecutionsRepo(db);
    const loaded = freshRepo.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded?.planRepairRounds).toEqual([]);
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
