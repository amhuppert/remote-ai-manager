import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectSameBytes } from "@/lib/shared/testing/same-bytes";
import Database from "better-sqlite3";

import { _createTestDb, _createTestDbAtPath } from "../state-db";
import { runMigrations } from "../migrator";
import {
  computeSpecRevisionCitationHash,
  computeSpecRevisionContentHashFromCanonical,
} from "../specs-repo";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";
import {
  inspectNativeSddV2Cutover,
  NATIVE_SDD_V2_CUTOVER_MANIFEST_FILE_NAME,
  nativeSddV2Cutover,
  NativeSddV2CutoverActiveExecutionError,
  runNativeSddV2Cutover,
  runNativeSddV2CutoverBeforeStateDbOpen,
  type NativeSddV2CutoverCounts,
  type NativeSddV2CutoverFailurePoint,
} from "./0030-native-sdd-v2-cutover";
import { migrations } from "./index";

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

// Every case here builds a real on-disk fixture — a temp dir, a fully migrated
// SQLite database, seeded relational artifacts and workflow definition files —
// and most then serialize or byte-compare the database around a cutover. That
// is real filesystem and SQLite work rather than the in-memory unit work the
// 15s project default is sized for, so a full-suite run competing for disk can
// push a single case past it while it still passes in seconds on its own.
vi.setConfig({ testTimeout: 60_000 });

type Db = InstanceType<typeof Database>;
type LinkedActiveStatus = "pending" | "running" | "paused" | "halted";
type FixtureGraphStatus = LinkedActiveStatus | "completed" | "aborted";

const PROJECT_PATH = "/repos/native-sdd-cutover";
const SPEC_ID = "spec-cutover-preservable";
const REVISION_ID = "revision-cutover-approved";
const ACTIVE_SPEC_EXECUTION_ID = "spec-execution-active";
const ACTIVE_WORKFLOW_EXECUTION_ID = "workflow-execution-active";
const COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID =
  "workflow-execution-completed-sample";
const COMPLETED_SAMPLE_SPEC_EXECUTION_ID = "spec-execution-completed-sample";
const ABANDONED_SPEC_EXECUTION_ID = "spec-execution-abandoned";
const ATTEMPT_ID = "attempt-legacy";
const MERGE_JOB_ID = "job-legacy-merge";
const SNAPSHOT_ID = "snapshot-legacy";
const CANDIDATE_ID = "candidate-legacy";
const TIMESTAMP = "2026-08-15T12:00:00.000Z";
const SAMPLE_LIMIT = 20;
const EMPTY_PLAN_CONTENT_HASH = computeSpecRevisionContentHashFromCanonical(
  "plan",
  [],
);
const EMPTY_LEGACY_CITATION_HASH = computeSpecRevisionCitationHash(1, []);

const EMPTY_COUNTS: NativeSddV2CutoverCounts = {
  activeGraphExecutions: 0,
  archivedGraphExecutions: 0,
  candidates: 0,
  compiledDefinitions: 0,
  deliveryEvents: 0,
  deliveryVerdicts: 0,
  discoveries: 0,
  dispositions: 0,
  evidence: 0,
  gateAdmissions: 0,
  graphEvents: 0,
  legacyAttempts: 0,
  legacyDefinitionFiles: 0,
  legacyDefinitionOrigins: 0,
  legacySpecExecutions: 0,
  planApprovals: 0,
  planComments: 0,
  proofVerdicts: 0,
  resumableActiveGraphExecutions: 0,
  savedDefinitions: 0,
  snapshots: 0,
  specLinks: 0,
  taskClaims: 0,
};

const PRECOMMIT_FAILURE_POINTS: readonly NativeSddV2CutoverFailurePoint[] = [
  "before_manifest_create",
  "after_manifest_create",
  "before_definition_rename:0",
  "after_definition_rename:0",
  "before_definition_rename:1",
  "after_definition_rename:1",
  "before_definition_rename:2",
  "after_definition_rename:2",
  "before_definition_rename:3",
  "after_definition_rename:3",
  "before_sqlite_begin",
  "after_sqlite_begin",
  "before_relational_delete",
  "after_relational_delete",
  "before_postcondition_assert",
  "after_postcondition_assert",
  "before_sqlite_commit",
];

const POSTCOMMIT_FAILURE_POINTS: readonly NativeSddV2CutoverFailurePoint[] = [
  "after_sqlite_commit",
  "before_quarantine_cleanup",
  "after_quarantine_cleanup",
  "before_completion_mark",
  "after_completion_mark",
];

interface CutoverFixture {
  readonly configDir: string;
  readonly db: Db;
  readonly workflowFiles: Readonly<{
    compiledGlobal: string;
    compiledProject: string;
    savedGlobal: string;
    savedProject: string;
    safeGlobal: string;
    safeProject: string;
    safeGlobalIdCollision: string;
    safeProjectIdCollision: string;
  }>;
}

interface ManagedFixture {
  readonly configDir: string;
  readonly db: Db;
}

const fixtures: ManagedFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture?.db.open) fixture.db.close();
    if (fixture !== undefined) {
      rmSync(fixture.configDir, { recursive: true, force: true });
    }
  }
  vi.clearAllMocks();
});

function createFixture(status: FixtureGraphStatus): CutoverFixture {
  const configDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-native-sdd-cutover-"),
  );
  const db = _createTestDb({ inMemory: true });
  seedRelationalArtifacts(db, status);
  const workflowFiles = seedWorkflowDefinitions(configDir);
  const fixture = { configDir, db, workflowFiles };
  fixtures.push(fixture);
  return fixture;
}

function createEmptyFixture(): ManagedFixture {
  const configDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-native-sdd-cutover-empty-"),
  );
  const db = _createTestDb({ inMemory: true });
  const fixture = { configDir, db };
  fixtures.push(fixture);
  return fixture;
}

function createFrozenUpgradeFixture(
  status: FixtureGraphStatus,
): CutoverFixture & { readonly dbPath: string } {
  const configDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-native-sdd-cutover-upgrade-"),
  );
  const dbPath = path.join(configDir, "command-center.db");
  const db = _createTestDbAtPath(dbPath);
  seedRelationalArtifacts(db, status);
  const workflowFiles = seedWorkflowDefinitions(configDir);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    DROP TRIGGER IF EXISTS spec_execution_bindings_immutable;
    DROP TABLE spec_execution_bindings;
    DROP TABLE spec_delivery_verdicts;
    DROP INDEX idx_spec_executions_spec_state;
    DROP INDEX uq_spec_executions_workflow_execution;
    ALTER TABLE spec_executions RENAME TO spec_executions_current;
    CREATE TABLE spec_executions (
      id                              TEXT PRIMARY KEY,
      spec_id                         TEXT NOT NULL,
      revision_id                     TEXT NOT NULL,
      scope_json                      TEXT NOT NULL,
      state                           TEXT NOT NULL CHECK (state IN (
        'definition_review', 'running', 'delivered', 'abandoned', 'abandoning'
      )),
      cleanup_phase                   TEXT CHECK (cleanup_phase IN (
        'abort_workflow', 'release_slot', 'finalize'
      )),
      linked_workflow_execution_id    TEXT,
      cleanup_last_error              TEXT,
      cleanup_last_error_at           TEXT,
      execution_start_dial            TEXT CHECK (execution_start_dial IN (
        'gate', 'notify', 'off'
      )),
      workflow_definition_id          TEXT NOT NULL,
      workflow_definition_revision    INTEGER CHECK (
        workflow_definition_revision > 0
      ),
      workflow_execution_id           TEXT,
      session_name                    TEXT,
      delivered_at                    TEXT,
      abandoned_reason                TEXT,
      created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
      FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
    );
    INSERT INTO spec_executions (
      id, spec_id, revision_id, scope_json, state, cleanup_phase,
      linked_workflow_execution_id, cleanup_last_error, cleanup_last_error_at,
      execution_start_dial, workflow_definition_id,
      workflow_definition_revision, workflow_execution_id, session_name,
      delivered_at, abandoned_reason, created_at, updated_at
    ) SELECT
      id, spec_id, revision_id, scope_json, state, cleanup_phase,
      linked_workflow_execution_id, cleanup_last_error, cleanup_last_error_at,
      execution_start_dial,
      COALESCE(workflow_definition_id, 'legacy-definition-' || id),
      COALESCE(workflow_definition_revision, 1), workflow_execution_id,
      session_name, delivered_at, abandoned_reason, created_at, updated_at
    FROM spec_executions_current;
    DROP TABLE spec_executions_current;
    CREATE INDEX idx_spec_executions_spec_state
      ON spec_executions (spec_id, state, created_at DESC);
    CREATE UNIQUE INDEX uq_spec_executions_workflow_execution
      ON spec_executions (workflow_execution_id)
      WHERE workflow_execution_id IS NOT NULL;
    DROP INDEX idx_spec_delivery_plan_candidates_attempt;
    ALTER TABLE spec_delivery_plan_candidates
      RENAME TO spec_delivery_plan_candidates_current;
    CREATE TABLE spec_delivery_plan_candidates (
      id                        TEXT PRIMARY KEY,
      attempt_id                TEXT NOT NULL,
      snapshot_id               TEXT NOT NULL UNIQUE,
      compiled_definition_hash  TEXT NOT NULL,
      definition_json           TEXT NOT NULL,
      materialized_at           TEXT NOT NULL,
      FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
        ON DELETE CASCADE,
      FOREIGN KEY (snapshot_id) REFERENCES spec_delivery_plan_snapshots(id)
        ON DELETE CASCADE
    );
    INSERT INTO spec_delivery_plan_candidates (
      id, attempt_id, snapshot_id, compiled_definition_hash,
      definition_json, materialized_at
    ) SELECT
      id, attempt_id, snapshot_id, compiled_definition_hash,
      launch_json, materialized_at
    FROM spec_delivery_plan_candidates_current;
    DROP TABLE spec_delivery_plan_candidates_current;
    CREATE INDEX idx_spec_delivery_plan_candidates_attempt
      ON spec_delivery_plan_candidates (attempt_id);
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
  const fixture = { configDir, dbPath, db, workflowFiles };
  fixtures.push(fixture);
  return fixture;
}

