import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { listActiveSpecExecutionsFromDeps } from "./active-executions";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/active-executions";
const SPEC_ID = "spec-active-executions";
const REVISION_ID = "revision-approved";
const NOW = "2026-07-19T09:00:00.000Z";

describe("listActiveSpecExecutionsFromDeps", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seedSpec(db);
  });

  function listItems() {
    const deliveryRepo = createSpecDeliveryRepo(db);
    const specsRepo = createSpecsRepo(db, createWriteQueue());
    return listActiveSpecExecutionsFromDeps({
      listActiveExecutions: () => deliveryRepo.listActiveExecutions(),
      findSpecById: (specId) => specsRepo.findById(specId),
      getProjectDisplayName: (projectPath) =>
        projectPath.split("/").at(-1) ?? projectPath,
    });
  }

  it("returns only definition_review/running executions joined with spec identity", async () => {
    insertExecution(db, "execution-review", "definition_review", "spec-work");
    insertExecution(db, "execution-running", "running", null);
    insertExecution(db, "execution-delivered", "delivered", "spec-work");
    insertExecution(db, "execution-abandoned", "abandoned", "spec-work");

    const items = await listItems();

    expect(items).toEqual([
      {
        executionId: "execution-review",
        state: "definition_review",
        specSlug: "active-executions",
        specName: "Active Executions",
        projectPath: PROJECT_PATH,
        projectName: "active-executions",
        sessionName: "spec-work",
        createdAt: NOW,
      },
      {
        executionId: "execution-running",
        state: "running",
        specSlug: "active-executions",
        specName: "Active Executions",
        projectPath: PROJECT_PATH,
        projectName: "active-executions",
        sessionName: "main",
        createdAt: NOW,
      },
    ]);
  });

  it("drops executions of abandoned specs", async () => {
    insertExecution(db, "execution-running", "running", "spec-work");
    db.prepare(
      "UPDATE specs SET abandoned_at = ?, abandoned_reason = ? WHERE id = ?",
    ).run(NOW, "Terminal decision.", SPEC_ID);

    expect(await listItems()).toEqual([]);
  });
});

function seedSpec(db: Db): void {
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "active-executions",
    "Active Executions",
    '{"preset":"contract-bearing"}',
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', NULL, 'hash-1', ?, ?, ?)`,
  ).run(REVISION_ID, SPEC_ID, NOW, NOW, NOW);
}

function insertExecution(
  db: Db,
  id: string,
  state: string,
  sessionName: string | null,
): void {
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'workflow-definition-1', NULL, ?,
       ?, ?, ?, ?)`,
  ).run(
    id,
    SPEC_ID,
    REVISION_ID,
    '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
    state,
    sessionName,
    state === "delivered" ? NOW : null,
    state === "abandoned" ? "No longer needed." : null,
    NOW,
    NOW,
  );
}
