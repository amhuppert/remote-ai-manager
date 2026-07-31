import Database from "better-sqlite3";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigDirPath } from "../config/loader";
import { createLogger } from "@/lib/logging";
import {
  deleteGlobalValue,
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "../shared/global-singleton";
import {
  enforceCurrentSchemaCompatibility,
  enforceSchemaCompatibilityBarrier,
} from "./schema-compatibility";

const logger = createLogger("state-store/state-db");

type Db = InstanceType<typeof Database>;

const GLOBAL_KEY = "__cc_state_db" as const;
const DB_FILE_NAME = "command-center.db";

/**
 * Highest schema migration version this build understands. Forward-only rule:
 * a protocol-aware build refuses a higher external barrier before opening
 * SQLite and also rejects a higher ledger version under each migration's write
 * lock. The protocol is not a lifetime lease: every lower-version process that
 * already holds a connection must be quiesced during a breaking cutover, and a
 * pre-protocol binary must also be prevented from reopening afterward.
 *
 * Version 1 is the `AgentSessionRef` shape cutover: migration
 * `0005-agent-session-ref-shape` rewrites every persisted ref to the canonical
 * `{backend, ref}` (dropping the legacy `sessionId`/`threadId` handle key) and
 * stamps `schema_migrations` version 1.
 *
 * Version 2 is the evidence-kind narrowing: migration
 * `0009-narrow-evidence-kinds` rewrites persisted validation strategies to
 * the machine-provable vocabulary and deletes dropped-kind evidence. The bump
 * guards against old-build writes — an older build's wide enum and the legacy
 * permissive `spec_evidence` CHECK would re-insert dropped-kind rows the new
 * strict read path hard-fails on.
 */
export const KNOWN_SCHEMA_VERSION = 2;

/**
 * Marker id for the one-time legacy graph-workflow purge. Tracked in the
 * dedicated `applied_data_migrations` table — NOT in `schema_migrations` —
 * so it never advances `MAX(version)` and therefore cannot trip the
 * forward-only version gate. Tracking the purge in its own bookkeeping table
 * keeps `MAX(schema_migrations.version)` unaffected, so this data reset does
 * not, on its own, brick older builds that share `command-center.db`.
 */
export const LEGACY_WORKFLOW_PURGE_MIGRATION_ID =
  "graph-workflow-charter-legacy-purge";

/**
 * Durable cleanup witness committed with the SQLite reset and completion
 * marker, after the legacy workflows directory has been captured and its
 * parent directory entries have been synced.
 */
export const LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID =
  "graph-workflow-charter-legacy-purge:pending";

/**
 * Permanent capture sentinel for the purge's filesystem phase. Its captured
 * root remains after cleanup so a delayed retry can never mistake a newly
 * created live `workflows/` directory for pre-migration data.
 */
export const LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME =
  ".graph-workflow-charter-legacy-purge";

const LEGACY_WORKFLOW_PURGE_CAPTURE_DIR_NAME = "captured-workflows";

export interface LegacyWorkflowPurgeFsOps {
  exists(targetPath: string): boolean;
  makeDir(dirPath: string): void;
  rename(from: string, to: string): void;
  list(dirPath: string): string[];
  remove(targetPath: string): void;
  syncDirectory(dirPath: string): void;
}

function syncDirectory(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch (err) {
    if (!isUnsupportedDirectorySyncError(err)) throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing actionable if closing the directory descriptor fails.
      }
    }
  }
}

const defaultLegacyWorkflowPurgeFsOps: LegacyWorkflowPurgeFsOps = {
  exists: existsSync,
  makeDir(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true });
  },
  rename: renameSync,
  list: readdirSync,
  remove(targetPath: string): void {
    rmSync(targetPath, { recursive: true, force: true });
  },
  syncDirectory,
};

let legacyWorkflowPurgeFsOps = defaultLegacyWorkflowPurgeFsOps;

export function _setLegacyWorkflowPurgeFsOpsForTesting(
  overrides: Partial<LegacyWorkflowPurgeFsOps> | null,
): void {
  legacyWorkflowPurgeFsOps =
    overrides === null
      ? defaultLegacyWorkflowPurgeFsOps
      : { ...defaultLegacyWorkflowPurgeFsOps, ...overrides };
}

const NOTIFICATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS notifications (
    id                    TEXT PRIMARY KEY,
    source                TEXT NOT NULL DEFAULT 'job',
    type                  TEXT NOT NULL,
    title                 TEXT NOT NULL,
    message               TEXT NOT NULL,
    read                  INTEGER NOT NULL DEFAULT 0,
    project_name          TEXT NOT NULL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    session_name          TEXT,
    branch_name           TEXT,
    job_id                TEXT,
    job_type              TEXT,
    merge_hash            TEXT,
    commit_hash           TEXT,
    conflict_count        INTEGER,
    conflict_files        TEXT,
    target_branch         TEXT,
    conversation_id       TEXT,
    conversation_name     TEXT,
    conversation_status   TEXT,
    dedupe_key            TEXT,
    error_message         TEXT,
    spec_id               TEXT,
    spec_slug             TEXT,
    spec_name             TEXT,
    spec_gate             TEXT,
    spec_gate_request_id  TEXT,
    spec_deep_link_id     TEXT,
    spec_approval_id      TEXT,
    CHECK (
      (source = 'job'
        AND session_name IS NOT NULL
        AND branch_name IS NOT NULL
        AND job_id IS NOT NULL
        AND job_type IS NOT NULL
        AND conversation_id IS NULL)
      OR
      (source = 'project-conversation'
        AND conversation_id IS NOT NULL
        AND conversation_status IS NOT NULL
        AND session_name IS NULL
        AND branch_name IS NULL
        AND job_id IS NULL
        AND job_type IS NULL)
      OR
      (source = 'spec'
        AND spec_id IS NOT NULL
        AND spec_slug IS NOT NULL
        AND spec_name IS NOT NULL
        AND spec_gate IS NOT NULL
        AND spec_gate_request_id IS NOT NULL
        AND spec_deep_link_id IS NOT NULL
        AND conversation_id IS NULL
        AND branch_name IS NULL
        AND job_id IS NULL
        AND job_type IS NULL)
    )
  );
`;

const NOTIFICATIONS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
  CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_session
    ON notifications(project_name, session_name);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_conversation
    ON notifications(project_name, conversation_id)
    WHERE source = 'project-conversation';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(dedupe_key)
    WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_notifications_spec_request
    ON notifications(spec_id, spec_gate_request_id, created_at DESC)
    WHERE source = 'spec';
`;