/**
 * The pre-cutover delivery-plan storage. The current floor has already dropped
 * the compiled-candidate table and the plan hash beside it, so the fixture has
 * to rebuild exactly the shape a database carried BEFORE this migration ran —
 * otherwise the test would assert the purge against artifacts that no longer
 * exist to purge.
 */
function downgradeDeliveryPlanStorageToLegacy(db: Db): void {
  db.exec(`
    PRAGMA legacy_alter_table = ON;
    DROP INDEX IF EXISTS idx_spec_delivery_plan_snapshots_attempt;
    ALTER TABLE spec_delivery_plan_snapshots
      RENAME TO spec_delivery_plan_snapshots_v2;
    CREATE TABLE spec_delivery_plan_snapshots (
      id                  TEXT PRIMARY KEY,
      attempt_id          TEXT NOT NULL,
      candidate_id        TEXT,
      candidate_hash      TEXT,
      draft_revision      INTEGER NOT NULL CHECK (draft_revision > 0),
      plan_hash           TEXT NOT NULL,
      content_json        TEXT NOT NULL,
      pinned_revision_id  TEXT NOT NULL,
      proposed_at         TEXT NOT NULL,
      proposed_by_json    TEXT NOT NULL,
      UNIQUE (attempt_id, draft_revision),
      FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
        ON DELETE CASCADE
    );
    DROP TABLE spec_delivery_plan_snapshots_v2;
    CREATE INDEX idx_spec_delivery_plan_snapshots_attempt
      ON spec_delivery_plan_snapshots (attempt_id, draft_revision DESC);
    CREATE TABLE spec_delivery_plan_candidates (
      id                        TEXT PRIMARY KEY,
      attempt_id                TEXT NOT NULL,
      snapshot_id               TEXT NOT NULL UNIQUE,
      compiled_definition_hash  TEXT NOT NULL,
      launch_json               TEXT NOT NULL,
      binding_json              TEXT NOT NULL,
      materialized_at           TEXT NOT NULL,
      FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
        ON DELETE CASCADE,
      FOREIGN KEY (snapshot_id) REFERENCES spec_delivery_plan_snapshots(id)
        ON DELETE CASCADE
    );
    CREATE INDEX idx_spec_delivery_plan_candidates_attempt
      ON spec_delivery_plan_candidates (attempt_id);
    PRAGMA legacy_alter_table = OFF;
  `);
}

