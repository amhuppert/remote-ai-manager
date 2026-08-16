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

import {
  SpecExecutionBindingMismatchError,
  SpecExecutionBindingNotFoundError,
  type SpecExecutionBindingSnapshotV2,
} from "@/lib/specs/execution-binding";
import { createSpecExecutionBindingPorts } from "@/lib/specs/execution-binding-service";
import { PersistenceError } from "@/lib/shared/errors";
import { _createTestDb } from "./state-db";
import { createSpecExecutionBindingRepo } from "./spec-execution-binding-repo";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-binding-v2";
const REVISION_ID = "revision-binding-v2";
const SPEC_EXECUTION_ID = "spec-execution-binding-v2";
const WORKFLOW_EXECUTION_ID = "workflow-execution-binding-v2";

let db: Db;

function binding(): SpecExecutionBindingSnapshotV2 {
  return {
    schemaVersion: 2,
    candidateId: "candidate-binding-v2",
    candidateHash: `sha256:${"a".repeat(64)}`,
    pinnedRevisionId: REVISION_ID,
    dispositions: [
      {
        criterionElementId: "criterion-selected",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-deferred",
        disposition: "deferred",
        deliveredByExecutionId: null,
      },
    ],
    claims: [
      {
        contextId: "implement-api",
        criterionElementIds: ["criterion-selected"],
      },
    ],
  };
}

function seedParents(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repo/binding-v2",
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    "/repo/binding-v2",
    "binding-v2",
    "Binding v2",
    '{"preset":"contract-bearing"}',
    "2026-08-15T12:00:00.000Z",
    "2026-08-15T12:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(REVISION_ID, SPEC_ID, 1, "approved", "2026-08-15T12:00:00.000Z");
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_execution_id,
       session_name, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    "{}",
    "definition_review",
    null,
    "session-binding-v2",
    "2026-08-15T12:01:00.000Z",
    "2026-08-15T12:01:00.000Z",
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedParents();
});

afterEach(() => {
  db.close();
});

describe("version-2 spec execution binding repository", () => {
  it("round-trips one immutable typed link and frozen binding by workflow execution id", () => {
    const repo = createSpecExecutionBindingRepo(db);
    const created = repo.insert({
      specExecutionId: SPEC_EXECUTION_ID,
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      binding: binding(),
      createdAt: "2026-08-15T12:02:00.000Z",
    });

    expect(created).toEqual({
      specExecutionId: SPEC_EXECUTION_ID,
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      binding: binding(),
      createdAt: "2026-08-15T12:02:00.000Z",
    });
    expect(repo.findByWorkflowExecutionId(WORKFLOW_EXECUTION_ID)).toEqual(
      created,
    );
    expect(repo.findBySpecExecutionId(SPEC_EXECUTION_ID)).toEqual(created);

    const ports = createSpecExecutionBindingPorts(repo);
    for (const port of [
      ports.executionContract,
      ports.prompts,
      ports.liveEdits,
      ports.delivery,
    ]) {
      expect(port.resolveByWorkflowExecutionId(WORKFLOW_EXECUTION_ID)).toEqual(
        created,
      );
    }
    expect(
      ports.executionContract.resolveByWorkflowExecutionId(
        "workflow-execution-unbound",
      ),
    ).toBeNull();
    expect(() =>
      ports.liveEdits.resolveByWorkflowExecutionId(
        "workflow-execution-unbound",
        { specExecutionId: SPEC_EXECUTION_ID },
      ),
    ).toThrow(SpecExecutionBindingNotFoundError);

    expect(() =>
      db
        .prepare(
          `UPDATE spec_execution_bindings
              SET binding_json = ?
            WHERE spec_execution_id = ?`,
        )
        .run(JSON.stringify({ ...binding(), claims: [] }), SPEC_EXECUTION_ID),
    ).toThrow(/immutable/i);
  });

  it("refuses duplicate spec and workflow linkage", () => {
    const repo = createSpecExecutionBindingRepo(db);
    repo.insert({
      specExecutionId: SPEC_EXECUTION_ID,
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      binding: binding(),
      createdAt: "2026-08-15T12:02:00.000Z",
    });

    expect(() =>
      repo.insert({
        specExecutionId: SPEC_EXECUTION_ID,
        workflowExecutionId: "workflow-execution-other",
        binding: binding(),
        createdAt: "2026-08-15T12:03:00.000Z",
      }),
    ).toThrow(/unique|primary key/i);

    db.prepare(
      `INSERT INTO spec_executions (
         id, spec_id, revision_id, scope_json, state, workflow_execution_id,
         session_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "spec-execution-other",
      SPEC_ID,
      REVISION_ID,
      "{}",
      "definition_review",
      null,
      "session-binding-v2",
      "2026-08-15T12:03:00.000Z",
      "2026-08-15T12:03:00.000Z",
    );
    expect(() =>
      repo.insert({
        specExecutionId: "spec-execution-other",
        workflowExecutionId: WORKFLOW_EXECUTION_ID,
        binding: binding(),
        createdAt: "2026-08-15T12:03:00.000Z",
      }),
    ).toThrow(/unique/i);
  });

  it("fails closed when a spec execution points at a workflow with no binding row", () => {
    const repo = createSpecExecutionBindingRepo(db);
    db.prepare(
      "UPDATE spec_executions SET workflow_execution_id = ? WHERE id = ?",
    ).run(WORKFLOW_EXECUTION_ID, SPEC_EXECUTION_ID);

    expect(() => repo.findByWorkflowExecutionId(WORKFLOW_EXECUTION_ID)).toThrow(
      SpecExecutionBindingNotFoundError,
    );
  });

  it("fails closed for missing, malformed, cross-execution, and cross-candidate linkage", () => {
    const repo = createSpecExecutionBindingRepo(db);
    repo.insert({
      specExecutionId: SPEC_EXECUTION_ID,
      workflowExecutionId: WORKFLOW_EXECUTION_ID,
      binding: binding(),
      createdAt: "2026-08-15T12:02:00.000Z",
    });

    expect(() =>
      repo.requireByWorkflowExecutionId("workflow-execution-missing"),
    ).toThrow(SpecExecutionBindingNotFoundError);
    expect(() =>
      repo.requireByWorkflowExecutionId(WORKFLOW_EXECUTION_ID, {
        specExecutionId: "spec-execution-other",
      }),
    ).toThrow(SpecExecutionBindingMismatchError);
    expect(() =>
      repo.requireByWorkflowExecutionId(WORKFLOW_EXECUTION_ID, {
        candidateId: "candidate-other",
      }),
    ).toThrow(SpecExecutionBindingMismatchError);
    expect(() =>
      repo.requireByWorkflowExecutionId(WORKFLOW_EXECUTION_ID, {
        candidateHash: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow(SpecExecutionBindingMismatchError);

    db.exec("DROP TRIGGER spec_execution_bindings_immutable");
    db.prepare(
      `UPDATE spec_execution_bindings
          SET binding_json = ?
        WHERE spec_execution_id = ?`,
    ).run('{"schemaVersion":2,"candidateId":7}', SPEC_EXECUTION_ID);
    expect(() =>
      repo.requireByWorkflowExecutionId(WORKFLOW_EXECUTION_ID),
    ).toThrow(PersistenceError);
  });
});