const SPEC_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS specs (
    id                TEXT PRIMARY KEY,
    project_path      TEXT NOT NULL,
    slug              TEXT NOT NULL,
    name              TEXT NOT NULL,
    gate_policy_json  TEXT NOT NULL,
    abandoned_at      TEXT,
    abandoned_reason  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_path, slug),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_specs_project_updated
    ON specs (project_path, updated_at DESC);

  CREATE TABLE IF NOT EXISTS spec_aliases (
    project_path  TEXT NOT NULL,
    slug          TEXT NOT NULL,
    spec_id       TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_path, slug),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_aliases_spec
    ON spec_aliases (spec_id);

  CREATE TABLE IF NOT EXISTS spec_counters (
    spec_id      TEXT NOT NULL,
    scope_key    TEXT NOT NULL CHECK (
      scope_key IN ('R', 'D', 'T', 'Q', 'A') OR scope_key GLOB 'C:?*'
    ),
    last_number  INTEGER NOT NULL CHECK (last_number >= 0),
    PRIMARY KEY (spec_id, scope_key),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS spec_elements (
    id                 TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN (
      'section', 'requirement', 'criterion', 'decision', 'task'
    )),
    number             INTEGER CHECK (number > 0),
    parent_element_id  TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_element_id) REFERENCES spec_elements(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_elements_spec_kind_number
    ON spec_elements (spec_id, kind, number);
  CREATE INDEX IF NOT EXISTS idx_spec_elements_parent
    ON spec_elements (parent_element_id);

  CREATE TABLE IF NOT EXISTS spec_revisions (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    number                INTEGER NOT NULL CHECK (number > 0),
    state                 TEXT NOT NULL CHECK (state IN (
      'draft', 'proposed', 'approved', 'withdrawn'
    )),
    authoring_stage       TEXT NOT NULL DEFAULT 'plan' CHECK (
      authoring_stage IN ('requirements', 'design', 'plan')
    ),
    based_on_revision_id  TEXT,
    content_hash          TEXT,
    proposed_at           TEXT,
    approved_at           TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (based_on_revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_revisions_spec_state
    ON spec_revisions (spec_id, state, number DESC);

  CREATE TABLE IF NOT EXISTS spec_element_versions (
    revision_id     TEXT NOT NULL,
    element_id      TEXT NOT NULL,
    position        INTEGER NOT NULL CHECK (position >= 0),
    payload_json    TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    element_version INTEGER NOT NULL CHECK (element_version > 0),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (revision_id, element_id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_element_versions_element
    ON spec_element_versions (element_id, revision_id);
  CREATE INDEX IF NOT EXISTS idx_spec_element_versions_order
    ON spec_element_versions (revision_id, position);

  CREATE TABLE IF NOT EXISTS spec_executions (
    id                     TEXT PRIMARY KEY,
    spec_id                TEXT NOT NULL,
    revision_id            TEXT NOT NULL,
    scope_json             TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN (
      'definition_review', 'running', 'delivered', 'abandoned'
    )),
    execution_start_dial   TEXT CHECK (execution_start_dial IN (
      'gate', 'notify', 'off'
    )),
    workflow_definition_id TEXT NOT NULL,
    workflow_definition_revision INTEGER CHECK (
      workflow_definition_revision > 0
    ),
    workflow_execution_id  TEXT,
    session_name           TEXT,
    delivered_at           TEXT,
    abandoned_reason       TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_executions_spec_state
    ON spec_executions (spec_id, state, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_executions_workflow_execution
    ON spec_executions (workflow_execution_id)
    WHERE workflow_execution_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_approvals (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    subject_kind  TEXT NOT NULL CHECK (subject_kind IN (
      'requirement', 'decision', 'revision', 'plan'
    )),
    element_id    TEXT,
    revision_id   TEXT NOT NULL,
    approver      TEXT NOT NULL,
    granted_at    TEXT NOT NULL,
    validity      TEXT NOT NULL CHECK (validity IN ('valid', 'stale', 'closed')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_approvals_revision_validity
    ON spec_approvals (spec_id, revision_id, validity);
  CREATE INDEX IF NOT EXISTS idx_spec_approvals_subject
    ON spec_approvals (spec_id, subject_kind, element_id);

  CREATE TABLE IF NOT EXISTS spec_gate_admissions (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    gate          TEXT NOT NULL CHECK (gate IN (
      'requirements', 'design', 'plan', 'execution_start', 'delivery'
    )),
    basis         TEXT NOT NULL CHECK (basis IN (
      'human_approval', 'notify_policy', 'off_policy'
    )),
    approval_id   TEXT,
    revision_id   TEXT,
    execution_id  TEXT,
    actor_json    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (approval_id) REFERENCES spec_approvals(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_gate_admissions_spec_gate
    ON spec_gate_admissions (spec_id, gate, created_at DESC);

  CREATE TABLE IF NOT EXISTS spec_questions (
    id               TEXT PRIMARY KEY,
    spec_id          TEXT NOT NULL,
    number           INTEGER NOT NULL CHECK (number > 0),
    element_id       TEXT,
    text             TEXT NOT NULL,
    provenance_json  TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('open', 'answered')),
    answer           TEXT,
    answered_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_questions_spec_status
    ON spec_questions (spec_id, status, number);

  CREATE TABLE IF NOT EXISTS spec_assumptions (
    id                TEXT PRIMARY KEY,
    spec_id           TEXT NOT NULL,
    number            INTEGER NOT NULL CHECK (number > 0),
    element_id        TEXT,
    text              TEXT NOT NULL,
    proposed_by_json  TEXT NOT NULL,
    disposition       TEXT NOT NULL CHECK (disposition IN (
      'proposed', 'confirmed', 'rejected', 'deferred'
    )),
    disposed_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_assumptions_spec_disposition
    ON spec_assumptions (spec_id, disposition, number);

  CREATE TABLE IF NOT EXISTS spec_comments (
    id                 TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    thread_id          TEXT NOT NULL,
    parent_comment_id  TEXT,
    element_id         TEXT NOT NULL,
    anchor_json        TEXT NOT NULL,
    revision_id        TEXT NOT NULL,
    body               TEXT NOT NULL,
    author_json        TEXT NOT NULL,
    blocking           INTEGER NOT NULL CHECK (blocking IN (0, 1)),
    resolution         TEXT NOT NULL CHECK (resolution IN (
      'open', 'resolved', 'dismissed'
    )),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_comment_id) REFERENCES spec_comments(id),
    FOREIGN KEY (element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_comments_element_resolution
    ON spec_comments (spec_id, element_id, resolution);
  CREATE INDEX IF NOT EXISTS idx_spec_comments_thread
    ON spec_comments (thread_id, created_at);

  CREATE TABLE IF NOT EXISTS spec_evidence (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN (
      'commit', 'test_run', 'validator_verdict'
    )),
    ref_json              TEXT NOT NULL,
    evaluated_state_json  TEXT NOT NULL,
    producer_json         TEXT NOT NULL,
    execution_id          TEXT,
    source_event_id       INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_evidence_criterion_revision
    ON spec_evidence (criterion_element_id, revision_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_spec_evidence_execution
    ON spec_evidence (execution_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_spec_evidence_source_event
    ON spec_evidence (source_event_id)
    WHERE source_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_proof_verdicts (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    execution_id          TEXT,
    verdict_kind          TEXT NOT NULL CHECK (verdict_kind IN (
      'deterministic_validator', 'agent_validator', 'human'
    )),
    evidence_ids_json     TEXT NOT NULL,
    verdict_at            TEXT NOT NULL,
    stale_at              TEXT,
    stale_reason          TEXT,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_proof_verdicts_criterion_revision
    ON spec_proof_verdicts (criterion_element_id, revision_id, verdict_at);
  CREATE INDEX IF NOT EXISTS idx_spec_proof_verdicts_execution
    ON spec_proof_verdicts (execution_id, verdict_at);

  CREATE TABLE IF NOT EXISTS spec_waivers (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    reason                TEXT NOT NULL CHECK (length(reason) > 0),
    waived_at             TEXT NOT NULL,
    stale                 INTEGER NOT NULL CHECK (stale IN (0, 1)),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_waivers_criterion_revision
    ON spec_waivers (criterion_element_id, revision_id);

  CREATE TABLE IF NOT EXISTS spec_criterion_dispositions (
    execution_id               TEXT NOT NULL,
    criterion_element_id       TEXT NOT NULL,
    disposition                TEXT NOT NULL CHECK (disposition IN (
      'in_scope', 'deferred', 'waived', 'delivered_elsewhere'
    )),
    waiver_id                  TEXT,
    delivered_by_execution_id  TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (execution_id, criterion_element_id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (waiver_id) REFERENCES spec_waivers(id),
    FOREIGN KEY (delivered_by_execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_criterion_dispositions_criterion
    ON spec_criterion_dispositions (criterion_element_id, disposition);

  CREATE TABLE IF NOT EXISTS spec_task_claims (
    id                 TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    task_element_id    TEXT NOT NULL,
    execution_id       TEXT,
    actor_json         TEXT NOT NULL,
    evidence_ids_json  TEXT NOT NULL,
    claimed_at         TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('accepted', 'reopened')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (task_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_task_claims_task_execution
    ON spec_task_claims (task_element_id, execution_id, claimed_at DESC);

  CREATE TABLE IF NOT EXISTS spec_links (
    id                TEXT PRIMARY KEY,
    spec_id           TEXT NOT NULL,
    object_kind       TEXT NOT NULL CHECK (object_kind IN (
      'ticket', 'conversation', 'session', 'workflow_execution', 'merge_job'
    )),
    object_ref_json   TEXT NOT NULL,
    direction         TEXT NOT NULL,
    category          TEXT NOT NULL CHECK (category IN (
      'graduated_from', 'materialized_from', 'reference', 'source'
    )),
    snapshot_json     TEXT,
    element_ids_json  TEXT,
    actor_json        TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_links_spec_category
    ON spec_links (spec_id, category, created_at);
  CREATE INDEX IF NOT EXISTS idx_spec_links_object
    ON spec_links (object_kind, object_ref_json);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_links_entry_identity
    ON spec_links (object_kind, object_ref_json, category)
    WHERE (object_kind = 'conversation' AND category = 'source')
       OR (object_kind = 'ticket' AND category = 'graduated_from');

  CREATE TABLE IF NOT EXISTS spec_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id       TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    actor_json    TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_events_spec_order
    ON spec_events (spec_id, id);
  CREATE INDEX IF NOT EXISTS idx_spec_events_type_order
    ON spec_events (event_type, id);
`;

const SPEC_SCHEMA_DDL_DUPLICATE = `
  CREATE TABLE IF NOT EXISTS specs (
    id                TEXT PRIMARY KEY,
    project_path      TEXT NOT NULL,
    slug              TEXT NOT NULL,
    name              TEXT NOT NULL,
    gate_policy_json  TEXT NOT NULL,
    abandoned_at      TEXT,
    abandoned_reason  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_path, slug),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_specs_project_updated
    ON specs (project_path, updated_at DESC);

  CREATE TABLE IF NOT EXISTS spec_aliases (
    project_path  TEXT NOT NULL,
    slug          TEXT NOT NULL,
    spec_id       TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_path, slug),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_aliases_spec
    ON spec_aliases (spec_id);

  CREATE TABLE IF NOT EXISTS spec_counters (
    spec_id      TEXT NOT NULL,
    scope_key    TEXT NOT NULL CHECK (
      scope_key IN ('R', 'D', 'T', 'Q', 'A') OR scope_key GLOB 'C:?*'
    ),
    last_number  INTEGER NOT NULL CHECK (last_number >= 0),
    PRIMARY KEY (spec_id, scope_key),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS spec_elements (
    id                 TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN (
      'section', 'requirement', 'criterion', 'decision', 'task'
    )),
    number             INTEGER CHECK (number > 0),
    parent_element_id  TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_element_id) REFERENCES spec_elements(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_elements_spec_kind_number
    ON spec_elements (spec_id, kind, number);
  CREATE INDEX IF NOT EXISTS idx_spec_elements_parent
    ON spec_elements (parent_element_id);

  CREATE TABLE IF NOT EXISTS spec_revisions (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    number                INTEGER NOT NULL CHECK (number > 0),
    state                 TEXT NOT NULL CHECK (state IN (
      'draft', 'proposed', 'approved', 'withdrawn'
    )),
    authoring_stage       TEXT NOT NULL DEFAULT 'plan' CHECK (
      authoring_stage IN ('requirements', 'design', 'plan')
    ),
    based_on_revision_id  TEXT,
    content_hash          TEXT,
    proposed_at           TEXT,
    approved_at           TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (based_on_revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_revisions_spec_state
    ON spec_revisions (spec_id, state, number DESC);

  CREATE TABLE IF NOT EXISTS spec_element_versions (
    revision_id     TEXT NOT NULL,
    element_id      TEXT NOT NULL,
    position        INTEGER NOT NULL CHECK (position >= 0),
    payload_json    TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    element_version INTEGER NOT NULL CHECK (element_version > 0),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (revision_id, element_id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_element_versions_element
    ON spec_element_versions (element_id, revision_id);
  CREATE INDEX IF NOT EXISTS idx_spec_element_versions_order
    ON spec_element_versions (revision_id, position);

  CREATE TABLE IF NOT EXISTS spec_executions (
    id                     TEXT PRIMARY KEY,
    spec_id                TEXT NOT NULL,
    revision_id            TEXT NOT NULL,
    scope_json             TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN (
      'definition_review', 'running', 'delivered', 'abandoned'
    )),
    execution_start_dial   TEXT CHECK (execution_start_dial IN (
      'gate', 'notify', 'off'
    )),
    workflow_definition_id TEXT NOT NULL,
    workflow_definition_revision INTEGER CHECK (
      workflow_definition_revision > 0
    ),
    workflow_execution_id  TEXT,
    session_name           TEXT,
    delivered_at           TEXT,
    abandoned_reason       TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_executions_spec_state
    ON spec_executions (spec_id, state, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_executions_workflow_execution
    ON spec_executions (workflow_execution_id)
    WHERE workflow_execution_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_approvals (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    subject_kind  TEXT NOT NULL CHECK (subject_kind IN (
      'requirement', 'decision', 'revision', 'plan'
    )),
    element_id    TEXT,
    revision_id   TEXT NOT NULL,
    approver      TEXT NOT NULL,
    granted_at    TEXT NOT NULL,
    validity      TEXT NOT NULL CHECK (validity IN ('valid', 'stale', 'closed')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_approvals_revision_validity
    ON spec_approvals (spec_id, revision_id, validity);
  CREATE INDEX IF NOT EXISTS idx_spec_approvals_subject
    ON spec_approvals (spec_id, subject_kind, element_id);

  CREATE TABLE IF NOT EXISTS spec_gate_admissions (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    gate          TEXT NOT NULL CHECK (gate IN (
      'requirements', 'design', 'plan', 'execution_start', 'delivery'
    )),
    basis         TEXT NOT NULL CHECK (basis IN (
      'human_approval', 'notify_policy', 'off_policy'
    )),
    approval_id   TEXT,
    revision_id   TEXT,
    execution_id  TEXT,
    actor_json    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (approval_id) REFERENCES spec_approvals(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_gate_admissions_spec_gate
    ON spec_gate_admissions (spec_id, gate, created_at DESC);

  CREATE TABLE IF NOT EXISTS spec_questions (
    id               TEXT PRIMARY KEY,
    spec_id          TEXT NOT NULL,
    number           INTEGER NOT NULL CHECK (number > 0),
    element_id       TEXT,
    text             TEXT NOT NULL,
    provenance_json  TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('open', 'answered')),
    answer           TEXT,
    answered_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_questions_spec_status
    ON spec_questions (spec_id, status, number);

  CREATE TABLE IF NOT EXISTS spec_assumptions (
    id                TEXT PRIMARY KEY,
    spec_id           TEXT NOT NULL,
    number            INTEGER NOT NULL CHECK (number > 0),
    element_id        TEXT,
    text              TEXT NOT NULL,
    proposed_by_json  TEXT NOT NULL,
    disposition       TEXT NOT NULL CHECK (disposition IN (
      'proposed', 'confirmed', 'rejected', 'deferred'
    )),
    disposed_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id) REFERENCES spec_elements(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_assumptions_spec_disposition
    ON spec_assumptions (spec_id, disposition, number);

  CREATE TABLE IF NOT EXISTS spec_comments (
    id                 TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    thread_id          TEXT NOT NULL,
    parent_comment_id  TEXT,
    element_id         TEXT NOT NULL,
    anchor_json        TEXT NOT NULL,
    revision_id        TEXT NOT NULL,
    body               TEXT NOT NULL,
    author_json        TEXT NOT NULL,
    blocking           INTEGER NOT NULL CHECK (blocking IN (0, 1)),
    resolution         TEXT NOT NULL CHECK (resolution IN (
      'open', 'resolved', 'dismissed'
    )),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_comment_id) REFERENCES spec_comments(id),
    FOREIGN KEY (element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_comments_element_resolution
    ON spec_comments (spec_id, element_id, resolution);
  CREATE INDEX IF NOT EXISTS idx_spec_comments_thread
    ON spec_comments (thread_id, created_at);

  CREATE TABLE IF NOT EXISTS spec_evidence (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN (
      'commit', 'test_run', 'validator_verdict'
    )),
    ref_json              TEXT NOT NULL,
    evaluated_state_json  TEXT NOT NULL,
    producer_json         TEXT NOT NULL,
    execution_id          TEXT,
    source_event_id       INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_evidence_criterion_revision
    ON spec_evidence (criterion_element_id, revision_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_spec_evidence_execution
    ON spec_evidence (execution_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_spec_evidence_source_event
    ON spec_evidence (source_event_id)
    WHERE source_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_proof_verdicts (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    execution_id          TEXT,
    verdict_kind          TEXT NOT NULL CHECK (verdict_kind IN (
      'deterministic_validator', 'agent_validator', 'human'
    )),
    evidence_ids_json     TEXT NOT NULL,
    verdict_at            TEXT NOT NULL,
    stale_at              TEXT,
    stale_reason          TEXT,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_proof_verdicts_criterion_revision
    ON spec_proof_verdicts (criterion_element_id, revision_id, verdict_at);
  CREATE INDEX IF NOT EXISTS idx_spec_proof_verdicts_execution
    ON spec_proof_verdicts (execution_id, verdict_at);

  CREATE TABLE IF NOT EXISTS spec_waivers (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    criterion_element_id  TEXT NOT NULL,
    revision_id           TEXT NOT NULL,
    reason                TEXT NOT NULL CHECK (length(reason) > 0),
    waived_at             TEXT NOT NULL,
    stale                 INTEGER NOT NULL CHECK (stale IN (0, 1)),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_waivers_criterion_revision
    ON spec_waivers (criterion_element_id, revision_id);

  CREATE TABLE IF NOT EXISTS spec_criterion_dispositions (
    execution_id               TEXT NOT NULL,
    criterion_element_id       TEXT NOT NULL,
    disposition                TEXT NOT NULL CHECK (disposition IN (
      'in_scope', 'deferred', 'waived', 'delivered_elsewhere'
    )),
    waiver_id                  TEXT,
    delivered_by_execution_id  TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (execution_id, criterion_element_id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (waiver_id) REFERENCES spec_waivers(id),
    FOREIGN KEY (delivered_by_execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_criterion_dispositions_criterion
    ON spec_criterion_dispositions (criterion_element_id, disposition);

  CREATE TABLE IF NOT EXISTS spec_task_claims (
    id                 TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    task_element_id    TEXT NOT NULL,
    execution_id       TEXT,
    actor_json         TEXT NOT NULL,
    evidence_ids_json  TEXT NOT NULL,
    claimed_at         TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('accepted', 'reopened')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (task_element_id) REFERENCES spec_elements(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_task_claims_task_execution
    ON spec_task_claims (task_element_id, execution_id, claimed_at DESC);

  CREATE TABLE IF NOT EXISTS spec_links (
    id                TEXT PRIMARY KEY,
    spec_id           TEXT NOT NULL,
    object_kind       TEXT NOT NULL CHECK (object_kind IN (
      'ticket', 'conversation', 'session', 'workflow_execution', 'merge_job'
    )),
    object_ref_json   TEXT NOT NULL,
    direction         TEXT NOT NULL,
    category          TEXT NOT NULL CHECK (category IN (
      'graduated_from', 'materialized_from', 'reference', 'source'
    )),
    snapshot_json     TEXT,
    element_ids_json  TEXT,
    actor_json        TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_links_spec_category
    ON spec_links (spec_id, category, created_at);
  CREATE INDEX IF NOT EXISTS idx_spec_links_object
    ON spec_links (object_kind, object_ref_json);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_links_entry_identity
    ON spec_links (object_kind, object_ref_json, category)
    WHERE (object_kind = 'conversation' AND category = 'source')
       OR (object_kind = 'ticket' AND category = 'graduated_from');

  CREATE TABLE IF NOT EXISTS spec_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id       TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    actor_json    TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_events_spec_order
    ON spec_events (spec_id, id);
  CREATE INDEX IF NOT EXISTS idx_spec_events_type_order
    ON spec_events (event_type, id);
`;
void SPEC_SCHEMA_DDL_DUPLICATE;

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applied_data_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Ledger for the Umzug-driven migration runner (see migrator.ts): one row per
  -- applied migration, keyed by name. Distinct from schema_migrations (the
  -- forward-only compatibility-version gate for breaking changes) and from
  -- applied_data_migrations (the legacy one-off purge marker). New migrations
  -- go here.
  CREATE TABLE IF NOT EXISTS applied_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    root_path                  TEXT PRIMARY KEY,
    archived                   INTEGER NOT NULL DEFAULT 0,
    pinned                     INTEGER NOT NULL DEFAULT 0,
    pin_order                  INTEGER,
    mcp_overrides              TEXT,
    agent_capability_overrides TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);
  CREATE INDEX IF NOT EXISTS idx_projects_pinned ON projects(pinned, pin_order);

  CREATE TABLE IF NOT EXISTS sessions (
    project_path                       TEXT NOT NULL,
    session_name                       TEXT NOT NULL,
    worktree_path                      TEXT NOT NULL,
    branch_name                        TEXT NOT NULL,
    created_at                         TEXT NOT NULL,
    last_activity_at                   TEXT NOT NULL,
    archived                           INTEGER NOT NULL DEFAULT 0,
    finished                           INTEGER NOT NULL DEFAULT 0,
    source                             TEXT NOT NULL DEFAULT 'cc',
    objective                          TEXT,
    creation_mode                      TEXT NOT NULL DEFAULT 'normal',
    tdd_enabled                        INTEGER NOT NULL DEFAULT 1,
    target_branch                      TEXT NOT NULL DEFAULT 'main',
    parent_session_name                TEXT,
    graph_workflow_execution           TEXT,
    graph_workflow_execution_history   TEXT NOT NULL DEFAULT '[]',
    workflow_envelopes                 TEXT,
    workflow_lanes                     TEXT,
    mcp_overrides                      TEXT,
    agent_capability_overrides         TEXT,
    spawned_from                       TEXT,
    PRIMARY KEY (project_path, session_name),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);

  CREATE TABLE IF NOT EXISTS conversations (
    id                    TEXT PRIMARY KEY,
    project_path          TEXT NOT NULL,
    session_name          TEXT NOT NULL,
    name                  TEXT,
    transcript_path       TEXT,
    status                TEXT NOT NULL,
    prompt_count          INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    last_activity_at      TEXT NOT NULL,
    source                TEXT NOT NULL DEFAULT 'cc',
    summary               TEXT,
    archived              INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL,
    total_duration_ms     INTEGER,
    total_turns           INTEGER,
    pending_question_id   TEXT,
    pending_questions     TEXT,
    pending_prompt_text   TEXT,
    forked_from           TEXT,
    role                  TEXT,
    context_tokens        INTEGER,
    context_window_max    INTEGER,
    debug_mode            TEXT,
    machine_snapshot      TEXT,
    agent_backend         TEXT NOT NULL DEFAULT 'claude',
    backend_ref           TEXT,
    mcp_overrides         TEXT,
    mcp_runtime           TEXT,
    agent_capability_overrides TEXT,
    agent_capabilities_runtime TEXT,
    unread                INTEGER NOT NULL DEFAULT 0,
    pending_queue         TEXT,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_session
    ON conversations(project_path, session_name);
  CREATE INDEX IF NOT EXISTS idx_conversations_last_activity
    ON conversations(last_activity_at);

  CREATE TABLE IF NOT EXISTS project_conversations (
    id                    TEXT PRIMARY KEY,
    project_path          TEXT NOT NULL,
    name                  TEXT,
    transcript_path       TEXT,
    status                TEXT NOT NULL,
    prompt_count          INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    last_activity_at      TEXT NOT NULL,
    source                TEXT NOT NULL DEFAULT 'cc',
    summary               TEXT,
    archived              INTEGER NOT NULL DEFAULT 0,
    open                  INTEGER NOT NULL DEFAULT 1,
    total_cost_usd        REAL,
    total_duration_ms     INTEGER,
    total_turns           INTEGER,
    pending_question_id   TEXT,
    pending_questions     TEXT,
    pending_prompt_text   TEXT,
    forked_from           TEXT,
    role                  TEXT,
    context_tokens        INTEGER,
    context_window_max    INTEGER,
    debug_mode            TEXT,
    machine_snapshot      TEXT,
    agent_backend         TEXT NOT NULL DEFAULT 'claude',
    backend_ref           TEXT,
    mcp_overrides         TEXT,
    mcp_runtime           TEXT,
    agent_capability_overrides TEXT,
    agent_capabilities_runtime TEXT,
    unread                INTEGER NOT NULL DEFAULT 0,
    spawned_session_ids   TEXT,
    pending_queue         TEXT,
    last_seen_alignment_version INTEGER,
    pending_agent_notices TEXT,
    creation_request_id   TEXT,
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_project_conversations_project
    ON project_conversations(project_path);
  CREATE INDEX IF NOT EXISTS idx_project_conversations_last_activity
    ON project_conversations(last_activity_at);

  CREATE TABLE IF NOT EXISTS conversation_machine_snapshots (
    owner           TEXT NOT NULL CHECK (owner IN ('session', 'project')),
    conversation_id TEXT NOT NULL,
    snapshot_json   TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (owner, conversation_id)
  );

  -- DB-enforced sidecar cleanup. The sidecar's owner discriminator ties one
  -- table to two possible parents (conversations / project_conversations), which
  -- a single foreign key cannot express — so a parent row dying by FK CASCADE
  -- (deleting a session removes its conversations; deleting a project removes
  -- both its sessions' conversations and its project conversations) would leave
  -- the sidecar orphaned. These AFTER DELETE triggers fire for BOTH direct
  -- deletes and FK cascade deletes, within the same transaction as the parent
  -- delete, so a sidecar row can never outlive its owning conversation.
  CREATE TRIGGER IF NOT EXISTS trg_conversation_machine_snapshots_session_cleanup
    AFTER DELETE ON conversations
  BEGIN
    DELETE FROM conversation_machine_snapshots
      WHERE owner = 'session' AND conversation_id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_conversation_machine_snapshots_project_cleanup
    AFTER DELETE ON project_conversations
  BEGIN
    DELETE FROM conversation_machine_snapshots
      WHERE owner = 'project' AND conversation_id = OLD.id;
  END;

  CREATE TABLE IF NOT EXISTS reference_documents (
    id            TEXT PRIMARY KEY,
    project_path  TEXT NOT NULL,
    session_name  TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    description   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE,
    UNIQUE (project_path, session_name, file_path)
  );

  CREATE TABLE IF NOT EXISTS session_markdown_documents (
    project_path   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    doc_path       TEXT NOT NULL,
    origin         TEXT NOT NULL,
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name, doc_path),
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_session_markdown_documents_recent
    ON session_markdown_documents (
      project_path,
      session_name,
      last_seen_at DESC,
      doc_path ASC
    );

  CREATE TABLE IF NOT EXISTS document_comments (
    id            TEXT PRIMARY KEY,
    project_path  TEXT NOT NULL,
    session_name  TEXT NOT NULL,
    doc_path      TEXT NOT NULL,
    section_id    TEXT NOT NULL,
    heading_label TEXT NOT NULL,
    line          INTEGER NOT NULL,
    char_start    INTEGER NOT NULL,
    char_end      INTEGER NOT NULL,
    quote         TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    suffix        TEXT NOT NULL,
    doc_revision  TEXT NOT NULL,
    note          TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    sent_at       TEXT,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_document_comments_doc
    ON document_comments (project_path, session_name, doc_path);

  ${NOTIFICATIONS_TABLE_DDL}

  CREATE TABLE IF NOT EXISTS job_records (
    job_id         TEXT PRIMARY KEY,
    job_type       TEXT NOT NULL,
    status         TEXT NOT NULL,
    project_name   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    branch_name    TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    completed_at   TEXT,
    merge_hash     TEXT,
    commit_hash    TEXT,
    conflict_count INTEGER,
    conflict_files TEXT,
    error_message  TEXT,
    owner_pid      INTEGER,
    execution_id   TEXT,
    final_publish  INTEGER NOT NULL DEFAULT 0,
    candidate_validation TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_job_records_status ON job_records(status);

  CREATE TABLE IF NOT EXISTS agent_run_records (
    run_id              TEXT PRIMARY KEY,
    backend             TEXT NOT NULL,
    project_name        TEXT NOT NULL,
    session_name        TEXT NOT NULL,
    status              TEXT NOT NULL,
    started_at          TEXT NOT NULL,
    completed_at        TEXT,
    summary             TEXT,
    reference_documents TEXT,
    error_message       TEXT,
    owner_pid           INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_agent_run_records_session
    ON agent_run_records(project_name, session_name);

  CREATE TABLE IF NOT EXISTS graph_workflow_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path  TEXT NOT NULL,
    session_name  TEXT NOT NULL,
    execution_id  TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    context_id    TEXT,
    pre_reset     INTEGER NOT NULL DEFAULT 0,
    event_json    TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_events_execution
    ON graph_workflow_events(execution_id, id);
  CREATE INDEX IF NOT EXISTS idx_graph_workflow_events_context
    ON graph_workflow_events(execution_id, context_id, event_type);

  CREATE TABLE IF NOT EXISTS graph_workflow_archived_executions (
    project_path    TEXT NOT NULL,
    session_name    TEXT NOT NULL,
    execution_id    TEXT NOT NULL,
    archived_at     TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    execution_json  TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name, execution_id),
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_archived_executions_session
    ON graph_workflow_archived_executions(project_path, session_name, archived_at);

  CREATE TABLE IF NOT EXISTS graph_workflow_executions (
    project_path              TEXT NOT NULL,
    session_name              TEXT NOT NULL,
    execution_id              TEXT NOT NULL,
    seed_definition_id        TEXT NOT NULL,
    seed_definition_revision  INTEGER NOT NULL,
    started_at                TEXT NOT NULL,
    status                    TEXT NOT NULL,
    completed_at              TEXT,
    definition_json           TEXT NOT NULL,
    runtime_json              TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name),
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_executions_status
    ON graph_workflow_executions(project_path, session_name, status);

  CREATE TABLE IF NOT EXISTS session_alignment_versions (
    id                     TEXT PRIMARY KEY,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    version                INTEGER,
    content                TEXT NOT NULL DEFAULT '',
    content_hash           TEXT NOT NULL DEFAULT '',
    status                 TEXT NOT NULL,
    source                 TEXT NOT NULL,
    author_conversation_id TEXT,
    auto_activate          INTEGER NOT NULL DEFAULT 0,
    linked_decision_ids    TEXT NOT NULL DEFAULT '[]',
    approver               TEXT,
    created_at             TEXT NOT NULL,
    activated_at           TEXT,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE,
    UNIQUE (project_path, session_name, version)
  );

  CREATE INDEX IF NOT EXISTS idx_session_alignment_versions_status
    ON session_alignment_versions(project_path, session_name, status);

  CREATE TABLE IF NOT EXISTS session_alignment_decisions (
    id                     TEXT PRIMARY KEY,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    statement              TEXT NOT NULL,
    rationale              TEXT,
    origin_conversation_id TEXT NOT NULL,
    origin_message_id      TEXT,
    produced_version       INTEGER,
    approved_at            TEXT NOT NULL,
    approver               TEXT,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_session_alignment_decisions_approved_at
    ON session_alignment_decisions(project_path, session_name, approved_at);

  CREATE TABLE IF NOT EXISTS session_alignment_decision_proposals (
    id                     TEXT PRIMARY KEY,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    conversation_id        TEXT NOT NULL,
    batch_id               TEXT NOT NULL,
    statement              TEXT NOT NULL,
    rationale              TEXT,
    context                TEXT,
    origin_message_id      TEXT,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_session_alignment_decision_proposals_batch
    ON session_alignment_decision_proposals(project_path, session_name, batch_id);

  CREATE TABLE IF NOT EXISTS merge_intents (
    project_path TEXT NOT NULL,
    commit_sha   TEXT NOT NULL,
    intent       TEXT NOT NULL,
    source       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (project_path, commit_sha)
  );

  CREATE TABLE IF NOT EXISTS context_artifacts (
    id                         TEXT PRIMARY KEY,
    kind                       TEXT NOT NULL,             -- message_compaction | conversation_compaction
    scope                      TEXT NOT NULL,             -- session | project (mirrors conversation scope)
    project_path               TEXT NOT NULL,
    session_name               TEXT,                      -- NULL for project-scope conversations
    conversation_id            TEXT NOT NULL,
    message_id                 TEXT,
    message_index              INTEGER,
    covered_start_seq          INTEGER NOT NULL,
    covered_end_seq            INTEGER NOT NULL,
    source_hash                TEXT NOT NULL,
    status                     TEXT NOT NULL,             -- pending | complete | failed
    error                      TEXT,
    model_provider             TEXT NOT NULL,             -- claude | codex
    model                      TEXT NOT NULL,
    effort                     TEXT,
    schema_version             INTEGER NOT NULL,
    prompt_version             TEXT NOT NULL,
    normalizer_version         TEXT NOT NULL,
    created_by                 TEXT NOT NULL,             -- user | agent
    created_by_conversation_id TEXT,                      -- set when created_by = agent
    payload_json               TEXT,                      -- CompactionEnvelope; NULL while pending/failed
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_context_artifacts_conversation
    ON context_artifacts (conversation_id, kind);
  CREATE INDEX IF NOT EXISTS idx_context_artifacts_scope
    ON context_artifacts (project_path, session_name);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_context_artifacts_conversation_kind
    ON context_artifacts (conversation_id) WHERE kind = 'conversation_compaction';
  CREATE UNIQUE INDEX IF NOT EXISTS uq_context_artifacts_message
    ON context_artifacts (conversation_id, message_index) WHERE kind = 'message_compaction';

  -- Deliberately no projects FK: a deleted-then-rediscovered project path must
  -- never reuse ticket numbers, so counters outlive their project row.
  CREATE TABLE IF NOT EXISTS ticket_counters (
    project_path TEXT PRIMARY KEY,
    last_number  INTEGER NOT NULL CHECK (last_number >= 0)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id            TEXT PRIMARY KEY,
    project_path  TEXT NOT NULL,
    ticket_number INTEGER NOT NULL CHECK (ticket_number > 0),
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    work_type     TEXT NOT NULL CHECK (work_type IN (
      'feature', 'bug', 'research', 'tech_debt', 'performance'
    )),
    status        TEXT NOT NULL CHECK (status IN (
      'not_started', 'in_progress', 'done', 'blocked', 'closed'
    )),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (project_path, ticket_number),
    UNIQUE (id, project_path),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_project_updated
    ON tickets (project_path, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_status_updated
    ON tickets (status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_project_status_type_updated
    ON tickets (project_path, status, work_type, updated_at DESC);

  CREATE TABLE IF NOT EXISTS ticket_attachments (
    id           TEXT PRIMARY KEY,
    ticket_id    TEXT NOT NULL,
    description  TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_created
    ON ticket_attachments (ticket_id, created_at);

  CREATE TABLE IF NOT EXISTS ticket_sessions (
    id                 TEXT PRIMARY KEY,
    ticket_id          TEXT NOT NULL,
    project_path       TEXT NOT NULL,
    session_name       TEXT NOT NULL,
    -- Legacy links cannot prove which same-name session they referenced; NULL
    -- keeps them historical instead of attaching them to a replacement.
    session_created_at TEXT,
    start_mode         TEXT NOT NULL CHECK (start_mode IN ('agent', 'prepared')),
    linked_at          TEXT NOT NULL,
    ended_at           TEXT,
    end_reason         TEXT CHECK (end_reason IN ('finished', 'deleted', 'replaced')),
    FOREIGN KEY (ticket_id, project_path)
      REFERENCES tickets(id, project_path) ON DELETE CASCADE
  );

  -- Single-active-link invariants: at most one live link per ticket and per
  -- (project, session name); history rows (ended_at set) are unbounded.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_sessions_active_ticket
    ON ticket_sessions (ticket_id) WHERE ended_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_sessions_active_session
    ON ticket_sessions (project_path, session_name) WHERE ended_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_ticket_sessions_ticket_linked
    ON ticket_sessions (ticket_id, linked_at);
  CREATE INDEX IF NOT EXISTS idx_ticket_sessions_project_session
    ON ticket_sessions (project_path, session_name);

  ${SPEC_SCHEMA_DDL}
`;

function applyConnectionPragmas(db: Db): void {
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
}

function applyJournalMode(db: Db): void {
  db.pragma("journal_mode = WAL");
}

let stateDbBeforeLockedInitializationHook: (() => void) | null = null;

export function _setStateDbBeforeLockedInitializationHookForTesting(
  hook: (() => void) | null,
): void {
  stateDbBeforeLockedInitializationHook = hook;
}

/**
 * Idempotent column additions for tables that already existed before a column
 * was added to the DDL. `CREATE TABLE IF NOT EXISTS` is a no-op when the table
 * is already present, so new columns must be added explicitly. Each entry
 * encodes the table, column name, and full column type spec; `PRAGMA
 * table_info` decides whether the column already exists. Safe to run on a
 * freshly-created DB — it just finds the column and skips.
 */
const ADDITIVE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  type: string;
}> = [
  { table: "conversations", column: "pending_prompt_text", type: "TEXT" },
  { table: "projects", column: "agent_capability_overrides", type: "TEXT" },
  { table: "sessions", column: "agent_capability_overrides", type: "TEXT" },
  {
    table: "conversations",
    column: "agent_capability_overrides",
    type: "TEXT",
  },
  {
    table: "conversations",
    column: "agent_capabilities_runtime",
    type: "TEXT",
  },
  {
    table: "conversations",
    column: "unread",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "project_conversations",
    column: "open",
    type: "INTEGER NOT NULL DEFAULT 1",
  },
  { table: "sessions", column: "spawned_from", type: "TEXT" },
  {
    table: "project_conversations",
    column: "spawned_session_ids",
    type: "TEXT",
  },
  { table: "conversations", column: "pending_queue", type: "TEXT" },
  {
    table: "conversations",
    column: "last_seen_alignment_version",
    type: "INTEGER",
  },
  {
    table: "ticket_sessions",
    column: "session_created_at",
    type: "TEXT",
  },
  { table: "conversations", column: "pending_agent_notices", type: "TEXT" },
  { table: "job_records", column: "owner_pid", type: "INTEGER" },
  { table: "job_records", column: "execution_id", type: "TEXT" },
  {
    table: "job_records",
    column: "final_publish",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "job_records", column: "candidate_validation", type: "TEXT" },
  { table: "project_conversations", column: "pending_queue", type: "TEXT" },
  {
    table: "project_conversations",
    column: "last_seen_alignment_version",
    type: "INTEGER",
  },
  {
    table: "project_conversations",
    column: "pending_agent_notices",
    type: "TEXT",
  },
  {
    table: "project_conversations",
    column: "creation_request_id",
    type: "TEXT",
  },
  {
    table: "spec_revisions",
    column: "authoring_stage",
    type: "TEXT NOT NULL DEFAULT 'plan' CHECK (authoring_stage IN ('requirements', 'design', 'plan'))",
  },
  {
    table: "spec_executions",
    column: "execution_start_dial",
    type: "TEXT CHECK (execution_start_dial IN ('gate', 'notify', 'off'))",
  },
  {
    table: "spec_executions",
    column: "workflow_definition_revision",
    type: "INTEGER CHECK (workflow_definition_revision > 0)",
  },
];

function columnExists(db: Db, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

function isDuplicateColumnError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.toLowerCase().includes("duplicate column name")
  );
}

/**
 * Add `column` to `table`, tolerating a concurrent winner. The existence check
 * and the `ALTER` are not atomic across connections: when several processes open
 * the same DB file at once (e.g. `next build`'s parallel page-data workers) and
 * a newly-introduced additive column is still missing, they each decide to add
 * it and then race the `ALTER`. SQLite reports the losers' attempts as
 * "duplicate column name". That race outcome is benign, so swallow it — but only
 * once the column is confirmed present, so a genuine failure (or a duplicate
 * error that somehow left the column absent) still propagates.
 */
export function addColumnToleratingRace(
  db: Db,
  table: string,
  column: string,
  type: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (isDuplicateColumnError(err) && columnExists(db, table, column)) {
      logger.debug("state-store.additive_column_race", { table, column });
      return;
    }
    throw err;
  }
}

function ensureAdditiveColumns(db: Db): void {
  for (const { table, column, type } of ADDITIVE_COLUMNS) {
    if (columnExists(db, table, column)) continue;
    addColumnToleratingRace(db, table, column, type);
  }
}

interface TableColumnInfo {
  name: string;
  notnull: 0 | 1;
}

function getTableColumns(db: Db, table: string): TableColumnInfo[] {
  return db.pragma(`table_info(${table})`) as TableColumnInfo[];
}

function notificationColumnExpression(
  existingColumnNames: Set<string>,
  column: string,
  fallback: string,
): string {
  if (existingColumnNames.has(column)) return column;
  return fallback;
}

function migrateNotificationsTable(db: Db): void {
  const columns = getTableColumns(db, "notifications");
  if (columns.length === 0) return;

  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = [
    "source",
    "conversation_id",
    "conversation_name",
    "conversation_status",
    "dedupe_key",
    "spec_id",
    "spec_slug",
    "spec_name",
    "spec_gate",
    "spec_gate_request_id",
    "spec_deep_link_id",
    "spec_approval_id",
  ];
  const missingRequiredColumns = requiredColumns.some(
    (column) => !columnNames.has(column),
  );
  const jobContextIsStrict = columns.some(
    (column) =>
      ["session_name", "branch_name", "job_id", "job_type"].includes(
        column.name,
      ) && column.notnull === 1,
  );

  if (!missingRequiredColumns && !jobContextIsStrict) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_notifications_read;
    DROP INDEX IF EXISTS idx_notifications_created_at;
    DROP INDEX IF EXISTS idx_notifications_project_session;
    DROP INDEX IF EXISTS idx_notifications_project_conversation;
    DROP INDEX IF EXISTS idx_notifications_dedupe;
    DROP INDEX IF EXISTS idx_notifications_spec_request;
    ALTER TABLE notifications RENAME TO notifications_legacy_migration;
  `);
  db.exec(NOTIFICATIONS_TABLE_DDL);

  const legacyColumns = getTableColumns(db, "notifications_legacy_migration");
  const legacyColumnNames = new Set(legacyColumns.map((column) => column.name));

  db.exec(`
    INSERT INTO notifications (
      id,
      source,
      type,
      title,
      message,
      read,
      project_name,
      created_at,
      session_name,
      branch_name,
      job_id,
      job_type,
      merge_hash,
      commit_hash,
      conflict_count,
      conflict_files,
      target_branch,
      conversation_id,
      conversation_name,
      conversation_status,
      dedupe_key,
      error_message,
      spec_id,
      spec_slug,
      spec_name,
      spec_gate,
      spec_gate_request_id,
      spec_deep_link_id,
      spec_approval_id
    )
    SELECT
      id,
      ${notificationColumnExpression(legacyColumnNames, "source", "'job'")},
      type,
      title,
      message,
      read,
      project_name,
      ${notificationColumnExpression(
        legacyColumnNames,
        "created_at",
        "datetime('now')",
      )},
      session_name,
      branch_name,
      job_id,
      job_type,
      ${notificationColumnExpression(legacyColumnNames, "merge_hash", "NULL")},
      ${notificationColumnExpression(legacyColumnNames, "commit_hash", "NULL")},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conflict_count",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conflict_files",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "target_branch",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conversation_id",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conversation_name",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conversation_status",
        "NULL",
      )},
      ${notificationColumnExpression(legacyColumnNames, "dedupe_key", "NULL")},
      ${notificationColumnExpression(
        legacyColumnNames,
        "error_message",
        "NULL",
      )},
      ${notificationColumnExpression(legacyColumnNames, "spec_id", "NULL")},
      ${notificationColumnExpression(legacyColumnNames, "spec_slug", "NULL")},
      ${notificationColumnExpression(legacyColumnNames, "spec_name", "NULL")},
      ${notificationColumnExpression(legacyColumnNames, "spec_gate", "NULL")},
      ${notificationColumnExpression(
        legacyColumnNames,
        "spec_gate_request_id",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "spec_deep_link_id",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "spec_approval_id",
        "NULL",
      )}
    FROM notifications_legacy_migration;

    DROP TABLE notifications_legacy_migration;
  `);
  db.exec(NOTIFICATIONS_INDEX_DDL);
}

/**
 * One-time global purge of pre-charter graph-workflow records. The Workflow
 * Charter feature makes a charter required on every workflow definition and
 * execution, so legacy charter-less records cannot satisfy the schema. This
 * runs once at app start — before any sessions-repo reader that would
 * otherwise quarantine charter-less rows — and:
 *   - captures `<configDir>/workflows/` under a permanent quarantine sentinel
 *     and syncs both sides of the rename while holding the SQLite write lock,
 *   - nulls the embedded `graph_workflow_execution` and resets the history to
 *     `'[]'` on every persisted session (executions live inside SessionState,
 *     so a table drop is insufficient),
 *   - commits the pending cleanup witness, reset, and completion marker in the
 *     same transaction, then deletes only the captured files after commit.
 *
 * `configDir` is derived from the open DB path by the caller (its directory),
 * NOT from `getConfigDirPath()`, so tests over a temp DB never touch the real
 * config dir. In production `path.dirname(dbPath) === getConfigDirPath()`. A
 * `null` configDir (in-memory DB) skips the capture step only; the SQLite-side
 * reset and claim/completion state still run.
 *
 * Shared-database blast radius: `command-center.db` is shared across all
 * branches/worktrees, so this delete removes definitions and executions for
 * every session and branch. The operator confirmed this global reset is
 * intended (see design.md "Migration Strategy").
 */
export function runLegacyWorkflowPurgeMigration(
  db: Db,
  configDir: string | null,
  dbPath: string,
): void {
  const migrate = db.transaction((): LegacyWorkflowPurgeState => {
    enforceCurrentSchemaCompatibility(db, dbPath, KNOWN_SCHEMA_VERSION);
    const completionRecorded = hasDataMigrationMarker(
      db,
      LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
    );
    const pendingRecorded = hasDataMigrationMarker(
      db,
      LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID,
    );
    if (completionRecorded) {
      return pendingRecorded
        ? {
            kind: "cleanup",
            capture: legacyWorkflowCapturePaths(configDir),
            sessionsCleared: 0,
            completionRecorded: false,
          }
        : { kind: "done" };
    }

    // A pending-only row can exist only from the earlier two-phase
    // implementation. Its live workflow directory may contain post-claim data,
    // so establish an empty sentinel instead of recapturing that directory.
    const capture = captureLegacyWorkflowDirectory(configDir, !pendingRecorded);

    let sessionsCleared = 0;
    if (!pendingRecorded) {
      db.prepare("INSERT INTO applied_data_migrations (id) VALUES (?)").run(
        LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID,
      );
      sessionsCleared = db
        .prepare(
          `UPDATE sessions
             SET graph_workflow_execution = NULL,
                 graph_workflow_execution_history = '[]'
           WHERE graph_workflow_execution IS NOT NULL
              OR graph_workflow_execution_history <> '[]'`,
        )
        .run().changes;
    }

    const completion = db
      .prepare("INSERT INTO applied_data_migrations (id) VALUES (?)")
      .run(LEGACY_WORKFLOW_PURGE_MIGRATION_ID);
    return {
      kind: "cleanup",
      capture,
      sessionsCleared,
      completionRecorded: completion.changes === 1,
    };
  });

  const state = migrate.immediate();
  if (state.kind === "done") return;

  if (state.completionRecorded) {
    logger.info("state-store.legacy_workflow_purge_claimed", {
      migrationId: LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
      sessionsCleared: state.sessionsCleared,
    });
  }
  cleanupCapturedLegacyWorkflows(state);
}

function hasDataMigrationMarker(db: Db, id: string): boolean {
  return (
    db.prepare("SELECT 1 FROM applied_data_migrations WHERE id = ?").get(id) !==
    undefined
  );
}

interface LegacyWorkflowCapture {
  workflowsDir: string | null;
  quarantineRoot: string | null;
  capturedRoot: string | null;
  workflowsDirCaptured: boolean;
}

type LegacyWorkflowPurgeState =
  | { kind: "done" }
  | {
      kind: "cleanup";
      capture: LegacyWorkflowCapture;
      sessionsCleared: number;
      completionRecorded: boolean;
    };

function legacyWorkflowCapturePaths(
  configDir: string | null,
): LegacyWorkflowCapture {
  if (configDir === null) {
    return {
      workflowsDir: null,
      quarantineRoot: null,
      capturedRoot: null,
      workflowsDirCaptured: false,
    };
  }
  const quarantineRoot = path.join(
    configDir,
    LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
  );
  return {
    workflowsDir: path.join(configDir, "workflows"),
    quarantineRoot,
    capturedRoot: path.join(
      quarantineRoot,
      LEGACY_WORKFLOW_PURGE_CAPTURE_DIR_NAME,
    ),
    workflowsDirCaptured: false,
  };
}

function captureLegacyWorkflowDirectory(
  configDir: string | null,
  captureLiveDirectory: boolean,
): LegacyWorkflowCapture {
  const capture = legacyWorkflowCapturePaths(configDir);
  if (
    configDir === null ||
    capture.quarantineRoot === null ||
    capture.capturedRoot === null ||
    capture.workflowsDir === null
  ) {
    return capture;
  }

  legacyWorkflowPurgeFsOps.makeDir(capture.quarantineRoot);
  if (!legacyWorkflowPurgeFsOps.exists(capture.capturedRoot)) {
    if (captureLiveDirectory) {
      try {
        legacyWorkflowPurgeFsOps.rename(
          capture.workflowsDir,
          capture.capturedRoot,
        );
        capture.workflowsDirCaptured = true;
      } catch (err) {
        if (!isNodeErrorCode(err, "ENOENT")) throw err;
      }
    }
    if (!legacyWorkflowPurgeFsOps.exists(capture.capturedRoot)) {
      legacyWorkflowPurgeFsOps.makeDir(capture.capturedRoot);
    }
  }

  // Destination first, then source: completion is recorded only after both
  // directory entries are durable across power loss.
  legacyWorkflowPurgeFsOps.syncDirectory(capture.quarantineRoot);
  legacyWorkflowPurgeFsOps.syncDirectory(configDir);
  return capture;
}

function cleanupCapturedLegacyWorkflows(
  state: Extract<LegacyWorkflowPurgeState, { kind: "cleanup" }>,
): void {
  const { capture } = state;
  let capturedEntriesRemoved = 0;
  if (
    capture.capturedRoot !== null &&
    legacyWorkflowPurgeFsOps.exists(capture.capturedRoot)
  ) {
    for (const entry of legacyWorkflowPurgeFsOps.list(capture.capturedRoot)) {
      legacyWorkflowPurgeFsOps.remove(path.join(capture.capturedRoot, entry));
      capturedEntriesRemoved += 1;
    }
    legacyWorkflowPurgeFsOps.syncDirectory(capture.capturedRoot);
  }

  logger.info("state-store.legacy_workflow_purge", {
    migrationId: LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
    sessionsCleared: state.sessionsCleared,
    completionRecorded: state.completionRecorded,
    workflowsDirCaptured: capture.workflowsDirCaptured,
    capturedEntriesRemoved,
    workflowsDir: capture.workflowsDir,
    capturedRoot: capture.capturedRoot,
  });
}

function isUnsupportedDirectorySyncError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  if (["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code)) {
    return true;
  }
  return process.platform === "win32" && ["EPERM", "EBADF"].includes(code);
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

function initializeSchema(db: Db, dbPath: string): void {
  enforceCurrentSchemaCompatibility(db, dbPath, KNOWN_SCHEMA_VERSION);
  db.exec(SCHEMA_DDL);
  migrateNotificationsTable(db);
  db.exec(NOTIFICATIONS_INDEX_DDL);
  ensureAdditiveColumns(db);
}

function openStateDb(dbPath: string): Db {
  enforceSchemaCompatibilityBarrier(dbPath, KNOWN_SCHEMA_VERSION);
  const db = new Database(dbPath);
  try {
    // The external barrier above is the mutation-free pre-open gate. This
    // ledger check is defense in depth for legacy databases without a barrier.
    enforceCurrentSchemaCompatibility(db, dbPath, KNOWN_SCHEMA_VERSION);
    applyConnectionPragmas(db);
    stateDbBeforeLockedInitializationHook?.();
    // Hold the write lock from the second version check through schema setup,
    // so a concurrently starting newer build cannot advance the compatibility
    // version between the gate and this build's DDL/data migrations.
    const initialize = db.transaction(() => initializeSchema(db, dbPath));
    initialize.immediate();
    // `journal_mode` changes persistent database state and SQLite does not
    // permit changing it inside a transaction. Apply it only after the locked
    // compatibility recheck and schema initialization succeed.
    applyJournalMode(db);
    // Filesystem capture and its parent-directory sync happen under a second
    // write lock before the reset and completion markers commit together.
    const configDir = dbPath === ":memory:" ? null : path.dirname(dbPath);
    runLegacyWorkflowPurgeMigration(db, configDir, dbPath);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Get-or-open the singleton `command-center.db` connection. HMR-safe.
 *
 * The first call resolves the config dir, ensures it exists, opens the
 * `better-sqlite3` connection, applies pragmas, and runs schema initialization
 * (including the forward-only schema_migrations conflict check).
 */
export function getDb(): Db {
  return getGlobalSingleton(GLOBAL_KEY, () => {
    const configDir = getConfigDirPath();
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const dbPath = path.join(configDir, DB_FILE_NAME);
    return openStateDb(dbPath);
  });
}

/** Reset the singleton for testing — closes any open connection. */
export function _resetForTesting(): void {
  const db = getGlobalValue<Db>(GLOBAL_KEY);
  if (db) {
    db.close();
    deleteGlobalValue(GLOBAL_KEY);
  }
}

/**
 * Create a fresh `Database` for tests via DI. Does NOT touch the singleton.
 *
 * `inMemory: true` opens `:memory:`; otherwise a fresh temp directory is used
 * so each call yields an isolated file-backed DB.
 */
export function _createTestDb(opts: { inMemory?: boolean } = {}): Db {
  if (opts.inMemory === true) {
    return openStateDb(":memory:");
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-"));
  return openStateDb(path.join(dir, DB_FILE_NAME));
}

/**
 * Test helper: open a state DB at an explicit path. Used by tests that need to
 * reopen the same file (e.g. forward-only conflict regression).
 */
export function _createTestDbAtPath(dbPath: string): Db {
  return openStateDb(dbPath);
}

/**
 * Bookkeeping table excluded from {@link truncateAllTables} so the forward-only
 * version check still passes after a reset.
 */
const SCHEMA_VERSION_TABLE = "schema_migrations";

/**
 * Test helper: empty every application data table, deriving the table set from
 * the live schema (`sqlite_master`) so a newly added table is cleared with no
 * code change. Excludes SQLite internals (`sqlite_%`) and the schema-version
 * bookkeeping table (`schema_migrations`) so the forward-only version check
 * still passes after reset.
 *
 * Foreign-key enforcement is disabled for the duration of the deletes so order
 * is irrelevant, then restored to its prior state.
 */
export function truncateAllTables(db: Db): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const tables: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || !("name" in row)) {
      continue;
    }
    const name = (row as { name: unknown }).name;
    if (typeof name !== "string") {
      continue;
    }
    if (name.startsWith("sqlite_") || name === SCHEMA_VERSION_TABLE) {
      continue;
    }
    tables.push(name);
  }

  const fkRows = db.pragma("foreign_keys") as { foreign_keys: number }[];
  const fkWasOn = fkRows[0]?.foreign_keys === 1;

  db.pragma("foreign_keys = OFF");
  try {
    const truncate = db.transaction(() => {
      for (const table of tables) {
        db.exec(`DELETE FROM "${table}"`);
      }
    });
    truncate();
  } finally {
    if (fkWasOn) {
      db.pragma("foreign_keys = ON");
    }
  }
}

/**
 * Test helper: install a `Database` instance into the singleton slot so that
 * subsequent calls to `getDb()` return it. Closes any previously-installed
 * test connection first. Used by test suites whose subject still consumes the
 * shared singleton (e.g. `notifications/repo.test.ts`).
 */
export function _installTestDb(db: Db): void {
  const existing = getGlobalValue<Db>(GLOBAL_KEY);
  if (existing) {
    existing.close();
  }
  setGlobalValue(GLOBAL_KEY, db);
}