function seedRelationalArtifacts(db: Db, status: FixtureGraphStatus): void {
  downgradeDeliveryPlanStorageToLegacy(db);
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const insertSession = db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertSession.run(
    PROJECT_PATH,
    "active-session",
    `${PROJECT_PATH}/.worktrees/active-session`,
    "cutover/active",
    TIMESTAMP,
    TIMESTAMP,
  );
  insertSession.run(
    PROJECT_PATH,
    "ordinary-global-session",
    `${PROJECT_PATH}/.worktrees/ordinary-global-session`,
    "ordinary/global-collision",
    TIMESTAMP,
    TIMESTAMP,
  );
  insertSession.run(
    PROJECT_PATH,
    "archived-session",
    `${PROJECT_PATH}/.worktrees/archived-session`,
    "cutover/archived",
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "native-sdd-cutover",
    "Native SDD cutover",
    '{"preset":"contract-bearing"}',
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, content_hash,
       citation_contract_version, citation_hash, proposed_at, approved_at,
       created_at
     ) VALUES (?, ?, 1, 'approved', 'plan', ?, 1, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    EMPTY_PLAN_CONTENT_HASH,
    EMPTY_LEGACY_CITATION_HASH,
    TIMESTAMP,
    TIMESTAMP,
    TIMESTAMP,
  );
  const insertElement = db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  insertElement.run("criterion-cutover", SPEC_ID, "criterion", 1, TIMESTAMP);
  insertElement.run("task-cutover", SPEC_ID, "task", 1, TIMESTAMP);
  const insertExecution = db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, execution_start_dial,
       workflow_definition_id, workflow_definition_revision,
       workflow_seed_source_json, workflow_execution_binding_json,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       cleanup_phase, linked_workflow_execution_id, cleanup_last_error,
       cleanup_last_error_at, created_at, updated_at
     ) VALUES (
       ?, ?, ?, '{}', ?, 'gate', ?, 1, ?, NULL, ?, ?, ?, ?, NULL, NULL,
       NULL, NULL, ?, ?
     )`,
  );
  insertExecution.run(
    ACTIVE_SPEC_EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    "running",
    "legacy-compiled-project",
    JSON.stringify({
      kind: "saved-definition",
      id: "legacy-saved-project",
      revision: 1,
      tier: "project",
    }),
    ACTIVE_WORKFLOW_EXECUTION_ID,
    "active-session",
    null,
    null,
    TIMESTAMP,
    TIMESTAMP,
  );
  insertExecution.run(
    COMPLETED_SAMPLE_SPEC_EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    "delivered",
    "legacy-compiled-global",
    JSON.stringify({
      kind: "saved-definition",
      id: "legacy-saved-global",
      revision: 1,
      tier: "global",
    }),
    COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
    "archived-session",
    TIMESTAMP,
    null,
    TIMESTAMP,
    TIMESTAMP,
  );
  insertExecution.run(
    ABANDONED_SPEC_EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    "abandoned",
    null,
    null,
    null,
    null,
    null,
    "cutover fixture",
    TIMESTAMP,
    TIMESTAMP,
  );

  db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'launched', 3, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    ATTEMPT_ID,
    SPEC_ID,
    REVISION_ID,
    COMPLETED_SAMPLE_SPEC_EXECUTION_ID,
    JSON.stringify({
      contexts: [{ contextId: "legacy-context" }],
      tasks: [{ taskId: "legacy-task" }],
      wiring: [{ criterionId: "criterion-cutover" }],
      proofPlan: [{ criterionId: "criterion-cutover" }],
    }),
    SNAPSHOT_ID,
    JSON.stringify({
      candidateId: CANDIDATE_ID,
      planHash: `sha256:${"2".repeat(64)}`,
      compiledDefinitionHash: `sha256:${"3".repeat(64)}`,
    }),
    ACTIVE_SPEC_EXECUTION_ID,
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_delivery_plan_snapshots (
       id, attempt_id, candidate_id, candidate_hash, draft_revision,
       plan_hash, content_json, pinned_revision_id, proposed_at,
       proposed_by_json
     ) VALUES (?, ?, NULL, NULL, 3, ?, ?, ?, ?, ?)`,
  ).run(
    SNAPSHOT_ID,
    ATTEMPT_ID,
    `sha256:${"2".repeat(64)}`,
    JSON.stringify({ contexts: [{ contextId: "legacy-context" }] }),
    REVISION_ID,
    TIMESTAMP,
    '{"kind":"agent","conversationId":"fixture"}',
  );
  db.prepare(
    `INSERT INTO spec_delivery_plan_candidates (
       id, attempt_id, snapshot_id, compiled_definition_hash, launch_json,
       binding_json, materialized_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CANDIDATE_ID,
    ATTEMPT_ID,
    SNAPSHOT_ID,
    `sha256:${"3".repeat(64)}`,
    JSON.stringify({ definitionId: "legacy-compiled-project" }),
    JSON.stringify({
      specPlanSourceMap: { "legacy-context": ["criterion-cutover"] },
    }),
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_delivery_plan_comments (
       id, attempt_id, context_id, body, author_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "plan-comment-legacy",
    ATTEMPT_ID,
    "legacy-context",
    "Legacy plan review",
    '{"kind":"human"}',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_approvals (
       id, spec_id, subject_kind, element_id, revision_id, approver,
       granted_at, validity
     ) VALUES (?, ?, 'revision', NULL, ?, ?, ?, 'valid')`,
  ).run("approval-legacy-plan", SPEC_ID, REVISION_ID, "alex", TIMESTAMP);
  db.prepare(
    `INSERT INTO spec_gate_admissions (
       id, spec_id, gate, basis, approval_id, revision_id, execution_id,
       actor_json, created_at
     ) VALUES (?, ?, 'execution_start', 'human_approval', ?, ?, ?, ?, ?)`,
  ).run(
    "gate-admission-legacy",
    SPEC_ID,
    "approval-legacy-plan",
    REVISION_ID,
    null,
    '{"kind":"human"}',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_evidence (
       id, spec_id, criterion_element_id, revision_id, kind, ref_json,
       evaluated_state_json, producer_json, execution_id, source_event_id,
       created_at
     ) VALUES (?, ?, ?, ?, 'validator_verdict', ?, ?, ?, ?, NULL, ?)`,
  ).run(
    "evidence-legacy",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    '{"verdictId":"verdict-legacy-proof"}',
    '{"kind":"legacy"}',
    JSON.stringify({
      kind: "criterion-modality",
      origin: `spec-execution://${SPEC_ID}/executions/${ACTIVE_SPEC_EXECUTION_ID}`,
    }),
    ACTIVE_SPEC_EXECUTION_ID,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_proof_verdicts (
       id, spec_id, criterion_element_id, revision_id, execution_id,
       verdict_kind, evidence_ids_json, verdict_at, stale_at, stale_reason
     ) VALUES (?, ?, ?, ?, ?, 'agent_validator', ?, ?, NULL, NULL)`,
  ).run(
    "verdict-legacy-proof",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    ACTIVE_SPEC_EXECUTION_ID,
    '["evidence-legacy"]',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_delivery_verdicts (
       id, spec_execution_id, workflow_execution_id, candidate_id,
       candidate_hash, criterion_element_id, satisfying_context_id, verdict_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "verdict-legacy-delivery",
    ACTIVE_SPEC_EXECUTION_ID,
    ACTIVE_WORKFLOW_EXECUTION_ID,
    CANDIDATE_ID,
    `sha256:${"4".repeat(64)}`,
    "criterion-cutover",
    "legacy-context",
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_criterion_dispositions (
       execution_id, criterion_element_id, disposition, waiver_id,
       delivered_by_execution_id, created_at, updated_at
     ) VALUES (?, ?, 'delivered_elsewhere', NULL, ?, ?, ?)`,
  ).run(
    ACTIVE_SPEC_EXECUTION_ID,
    "criterion-cutover",
    COMPLETED_SAMPLE_SPEC_EXECUTION_ID,
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_task_claims (
       id, spec_id, task_element_id, execution_id, actor_json,
       evidence_ids_json, claimed_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted')`,
  ).run(
    "task-claim-legacy",
    SPEC_ID,
    "task-cutover",
    ACTIVE_SPEC_EXECUTION_ID,
    '{"kind":"agent","conversationId":"fixture"}',
    '["evidence-legacy"]',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_links (
       id, spec_id, object_kind, object_ref_json, direction, category,
       snapshot_json, element_ids_json, actor_json, created_at
     ) VALUES (?, ?, 'workflow_execution', ?, 'outbound', 'materialized_from',
       ?, ?, ?, ?)`,
  ).run(
    "link-legacy-workflow",
    SPEC_ID,
    JSON.stringify({ workflowExecutionId: ACTIVE_WORKFLOW_EXECUTION_ID }),
    JSON.stringify({
      origin: `spec-plan://${SPEC_ID}/attempts/${ATTEMPT_ID}?plan=sha256:legacy`,
    }),
    '["criterion-cutover"]',
    '{"kind":"system"}',
    TIMESTAMP,
  );
  // A merge_job link records delivery of a legacy spec execution under an
  // object_kind the workflow_execution rule never reaches.
  db.prepare(
    `INSERT INTO spec_links (
       id, spec_id, object_kind, object_ref_json, direction, category,
       snapshot_json, element_ids_json, actor_json, created_at
     ) VALUES (?, ?, 'merge_job', ?, 'outbound', 'source', ?, NULL, ?, ?)`,
  ).run(
    "link-legacy-merge-job",
    SPEC_ID,
    JSON.stringify({
      specExecutionId: COMPLETED_SAMPLE_SPEC_EXECUTION_ID,
      mergeHash: "0".repeat(40),
    }),
    JSON.stringify({
      revisionId: REVISION_ID,
      workflowExecutionId: COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
    }),
    '{"kind":"system"}',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_delivery_discoveries (
       id, spec_id, execution_id, attempt_id, pinned_revision_id,
       discovered_task_json, blocking_reason, captured_by_json, captured_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    "discovery-legacy",
    SPEC_ID,
    ACTIVE_SPEC_EXECUTION_ID,
    ATTEMPT_ID,
    REVISION_ID,
    '{"title":"Legacy discovery"}',
    '{"kind":"agent","conversationId":"fixture"}',
    TIMESTAMP,
  );
  const insertSpecEvent = db.prepare(
    `INSERT INTO spec_events (
       spec_id, occurred_at, event_type, actor_json, payload_json
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  const deliveryTransitionEventId = Number(
    insertSpecEvent.run(
      SPEC_ID,
      TIMESTAMP,
      "spec-delivery-plan-transitioned",
      '{"kind":"system"}',
      JSON.stringify({ attemptId: ATTEMPT_ID, to: "launched" }),
    ).lastInsertRowid,
  );
  insertSpecEvent.run(
    SPEC_ID,
    TIMESTAMP,
    "spec-review-item-approved",
    '{"kind":"human"}',
    JSON.stringify({
      kind: "execution-start-approval-granted",
      gate: "execution_start",
      admissionId: "gate-admission-legacy",
      approvalId: "approval-legacy-plan",
      revisionId: REVISION_ID,
      attemptId: ATTEMPT_ID,
      candidateId: CANDIDATE_ID,
      candidateHash: `sha256:${"5".repeat(64)}`,
      planHash: `sha256:${"2".repeat(64)}`,
      compiledDefinitionHash: `sha256:${"3".repeat(64)}`,
    }),
  );
  insertSpecEvent.run(
    SPEC_ID,
    TIMESTAMP,
    "spec-execution-changed",
    '{"kind":"system"}',
    JSON.stringify({
      kind: "execution_running",
      executionId: ACTIVE_SPEC_EXECUTION_ID,
      workflowExecutionId: ACTIVE_WORKFLOW_EXECUTION_ID,
    }),
  );
  db.prepare(
    `INSERT INTO spec_evidence (
       id, spec_id, criterion_element_id, revision_id, kind, ref_json,
       evaluated_state_json, producer_json, execution_id, source_event_id,
       created_at
     ) VALUES (?, ?, ?, ?, 'validator_verdict', ?, ?, ?, NULL, ?, ?)`,
  ).run(
    "evidence-legacy-event",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    '{"verdictId":"verdict-nullable-evidence"}',
    '{"kind":"legacy-event"}',
    '{"kind":"human"}',
    deliveryTransitionEventId,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_proof_verdicts (
       id, spec_id, criterion_element_id, revision_id, execution_id,
       verdict_kind, evidence_ids_json, verdict_at, stale_at, stale_reason
     ) VALUES (?, ?, ?, ?, NULL, 'human', ?, ?, NULL, NULL)`,
  ).run(
    "verdict-nullable-evidence",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    '["evidence-legacy-event"]',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_task_claims (
       id, spec_id, task_element_id, execution_id, actor_json,
       evidence_ids_json, claimed_at, status
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'accepted')`,
  ).run(
    "task-claim-nullable-evidence",
    SPEC_ID,
    "task-cutover",
    '{"kind":"human"}',
    '["evidence-legacy-event"]',
    TIMESTAMP,
  );

  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    "active-session",
    ACTIVE_WORKFLOW_EXECUTION_ID,
    "legacy-saved-project",
    TIMESTAMP,
    status,
    JSON.stringify({
      schemaVersion: 1,
      origin: {
        sourceUri: `spec-execution://${SPEC_ID}/executions/${ACTIVE_SPEC_EXECUTION_ID}`,
      },
      specPlanSourceMap: { "legacy-context": ["criterion-cutover"] },
    }),
    JSON.stringify({
      executionId: ACTIVE_WORKFLOW_EXECUTION_ID,
      // A halted run only retains the session lease when its recorded reason
      // is resumable, so the halted refusal case seeds one; a reasonless halt
      // is lease-free and would not block the cutover.
      ...(status === "halted"
        ? {
            haltReason: {
              type: "max_iterations",
              contextId: "legacy-context",
              iterationCount: 3,
            },
          }
        : {}),
    }),
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, 'running', NULL, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    "ordinary-global-session",
    "workflow-execution-ordinary-global-collision",
    "legacy-compiled-project",
    TIMESTAMP,
    JSON.stringify({
      id: "workflow-execution-ordinary-global-collision",
      seedSource: {
        kind: "saved-definition",
        id: "legacy-compiled-project",
        revision: 1,
        tier: "global",
      },
      workingDefinition: {
        origin: { sourceUri: "workflow-template://ordinary-global-collision" },
      },
    }),
    JSON.stringify({
      status: "running",
      executionId: "workflow-execution-ordinary-global-collision",
    }),
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO graph_workflow_archived_executions (
       project_path, session_name, execution_id, archived_at, status,
       started_at, completed_at, execution_json
     ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    "archived-session",
    COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
    TIMESTAMP,
    TIMESTAMP,
    TIMESTAMP,
    JSON.stringify({
      id: COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
      status: "completed",
      seedSource: {
        kind: "saved-definition",
        id: "legacy-saved-global",
        revision: 1,
        tier: "global",
      },
      definition: {
        origin: {
          sourceUri: `spec-execution://${SPEC_ID}/executions/${COMPLETED_SAMPLE_SPEC_EXECUTION_ID}`,
        },
      },
    }),
  );
  const insertGraphEvent = db.prepare(
    `INSERT INTO graph_workflow_events (
       project_path, session_name, execution_id, occurred_at, event_type,
       context_id, pre_reset, event_json
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const graphEventId = Number(
    insertGraphEvent.run(
      PROJECT_PATH,
      "active-session",
      ACTIVE_WORKFLOW_EXECUTION_ID,
      TIMESTAMP,
      "workflow-status",
      "legacy-context",
      JSON.stringify({ workflowStatus: status }),
    ).lastInsertRowid,
  );
  insertGraphEvent.run(
    PROJECT_PATH,
    "archived-session",
    COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
    TIMESTAMP,
    "workflow-status",
    null,
    '{"workflowStatus":"completed"}',
  );

  // A workflow_event evidence reference is only reachable through the graph
  // execution it cites: neither execution_id nor source_event_id ties it to the
  // legacy spec execution that produced it.
  db.prepare(
    `INSERT INTO spec_evidence (
       id, spec_id, criterion_element_id, revision_id, kind, ref_json,
       evaluated_state_json, producer_json, execution_id, source_event_id,
       created_at
     ) VALUES (?, ?, ?, ?, 'test_run', ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    "evidence-legacy-workflow-event",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    JSON.stringify({
      type: "workflow_event",
      workflowExecutionId: ACTIVE_WORKFLOW_EXECUTION_ID,
      eventId: graphEventId,
      contextId: "legacy-context",
    }),
    '{"kind":"legacy-workflow-event"}',
    '{"kind":"human"}',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_proof_verdicts (
       id, spec_id, criterion_element_id, revision_id, execution_id,
       verdict_kind, evidence_ids_json, verdict_at, stale_at, stale_reason
     ) VALUES (?, ?, ?, ?, NULL, 'human', ?, ?, NULL, NULL)`,
  ).run(
    "verdict-workflow-event-evidence",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    '["evidence-legacy-workflow-event"]',
    TIMESTAMP,
  );
  // A merge_validation reference reaches the legacy runtime only through the
  // job record the cutover deletes with its linked graph execution.
  db.prepare(
    `INSERT INTO job_records (
       job_id, job_type, status, project_name, session_name, branch_name,
       started_at, completed_at, execution_id, candidate_validation
     ) VALUES (?, 'merge', 'completed', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    MERGE_JOB_ID,
    PROJECT_PATH,
    "active-session",
    "cutover/active",
    TIMESTAMP,
    TIMESTAMP,
    ACTIVE_WORKFLOW_EXECUTION_ID,
    JSON.stringify({ validationRef: "validation-legacy" }),
  );
  db.prepare(
    `INSERT INTO spec_evidence (
       id, spec_id, criterion_element_id, revision_id, kind, ref_json,
       evaluated_state_json, producer_json, execution_id, source_event_id,
       created_at
     ) VALUES (?, ?, ?, ?, 'commit', ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    "evidence-legacy-merge-validation",
    SPEC_ID,
    "criterion-cutover",
    REVISION_ID,
    JSON.stringify({
      type: "merge_validation",
      mergeJobId: MERGE_JOB_ID,
      validationRef: "validation-legacy",
    }),
    '{"kind":"legacy-merge-validation"}',
    '{"kind":"human"}',
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_task_claims (
       id, spec_id, task_element_id, execution_id, actor_json,
       evidence_ids_json, claimed_at, status
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'accepted')`,
  ).run(
    "task-claim-workflow-event-evidence",
    SPEC_ID,
    "task-cutover",
    '{"kind":"human"}',
    '["evidence-legacy-workflow-event"]',
    TIMESTAMP,
  );
}

function seedWorkflowDefinitions(
  configDir: string,
): CutoverFixture["workflowFiles"] {
  const projectKey = Buffer.from(PROJECT_PATH).toString("base64url");
  const projectDir = path.join(configDir, "workflows", projectKey);
  const globalDir = path.join(configDir, "workflows", "global.shared");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  const writeDefinition = (
    dir: string,
    id: string,
    sourceUri: string,
  ): string => {
    const filePath = path.join(dir, `${id}.json`);
    const record = createWorkflowDefinitionRecord({
      id,
      name: id,
      definition: {
        ...createWorkflowDefinitionRecord().definition,
        origin: { sourceUri, label: id },
      },
      layout: {
        ...createWorkflowDefinitionRecord().layout,
        workflowId: id,
      },
    });
    writeFileSync(filePath, JSON.stringify(record, null, 2));
    return filePath;
  };

  return {
    compiledGlobal: writeDefinition(
      globalDir,
      "legacy-compiled-global",
      `spec-plan://${SPEC_ID}/attempts/${ATTEMPT_ID}?plan=sha256:compiled-global`,
    ),
    compiledProject: writeDefinition(
      projectDir,
      "legacy-compiled-project",
      `spec-plan://${SPEC_ID}/attempts/${ATTEMPT_ID}?plan=sha256:compiled-project`,
    ),
    savedGlobal: writeDefinition(
      globalDir,
      "legacy-saved-global",
      `spec-execution://${SPEC_ID}/executions/${COMPLETED_SAMPLE_SPEC_EXECUTION_ID}`,
    ),
    savedProject: writeDefinition(
      projectDir,
      "legacy-saved-project",
      `spec-execution://${SPEC_ID}/executions/${ACTIVE_SPEC_EXECUTION_ID}`,
    ),
    safeGlobal: writeDefinition(
      globalDir,
      "ordinary-global",
      "workflow-template://ordinary-global",
    ),
    safeProject: writeDefinition(
      projectDir,
      "ordinary-project",
      "workflow-template://ordinary-project",
    ),
    safeGlobalIdCollision: writeDefinition(
      globalDir,
      "legacy-compiled-project",
      "workflow-template://ordinary-global-collision",
    ),
    safeProjectIdCollision: writeDefinition(
      projectDir,
      "legacy-compiled-global",
      "workflow-template://ordinary-project-collision",
    ),
  };
}

function snapshotWorkflowStore(configDir: string): Record<string, string> {
  const root = path.join(configDir, "workflows");
  const snapshot: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      snapshot[path.relative(configDir, entryPath)] =
        readFileSync(entryPath).toString("base64");
    }
  };
  visit(root);
  return snapshot;
}

function seedExtraLegacyAttempts(db: Db, count: number): void {
  const insert = db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, 'abandoned', 1, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(
      `attempt-extra-${index.toString().padStart(2, "0")}-${randomUUID()}`,
      SPEC_ID,
      REVISION_ID,
      '{"contexts":[],"tasks":[]}',
      TIMESTAMP,
      TIMESTAMP,
    );
  }
}

function manifestPathFor(configDir: string): string {
  return path.join(configDir, NATIVE_SDD_V2_CUTOVER_MANIFEST_FILE_NAME);
}

function readManifestPhase(configDir: string): string {
  return (
    JSON.parse(readFileSync(manifestPathFor(configDir), "utf8")) as {
      phase: string;
    }
  ).phase;
}

function schemaSignature(db: Db): unknown[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all();
}

function seedDeletableLegacySpec(db: Db): void {
  const specId = "spec-cutover-delete";
  const revisionId = "revision-cutover-delete";
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, abandoned_at,
       abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specId,
    PROJECT_PATH,
    "cutover-delete",
    "Cutover delete",
    '{"preset":"contract-bearing"}',
    TIMESTAMP,
    "Incompatible legacy aggregate",
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, created_at
     ) VALUES (?, ?, 1, 'draft', 'plan', ?)`,
  ).run(revisionId, specId, TIMESTAMP);
  db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, 'abandoned', 1, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    "attempt-cutover-delete",
    specId,
    revisionId,
    '{"contexts":[],"tasks":[],"edges":[]}',
    TIMESTAMP,
    TIMESTAMP,
  );
}

function seedModernTypedExecution(db: Db): void {
  const specId = "spec-cutover-modern";
  const revisionId = "revision-cutover-modern";
  const specExecutionId = "spec-execution-modern";
  const workflowExecutionId = "workflow-execution-modern";
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    "modern-session",
    `${PROJECT_PATH}/.worktrees/modern-session`,
    "cutover/modern",
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specId,
    PROJECT_PATH,
    "cutover-modern",
    "Cutover modern",
    '{"preset":"contract-bearing"}',
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, content_hash,
       citation_contract_version, citation_hash, proposed_at, approved_at,
       created_at
     ) VALUES (?, ?, 1, 'approved', 'plan', ?, 1, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    specId,
    EMPTY_PLAN_CONTENT_HASH,
    EMPTY_LEGACY_CITATION_HASH,
    TIMESTAMP,
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, execution_start_dial,
       workflow_definition_id, workflow_definition_revision,
       workflow_seed_source_json, workflow_execution_binding_json,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       cleanup_phase, linked_workflow_execution_id, cleanup_last_error,
       cleanup_last_error_at, created_at, updated_at
     ) VALUES (
       ?, ?, ?, '{}', 'running', 'gate', NULL, NULL, ?, NULL, ?, ?, NULL,
       NULL, NULL, NULL, NULL, NULL, ?, ?
     )`,
  ).run(
    specExecutionId,
    specId,
    revisionId,
    JSON.stringify({
      kind: "one-off",
      launchId: "launch-modern",
      launchRevision: 1,
      launch: { name: "Modern launch" },
    }),
    workflowExecutionId,
    "modern-session",
    TIMESTAMP,
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO spec_execution_bindings (
       spec_execution_id, workflow_execution_id, binding_json, created_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(
    specExecutionId,
    workflowExecutionId,
    JSON.stringify({
      schemaVersion: 2,
      candidateId: "candidate-modern",
      candidateHash: `sha256:${"6".repeat(64)}`,
      pinnedRevisionId: revisionId,
      dispositions: [],
      claims: [],
    }),
    TIMESTAMP,
  );
  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, NULL, NULL, ?, 'running', NULL, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    "modern-session",
    workflowExecutionId,
    TIMESTAMP,
    JSON.stringify({
      schemaVersion: 2,
      origin: {
        sourceUri:
          "spec-plan://spec-cutover-modern/attempts/attempt-modern/candidates/candidate-modern",
      },
    }),
    JSON.stringify({ executionId: workflowExecutionId }),
    TIMESTAMP,
  );
}

function failureHook(target: NativeSddV2CutoverFailurePoint) {
  return {
    reach(point: NativeSddV2CutoverFailurePoint): void {
      if (point === target)
        throw new Error(`injected cutover failure at ${target}`);
    },
  };
}

describe("0030 native-SDD v2 cutover preflight", () => {
  it("reports a bounded inventory across SQLite and both definition tiers", () => {
    const fixture = createFixture("completed");
    seedExtraLegacyAttempts(fixture.db, SAMPLE_LIMIT + 5);

    const inventory = inspectNativeSddV2Cutover({
      db: fixture.db,
      configDir: fixture.configDir,
    });

    expect(inventory.counts).toEqual({
      activeGraphExecutions: 1,
      archivedGraphExecutions: 1,
      candidates: 1,
      deliveryEvents: 3,
      deliveryVerdicts: 1,
      discoveries: 1,
      dispositions: 1,
      evidence: 4,
      gateAdmissions: 1,
      graphEvents: 2,
      legacyAttempts: SAMPLE_LIMIT + 6,
      legacyDefinitionFiles: 4,
      legacyDefinitionOrigins: 4,
      legacySpecExecutions: 3,
      planApprovals: 1,
      planComments: 1,
      proofVerdicts: 3,
      resumableActiveGraphExecutions: 0,
      savedDefinitions: 2,
      compiledDefinitions: 2,
      snapshots: 1,
      specLinks: 2,
      taskClaims: 3,
    });
    expect(inventory.samples.legacyAttemptIds).toHaveLength(SAMPLE_LIMIT);
    expect(inventory.samples.legacyAttemptIds).toEqual(
      [...inventory.samples.legacyAttemptIds].sort(),
    );
    expect(inventory.samples.definitionPaths).toEqual([
      `workflows/${Buffer.from(PROJECT_PATH).toString("base64url")}/legacy-compiled-project.json`,
      `workflows/${Buffer.from(PROJECT_PATH).toString("base64url")}/legacy-saved-project.json`,
      "workflows/global.shared/legacy-compiled-global.json",
      "workflows/global.shared/legacy-saved-global.json",
    ]);
    expect(inventory.samples.legacySpecExecutionIds).toEqual([
      ABANDONED_SPEC_EXECUTION_ID,
      ACTIVE_SPEC_EXECUTION_ID,
      COMPLETED_SAMPLE_SPEC_EXECUTION_ID,
    ]);
    expect(inventory.samples.archivedGraphExecutionIds).toContain(
      COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
    );
    expect(inventory.samples.resumableActiveGraphExecutionIds).toEqual([]);
  });

  it("runs before the schema floor and refuses a frozen legacy database without mutating either store", async () => {
    const fixture = createFrozenUpgradeFixture("running");
    const executionColumns = fixture.db
      .prepare("PRAGMA table_info(spec_executions)")
      .all() as Array<{ name: string; notnull: number }>;
    expect(executionColumns).toContainEqual(
      expect.objectContaining({ name: "workflow_definition_id", notnull: 1 }),
    );
    expect(executionColumns.map((column) => column.name)).not.toContain(
      "workflow_seed_source_json",
    );
    expect(executionColumns.map((column) => column.name)).not.toContain(
      "workflow_execution_binding_json",
    );
    const t2 = performance.now();
    const databaseBefore = fixture.db.serialize();
    const workflowsBefore = snapshotWorkflowStore(fixture.configDir);
    fixture.db.close();
    const databaseFileBefore = readFileSync(fixture.dbPath);
    const t3 = performance.now();
    process.stderr.write(`\nZZT snapshot=${Math.round(t3 - t2)}ms\n`);

    await expect(
      runNativeSddV2CutoverBeforeStateDbOpen(fixture.configDir),
    ).rejects.toBeInstanceOf(NativeSddV2CutoverActiveExecutionError);
    const t4 = performance.now();
    process.stderr.write(`\nZZT preflight=${Math.round(t4 - t3)}ms\n`);

    expectSameBytes(
      readFileSync(fixture.dbPath),
      databaseFileBefore,
      "databaseFileBefore",
    );
    const t5 = performance.now();
    process.stderr.write(`\nZZT fileCompare=${Math.round(t5 - t4)}ms\n`);
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);
    expect(existsSync(manifestPathFor(fixture.configDir))).toBe(false);
    const readBack = new Database(fixture.dbPath, { readonly: true });
    try {
      expectSameBytes(readBack.serialize(), databaseBefore, "databaseBefore");
      const t6 = performance.now();
      process.stderr.write(`\nZZT serializeCompare=${Math.round(t6 - t5)}ms\n`);
      expect(
        readBack
          .prepare(
            "SELECT status, proposed_snapshot_id, approval_json FROM spec_delivery_plan_attempts WHERE id = ?",
          )
          .get(ATTEMPT_ID),
      ).toEqual({
        status: "launched",
        proposed_snapshot_id: SNAPSHOT_ID,
        approval_json: expect.any(String),
      });
      expect(
        readBack
          .prepare(
            "SELECT COUNT(*) AS count FROM spec_delivery_plan_candidates",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      readBack.close();
    }
    // Two full serializations of the frozen fixture plus the fsync-per-step
    // pre-open cutover put this case within a second of the 15s default, so it
    // tips over on a loaded machine while the code under test is fine.
  }, 60_000);

  it.each<LinkedActiveStatus>(["pending", "running", "paused", "halted"])(
    "refuses a linked %s execution before manifest or quarantine and leaves both stores identical",
    async (status) => {
      const fixture = createFixture(status);
      const databaseBefore = fixture.db.serialize();
      const workflowsBefore = snapshotWorkflowStore(fixture.configDir);
      const manifestPath = path.join(
        fixture.configDir,
        NATIVE_SDD_V2_CUTOVER_MANIFEST_FILE_NAME,
      );

      let refusal: NativeSddV2CutoverActiveExecutionError | null = null;
      try {
        await runNativeSddV2Cutover({
          db: fixture.db,
          configDir: fixture.configDir,
        });
      } catch (error) {
        if (error instanceof NativeSddV2CutoverActiveExecutionError) {
          refusal = error;
        } else {
          throw error;
        }
      }

      expect(refusal).not.toBeNull();
      expect(
        refusal?.inventory.samples.resumableActiveGraphExecutionIds,
      ).toEqual([ACTIVE_WORKFLOW_EXECUTION_ID]);
      expect(refusal?.inventory.samples.archivedGraphExecutionIds).toContain(
        COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
      );
      expectSameBytes(fixture.db.serialize(), databaseBefore, "databaseBefore");
      expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);
      expect(existsSync(manifestPath)).toBe(false);
      expect(
        readdirSync(fixture.configDir).some((entry) =>
          entry.startsWith("native-sdd-v2-cutover-quarantine-"),
        ),
      ).toBe(false);
      expect(logSpies.info).toHaveBeenCalledWith(
        "state-store.native_sdd_v2_cutover_inventory",
        expect.objectContaining({
          counts: refusal?.inventory.counts,
          resumableActiveGraphExecutionIds: [ACTIVE_WORKFLOW_EXECUTION_ID],
        }),
      );
      expect(logSpies.warn).toHaveBeenCalledWith(
        "state-store.native_sdd_v2_cutover_refused_active",
        expect.objectContaining({
          activeExecutionCount: 1,
          activeExecutionIds: [ACTIVE_WORKFLOW_EXECUTION_ID],
        }),
      );
    },
  );
});

describe("0030 native-SDD v2 cutover purge", () => {
  it("quarantines both tiers, purges the complete relational set atomically, and preserves the approved spec", async () => {
    const fixture = createFixture("completed");
    const manifestPath = path.join(
      fixture.configDir,
      NATIVE_SDD_V2_CUTOVER_MANIFEST_FILE_NAME,
    );

    const result = await runNativeSddV2Cutover({
      db: fixture.db,
      configDir: fixture.configDir,
    });

    expect(result.completed).toBe(true);
    expect(result.inventory.counts).toEqual(
      expect.objectContaining({
        legacyAttempts: 1,
        legacyDefinitionFiles: 4,
        legacySpecExecutions: 3,
      }),
    );
    expect(fixture.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The compiled-candidate table is not emptied, it is gone: leaving an
    // empty one would leave the next reader somewhere to write.
    expect(
      (
        fixture.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).not.toContain("spec_delivery_plan_candidates");
    for (const table of [
      "graph_workflow_archived_executions",
      "graph_workflow_events",
      "spec_criterion_dispositions",
      "spec_delivery_discoveries",
      "spec_delivery_plan_comments",
      "spec_delivery_plan_snapshots",
      "spec_delivery_plan_attempts",
      "spec_delivery_verdicts",
      "spec_evidence",
      "spec_executions",
      "spec_proof_verdicts",
      "spec_task_claims",
    ]) {
      expect(
        fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        table,
      ).toEqual({ count: 0 });
    }
    expect(
      fixture.db
        .prepare("SELECT id, abandoned_at FROM specs WHERE id = ?")
        .get(SPEC_ID),
    ).toEqual({ id: SPEC_ID, abandoned_at: null });
    expect(
      fixture.db
        .prepare(
          "SELECT id, state, authoring_stage FROM spec_revisions WHERE id = ?",
        )
        .get(REVISION_ID),
    ).toEqual({
      id: REVISION_ID,
      state: "approved",
      authoring_stage: "plan",
    });
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM spec_approvals").get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.db
        .prepare("SELECT COUNT(*) AS count FROM spec_gate_admissions")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM spec_links").get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM spec_events").get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.db
        .prepare("SELECT description FROM schema_migrations WHERE version = 9")
        .get(),
    ).toEqual({
      description:
        "native SDD version-2 cutover removed legacy delivery runtime artifacts",
    });

    for (const legacyFile of [
      fixture.workflowFiles.compiledGlobal,
      fixture.workflowFiles.compiledProject,
      fixture.workflowFiles.savedGlobal,
      fixture.workflowFiles.savedProject,
    ]) {
      expect(existsSync(legacyFile), legacyFile).toBe(false);
    }
    for (const ordinaryFile of [
      fixture.workflowFiles.safeGlobal,
      fixture.workflowFiles.safeProject,
      fixture.workflowFiles.safeGlobalIdCollision,
      fixture.workflowFiles.safeProjectIdCollision,
    ]) {
      expect(existsSync(ordinaryFile), ordinaryFile).toBe(true);
    }
    expect(
      fixture.db
        .prepare(
          "SELECT execution_id, status FROM graph_workflow_executions ORDER BY execution_id",
        )
        .all(),
    ).toEqual([
      {
        execution_id: "workflow-execution-ordinary-global-collision",
        status: "running",
      },
    ]);

    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(
      expect.objectContaining({
        phase: "complete",
        schemaVersion: 9,
        definitionFiles: expect.arrayContaining([
          expect.objectContaining({
            sourceRelativePath:
              "workflows/global.shared/legacy-compiled-global.json",
          }),
          expect.objectContaining({
            sourceRelativePath:
              "workflows/global.shared/legacy-saved-global.json",
          }),
        ]),
      }),
    );
    expect(
      readdirSync(fixture.configDir).some((entry) =>
        entry.startsWith("native-sdd-v2-cutover-quarantine-"),
      ),
    ).toBe(false);
    expect(
      inspectNativeSddV2Cutover({
        db: fixture.db,
        configDir: fixture.configDir,
      }).counts,
    ).toEqual({
      activeGraphExecutions: 0,
      archivedGraphExecutions: 0,
      candidates: 0,
      compiledDefinitions: 0,
      deliveryEvents: 0,
      deliveryVerdicts: 0,
      discoveries: 0,
      dispositions: 0,
      evidence: 0,
      gateAdmissions: 0,
      graphEvents: 0,
      legacyAttempts: 0,
      legacyDefinitionFiles: 0,
      legacyDefinitionOrigins: 0,
      legacySpecExecutions: 0,
      planApprovals: 0,
      planComments: 0,
      proofVerdicts: 0,
      resumableActiveGraphExecutions: 0,
      savedDefinitions: 0,
      snapshots: 0,
      specLinks: 0,
      taskClaims: 0,
    });
  });
});

describe("0030 native-SDD v2 cutover hardening", () => {
  it("purges a frozen legacy schema before the current floor and complete registry can rewrite it", async () => {
    const fixture = createFrozenUpgradeFixture("completed");
    fixture.db.close();

    const preFloor = await runNativeSddV2CutoverBeforeStateDbOpen(
      fixture.configDir,
    );
    expect(preFloor?.inventory.counts).toEqual(
      expect.objectContaining({
        candidates: 1,
        gateAdmissions: 1,
        planApprovals: 1,
        deliveryEvents: 3,
      }),
    );

    const current = _createTestDbAtPath(fixture.dbPath);
    try {
      const applied = await runMigrations(
        { db: current, configDir: fixture.configDir },
        migrations,
      );
      expect(applied).toContain(nativeSddV2Cutover.name);
      expect(
        inspectNativeSddV2Cutover({
          db: current,
          configDir: fixture.configDir,
        }).counts,
      ).toEqual(EMPTY_COUNTS);
      expect(current.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        current.prepare("SELECT COUNT(*) AS count FROM spec_approvals").get(),
      ).toEqual({ count: 0 });
      expect(
        current
          .prepare("SELECT COUNT(*) AS count FROM spec_gate_admissions")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        current
          .prepare(
            "SELECT COUNT(*) AS count FROM spec_events WHERE payload_json LIKE '%attempt-legacy%'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      current.close();
    }
  });

  // `next build` opens the live database, so the synchronous floor routinely
  // runs against a legacy database BEFORE the pre-open cutover does — and the
  // floor drops the compiled-candidate table this migration inventories. Every
  // other case here reaches the cutover with that table still present, so the
  // ordering a build actually produces is only covered by this one.
  it("cuts over a legacy database whose floor already dropped the compiled-candidate table", async () => {
    const fixture = createFrozenUpgradeFixture("completed");
    fixture.db.close();

    const buildOpen = _createTestDbAtPath(fixture.dbPath);
    const candidateTableAfterFloor = buildOpen
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'spec_delivery_plan_candidates'`,
      )
      .get();
    const legacyAttemptsAfterFloor = buildOpen
      .prepare("SELECT COUNT(*) AS count FROM spec_delivery_plan_attempts")
      .get();
    buildOpen.close();
    expect(candidateTableAfterFloor).toBeUndefined();
    expect(legacyAttemptsAfterFloor).toEqual({ count: 1 });

    const preFloor = await runNativeSddV2CutoverBeforeStateDbOpen(
      fixture.configDir,
    );
    expect(preFloor?.completed).toBe(true);
    expect(preFloor?.inventory.counts).toEqual(
      expect.objectContaining({ candidates: 0, legacyAttempts: 1 }),
    );

    const current = _createTestDbAtPath(fixture.dbPath);
    try {
      const applied = await runMigrations(
        { db: current, configDir: fixture.configDir },
        migrations,
      );
      expect(applied).toContain(nativeSddV2Cutover.name);
      expect(
        inspectNativeSddV2Cutover({
          db: current,
          configDir: fixture.configDir,
        }).counts,
      ).toEqual(EMPTY_COUNTS);
      expect(current.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        current
          .prepare("SELECT COUNT(*) AS count FROM spec_delivery_plan_attempts")
          .get(),
      ).toEqual({ count: 0 });
      // Losing the table also loses candidate identity as a classifier, so the
      // attempt and execution rules have to carry every compiled-era event on
      // their own — otherwise the purge would strand events citing rows it
      // deleted.
      expect(
        current
          .prepare(
            "SELECT COUNT(*) AS count FROM spec_events WHERE payload_json LIKE '%candidate-legacy%'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      current.close();
    }
  });

  // The operator's real recovery path, which no other case covers: the refusal
  // and the purge are asserted here against ONE on-disk database rather than
  // two fixtures, so a refusal that left the stores subtly unusable — a
  // half-written manifest, an orphaned quarantine directory, a stale schema
  // witness — would surface as a failed second run instead of passing as two
  // independently green scenarios.
  it("refuses a live linked run, then purges the same database once that run is terminalized", async () => {
    const fixture = createFrozenUpgradeFixture("running");
    const workflowsBefore = snapshotWorkflowStore(fixture.configDir);
    fixture.db.close();
    const databaseFileBefore = readFileSync(fixture.dbPath);

    const refusal = await runNativeSddV2CutoverBeforeStateDbOpen(
      fixture.configDir,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(NativeSddV2CutoverActiveExecutionError);
    expect(
      (refusal as NativeSddV2CutoverActiveExecutionError).inventory.samples
        .resumableActiveGraphExecutionIds,
    ).toEqual([ACTIVE_WORKFLOW_EXECUTION_ID]);
    expectSameBytes(
      readFileSync(fixture.dbPath),
      databaseFileBefore,
      "databaseFileBefore",
    );
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);
    expect(existsSync(manifestPathFor(fixture.configDir))).toBe(false);
    expect(
      readdirSync(fixture.configDir).some((entry) =>
        entry.startsWith("native-sdd-v2-cutover-quarantine-"),
      ),
    ).toBe(false);

    const terminalizing = new Database(fixture.dbPath);
    try {
      terminalizing
        .prepare(
          "UPDATE graph_workflow_executions SET status = 'completed' WHERE execution_id = ?",
        )
        .run(ACTIVE_WORKFLOW_EXECUTION_ID);
    } finally {
      terminalizing.close();
    }

    const purge = await runNativeSddV2CutoverBeforeStateDbOpen(
      fixture.configDir,
    );

    expect(purge?.applied).toBe(true);
    expect(purge?.inventory.counts.resumableActiveGraphExecutions).toBe(0);
    expect(readManifestPhase(fixture.configDir)).toBe("complete");
    expect(
      readdirSync(fixture.configDir).some((entry) =>
        entry.startsWith("native-sdd-v2-cutover-quarantine-"),
      ),
    ).toBe(false);
    for (const legacyFile of [
      fixture.workflowFiles.compiledGlobal,
      fixture.workflowFiles.compiledProject,
      fixture.workflowFiles.savedGlobal,
      fixture.workflowFiles.savedProject,
    ]) {
      expect(existsSync(legacyFile), legacyFile).toBe(false);
    }
    for (const ordinaryFile of [
      fixture.workflowFiles.safeGlobal,
      fixture.workflowFiles.safeProject,
      fixture.workflowFiles.safeGlobalIdCollision,
      fixture.workflowFiles.safeProjectIdCollision,
    ]) {
      expect(existsSync(ordinaryFile), ordinaryFile).toBe(true);
    }

    // The cutover's own postcondition, read straight off the purged file
    // before anything else touches it: the terminalized legacy run and its
    // archived sibling are gone, and the unrelated ordinary execution is
    // untouched. Asserting here rather than after the restart keeps this
    // pinned to what the migration boundary did.
    const purged = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(
        purged
          .prepare(
            "SELECT execution_id, status FROM graph_workflow_executions ORDER BY execution_id",
          )
          .all(),
      ).toEqual([
        {
          execution_id: "workflow-execution-ordinary-global-collision",
          status: "running",
        },
      ]);
      expect(
        purged
          .prepare(
            "SELECT COUNT(*) AS count FROM graph_workflow_archived_executions",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      purged.close();
    }

    // The app the operator restarts onto: the registry must still reach the
    // current floor over the purged database, and the spec that survives has
    // to be the one a v2 attempt can be opened against.
    const restarted = _createTestDbAtPath(fixture.dbPath);
    try {
      await runMigrations(
        { db: restarted, configDir: fixture.configDir },
        migrations,
      );
      expect(
        inspectNativeSddV2Cutover({
          db: restarted,
          configDir: fixture.configDir,
        }).counts,
      ).toEqual(EMPTY_COUNTS);
      expect(restarted.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        (
          restarted
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      ).not.toContain("spec_delivery_plan_candidates");
      // No legacy execution id may reappear in either store once the registry
      // has replayed over the purged database.
      for (const table of [
        "graph_workflow_executions",
        "graph_workflow_archived_executions",
      ]) {
        expect(
          restarted
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE execution_id IN (?, ?)`,
            )
            .get(
              ACTIVE_WORKFLOW_EXECUTION_ID,
              COMPLETED_SAMPLE_WORKFLOW_EXECUTION_ID,
            ),
          table,
        ).toEqual({ count: 0 });
      }
      for (const table of [
        "graph_workflow_events",
        "spec_approvals",
        "spec_criterion_dispositions",
        "spec_delivery_discoveries",
        "spec_delivery_plan_attempts",
        "spec_delivery_plan_comments",
        "spec_delivery_plan_snapshots",
        "spec_evidence",
        "spec_executions",
        "spec_gate_admissions",
        "spec_links",
        "spec_proof_verdicts",
        "spec_task_claims",
      ]) {
        expect(
          restarted.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          table,
        ).toEqual({ count: 0 });
      }
      expect(
        restarted
          .prepare("SELECT id, abandoned_at FROM specs WHERE id = ?")
          .get(SPEC_ID),
      ).toEqual({ id: SPEC_ID, abandoned_at: null });
      expect(
        restarted
          .prepare(
            "SELECT id, state, authoring_stage FROM spec_revisions WHERE id = ?",
          )
          .get(REVISION_ID),
      ).toEqual({
        id: REVISION_ID,
        state: "approved",
        authoring_stage: "plan",
      });
    } finally {
      restarted.close();
    }
  });

  it("keeps a typed v2 execution, preserves an eligible spec, and deletes an incompatible aggregate", async () => {
    const fixture = createFixture("completed");
    seedDeletableLegacySpec(fixture.db);
    seedModernTypedExecution(fixture.db);

    await runNativeSddV2Cutover({
      db: fixture.db,
      configDir: fixture.configDir,
    });

    expect(
      fixture.db.prepare("SELECT id FROM specs ORDER BY id").all(),
    ).toEqual([{ id: "spec-cutover-modern" }, { id: SPEC_ID }]);
    expect(
      fixture.db
        .prepare(
          `SELECT se.id, binding.workflow_execution_id
             FROM spec_executions se
             JOIN spec_execution_bindings binding
               ON binding.spec_execution_id = se.id`,
        )
        .all(),
    ).toEqual([
      {
        id: "spec-execution-modern",
        workflow_execution_id: "workflow-execution-modern",
      },
    ]);
    expect(
      fixture.db
        .prepare(
          "SELECT execution_id, status FROM graph_workflow_executions ORDER BY execution_id",
        )
        .all(),
    ).toEqual([
      { execution_id: "workflow-execution-modern", status: "running" },
      {
        execution_id: "workflow-execution-ordinary-global-collision",
        status: "running",
      },
    ]);
    expect(
      inspectNativeSddV2Cutover({
        db: fixture.db,
        configDir: fixture.configDir,
      }).counts,
    ).toEqual(EMPTY_COUNTS);
    expect(fixture.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("records the migration ledger once and replays an already-complete cutover without mutation", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };

    expect(migrations.map((m) => m.name)).toContain(nativeSddV2Cutover.name);
    const first = await runMigrations(context, [nativeSddV2Cutover]);
    const databaseAfterFirst = fixture.db.serialize();
    const workflowsAfterFirst = snapshotWorkflowStore(fixture.configDir);
    const manifestAfterFirst = readFileSync(
      manifestPathFor(fixture.configDir),
      "utf8",
    );
    const second = await runMigrations(context, [nativeSddV2Cutover]);

    expect(first).toEqual([nativeSddV2Cutover.name]);
    expect(second).toEqual([]);
    expect(
      fixture.db
        .prepare("SELECT name FROM applied_migrations WHERE name = ?")
        .all(nativeSddV2Cutover.name),
    ).toEqual([{ name: nativeSddV2Cutover.name }]);
    expectSameBytes(
      fixture.db.serialize(),
      databaseAfterFirst,
      "databaseAfterFirst",
    );
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(
      workflowsAfterFirst,
    );
    expect(readFileSync(manifestPathFor(fixture.configDir), "utf8")).toBe(
      manifestAfterFirst,
    );
  });

  it("serializes overlapping startup workers and lets the follower observe completion", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };

    const results = await Promise.all([
      runNativeSddV2Cutover(context),
      runNativeSddV2Cutover(context),
    ]);

    expect(results.map((result) => result.applied).sort()).toEqual([
      false,
      true,
    ]);
    expect(readManifestPhase(fixture.configDir)).toBe("complete");
    expect(
      fixture.db
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(inspectNativeSddV2Cutover(context).counts).toEqual(EMPTY_COUNTS);
  });

  it("publishes a complete lock record atomically before claiming startup exclusivity", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };
    let allowPublish: (() => void) | undefined;
    let reachedPublish: (() => void) | undefined;
    const publishReached = new Promise<void>((resolve) => {
      reachedPublish = resolve;
    });
    const publishAllowed = new Promise<void>((resolve) => {
      allowPublish = resolve;
    });

    const first = runNativeSddV2Cutover(context, {
      reach(): void {},
      async beforeLockPublish(): Promise<void> {
        reachedPublish?.();
        await publishAllowed;
      },
    });
    await publishReached;

    expect(
      existsSync(path.join(fixture.configDir, ".native-sdd-v2-cutover.lock")),
    ).toBe(false);
    const follower = await runNativeSddV2Cutover(context);
    expect(follower.applied).toBe(true);
    allowPublish?.();
    const leader = await first;

    expect(leader.applied).toBe(false);
    expect(readManifestPhase(fixture.configDir)).toBe("complete");
  });

  it("applies cleanly to a zero-row install and leaves an idempotent complete witness", async () => {
    const fixture = createEmptyFixture();
    const context = { db: fixture.db, configDir: fixture.configDir };

    const first = await runNativeSddV2Cutover(context);
    const second = await runNativeSddV2Cutover(context);

    expect(first.inventory.counts).toEqual(EMPTY_COUNTS);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(readManifestPhase(fixture.configDir)).toBe("complete");
    expect(
      fixture.db
        .prepare(
          "SELECT version, description FROM schema_migrations WHERE version = 9",
        )
        .get(),
    ).toEqual({
      version: 9,
      description:
        "native SDD version-2 cutover removed legacy delivery runtime artifacts",
    });
  });

  it("produces the same schema floor and version witness for a fresh install and a maximal purge", async () => {
    const maximal = createFixture("completed");
    const fresh = createEmptyFixture();

    await runNativeSddV2Cutover({
      db: maximal.db,
      configDir: maximal.configDir,
    });
    await runNativeSddV2Cutover({ db: fresh.db, configDir: fresh.configDir });

    expect(schemaSignature(maximal.db)).toEqual(schemaSignature(fresh.db));
    expect(
      maximal.db
        .prepare(
          "SELECT version, description FROM schema_migrations ORDER BY version",
        )
        .all(),
    ).toEqual(
      fresh.db
        .prepare(
          "SELECT version, description FROM schema_migrations ORDER BY version",
        )
        .all(),
    );
  });

  it("rolls back when relational postconditions find dangling logical evidence references", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };
    const databaseBefore = fixture.db.serialize();
    const workflowsBefore = snapshotWorkflowStore(fixture.configDir);
    const sourceEventId = (
      fixture.db
        .prepare(
          "SELECT source_event_id FROM spec_evidence WHERE id = 'evidence-legacy-event'",
        )
        .get() as { source_event_id: number }
    ).source_event_id;

    await expect(
      runNativeSddV2Cutover(context, {
        reach(point): void {
          if (point !== "after_relational_delete") return;
          fixture.db
            .prepare(
              `INSERT INTO spec_evidence (
               id, spec_id, criterion_element_id, revision_id, kind, ref_json,
               evaluated_state_json, producer_json, execution_id,
               source_event_id, created_at
             ) VALUES (?, ?, ?, ?, 'validator_verdict', ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              "evidence-dangling-source-event",
              SPEC_ID,
              "criterion-cutover",
              REVISION_ID,
              '{"verdictId":"verdict-dangling-source-event"}',
              '{"kind":"legacy-event"}',
              '{"kind":"human"}',
              sourceEventId,
              TIMESTAMP,
            );
          fixture.db
            .prepare(
              `INSERT INTO spec_proof_verdicts (
               id, spec_id, criterion_element_id, revision_id, execution_id,
               verdict_kind, evidence_ids_json, verdict_at, stale_at, stale_reason
             ) VALUES (?, ?, ?, ?, NULL, 'human', ?, ?, NULL, NULL)`,
            )
            .run(
              "verdict-dangling-evidence",
              SPEC_ID,
              "criterion-cutover",
              REVISION_ID,
              '["evidence-legacy"]',
              TIMESTAMP,
            );
          fixture.db
            .prepare(
              `INSERT INTO spec_task_claims (
               id, spec_id, task_element_id, execution_id, actor_json,
               evidence_ids_json, claimed_at, status
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'accepted')`,
            )
            .run(
              "task-claim-dangling-evidence",
              SPEC_ID,
              "task-cutover",
              '{"kind":"human"}',
              '["evidence-legacy"]',
              TIMESTAMP,
            );
        },
      }),
    ).rejects.toThrow(
      "Native-SDD v2 cutover postcondition failed: evidenceSourceEvents=1, proofVerdictEvidence=1, taskClaimEvidence=1",
    );

    expectSameBytes(fixture.db.serialize(), databaseBefore, "databaseBefore");
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);
  });

  it("purges a merge-job link citing a legacy execution and rolls back a surviving one", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };
    const databaseBefore = fixture.db.serialize();
    const workflowsBefore = snapshotWorkflowStore(fixture.configDir);

    await expect(
      runNativeSddV2Cutover(context, {
        reach(point): void {
          if (point !== "after_relational_delete") return;
          fixture.db
            .prepare(
              `INSERT INTO spec_links (
                 id, spec_id, object_kind, object_ref_json, direction, category,
                 snapshot_json, element_ids_json, actor_json, created_at
               ) VALUES (?, ?, 'merge_job', ?, 'outbound', 'source', ?, NULL, ?, ?)`,
            )
            .run(
              "link-dangling-merge-job",
              SPEC_ID,
              JSON.stringify({
                specExecutionId: ACTIVE_SPEC_EXECUTION_ID,
                mergeHash: "1".repeat(40),
              }),
              JSON.stringify({ revisionId: REVISION_ID }),
              '{"kind":"system"}',
              TIMESTAMP,
            );
        },
      }),
    ).rejects.toThrow(
      "Native-SDD v2 cutover postcondition failed: specLinkExecutionRefs=1",
    );

    expectSameBytes(fixture.db.serialize(), databaseBefore, "databaseBefore");
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);

    const applied = await runNativeSddV2Cutover(context);
    expect(applied.applied).toBe(true);
    expect(fixture.db.prepare("SELECT id FROM spec_links").all()).toEqual([]);
  });

  it("purges evidence reachable only through a legacy merge-job reference and rolls back a surviving one", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };
    const databaseBefore = fixture.db.serialize();
    const workflowsBefore = snapshotWorkflowStore(fixture.configDir);

    await expect(
      runNativeSddV2Cutover(context, {
        reach(point): void {
          if (point !== "after_relational_delete") return;
          fixture.db
            .prepare(
              `INSERT INTO spec_evidence (
                 id, spec_id, criterion_element_id, revision_id, kind, ref_json,
                 evaluated_state_json, producer_json, execution_id,
                 source_event_id, created_at
               ) VALUES (?, ?, ?, ?, 'commit', ?, ?, ?, NULL, NULL, ?)`,
            )
            .run(
              "evidence-dangling-merge-validation",
              SPEC_ID,
              "criterion-cutover",
              REVISION_ID,
              JSON.stringify({
                type: "merge_validation",
                mergeJobId: MERGE_JOB_ID,
                validationRef: "validation-legacy",
              }),
              '{"kind":"legacy-merge-validation"}',
              '{"kind":"human"}',
              TIMESTAMP,
            );
        },
      }),
    ).rejects.toThrow(
      "Native-SDD v2 cutover postcondition failed: evidenceMergeJobRefs=1",
    );

    expectSameBytes(fixture.db.serialize(), databaseBefore, "databaseBefore");
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);

    const applied = await runNativeSddV2Cutover(context);
    expect(applied.applied).toBe(true);
    expect(fixture.db.prepare("SELECT id FROM spec_evidence").all()).toEqual(
      [],
    );
    expect(fixture.db.prepare("SELECT job_id FROM job_records").all()).toEqual(
      [],
    );
  });

  it("purges evidence reachable only through a legacy workflow-event reference and rolls back a surviving one", async () => {
    const fixture = createFixture("completed");
    const context = { db: fixture.db, configDir: fixture.configDir };
    const databaseBefore = fixture.db.serialize();
    const workflowsBefore = snapshotWorkflowStore(fixture.configDir);
    const graphEventId = (
      fixture.db
        .prepare(
          "SELECT id FROM graph_workflow_events WHERE execution_id = ? ORDER BY id",
        )
        .get(ACTIVE_WORKFLOW_EXECUTION_ID) as { id: number }
    ).id;

    await expect(
      runNativeSddV2Cutover(context, {
        reach(point): void {
          if (point !== "after_relational_delete") return;
          fixture.db
            .prepare(
              `INSERT INTO spec_evidence (
                 id, spec_id, criterion_element_id, revision_id, kind, ref_json,
                 evaluated_state_json, producer_json, execution_id,
                 source_event_id, created_at
               ) VALUES (?, ?, ?, ?, 'test_run', ?, ?, ?, NULL, NULL, ?)`,
            )
            .run(
              "evidence-dangling-workflow-event",
              SPEC_ID,
              "criterion-cutover",
              REVISION_ID,
              JSON.stringify({
                type: "workflow_event",
                workflowExecutionId: ACTIVE_WORKFLOW_EXECUTION_ID,
                eventId: graphEventId,
                contextId: "legacy-context",
              }),
              '{"kind":"legacy-workflow-event"}',
              '{"kind":"human"}',
              TIMESTAMP,
            );
        },
      }),
    ).rejects.toThrow(
      "Native-SDD v2 cutover postcondition failed: evidenceWorkflowEventRefs=1",
    );

    expectSameBytes(fixture.db.serialize(), databaseBefore, "databaseBefore");
    expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);

    const applied = await runNativeSddV2Cutover(context);
    expect(applied.applied).toBe(true);
    expect(
      fixture.db.prepare("SELECT id FROM spec_evidence ORDER BY id").all(),
    ).toEqual([]);
    expect(
      fixture.db
        .prepare("SELECT id FROM spec_proof_verdicts ORDER BY id")
        .all(),
    ).toEqual([]);
    expect(
      fixture.db.prepare("SELECT id FROM spec_task_claims ORDER BY id").all(),
    ).toEqual([]);
  });

  it.each(PRECOMMIT_FAILURE_POINTS)(
    "restores both stores and deterministically retries after %s",
    async (failurePoint) => {
      const fixture = createFixture("completed");
      const context = { db: fixture.db, configDir: fixture.configDir };
      const databaseBefore = fixture.db.serialize();
      const workflowsBefore = snapshotWorkflowStore(fixture.configDir);

      await expect(
        runNativeSddV2Cutover(context, failureHook(failurePoint)),
      ).rejects.toThrow(`injected cutover failure at ${failurePoint}`);

      expectSameBytes(fixture.db.serialize(), databaseBefore, "databaseBefore");
      expect(snapshotWorkflowStore(fixture.configDir)).toEqual(workflowsBefore);
      expect(existsSync(manifestPathFor(fixture.configDir))).toBe(false);
      expect(
        fixture.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version = 9")
          .get(),
      ).toBeUndefined();
      expect(logSpies.warn).toHaveBeenCalledWith(
        "state-store.native_sdd_v2_cutover_precommit_restored",
        expect.objectContaining({ definitionCount: 4 }),
      );

      const retry = await runNativeSddV2Cutover(context);
      expect(retry.applied).toBe(true);
      expect(readManifestPhase(fixture.configDir)).toBe("complete");
      expect(inspectNativeSddV2Cutover(context).counts).toEqual(EMPTY_COUNTS);
    },
  );

  it.each(POSTCOMMIT_FAILURE_POINTS)(
    "uses the committed schema witness to finish recovery after %s",
    async (failurePoint) => {
      const fixture = createFixture("completed");
      const context = { db: fixture.db, configDir: fixture.configDir };

      await expect(
        runNativeSddV2Cutover(context, failureHook(failurePoint)),
      ).rejects.toThrow(`injected cutover failure at ${failurePoint}`);

      expect(
        fixture.db
          .prepare(
            "SELECT 1 AS present FROM schema_migrations WHERE version = 9",
          )
          .get(),
      ).toEqual({ present: 1 });
      expect(inspectNativeSddV2Cutover(context).counts).toEqual(EMPTY_COUNTS);
      const retry = await runNativeSddV2Cutover(context);
      expect(retry.applied).toBe(false);
      expect(readManifestPhase(fixture.configDir)).toBe("complete");
      expect(
        readdirSync(fixture.configDir).some((entry) =>
          entry.startsWith("native-sdd-v2-cutover-quarantine-"),
        ),
      ).toBe(false);
      expect(logSpies.info).toHaveBeenCalledWith(
        "state-store.native_sdd_v2_cutover_recovered_postcommit",
        expect.objectContaining({ manifestId: expect.any(String) }),
      );
    },
  );
});
