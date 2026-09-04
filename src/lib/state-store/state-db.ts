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
  publishSchemaCompatibilityBarrierSync,
} from "./schema-compatibility";
import {
  applyNativeSddAttentionCitationsSchema,
  NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
} from "./migrations/0034-native-sdd-attention-citations";

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
 *
 * Version 3 is the workflow agent-assignment cutover: migration
 * `0011-workflow-agent-assignments` rewrites every persisted implementer and
 * validator onto library assignments and empties the active execution table.
 * The bump is what makes the "no inbound compatibility parser" rule hold: an
 * older build would happily write the pre-cutover singleton shapes back into a
 * migrated database, and nothing would ever convert them again.
 *
 * Version 4 is the validation_runs status widening: migration
 * `0012-validation-cost-exceeds-limit-status` rebuilds the table's CHECK to
 * admit `cost_exceeds_limit`. Rows persisted with the new status are
 * unreadable to an older build's narrower status enum, so the gate refuses
 * such a build once the migration has stamped the upgraded DB. It also fences
 * the scriptValidator cutover that ships alongside it: `0013` rewrites stored
 * `scriptValidator.enabled` onto `commands`, and a build predating that change
 * would write the retired flag back into definitions the strict schema rejects.
 * Version 3 and version 4 were authored concurrently on two branches and both
 * originally claimed 3; they are sequenced here because one number cannot fence
 * two independent cutovers, and 3 is already stamped in live databases.
 *
 * Version 5 is the graph-workflow lane-placement cutover: migration
 * `0016-graph-workflow-context-placement` backfills authored placement onto
 * every stored execution context. A build predating placement does not know
 * the field and would write it back out stripped, dissolving an authored lane
 * GROUP into one lane per context on the next read — so the gate refuses such a
 * build once the migration has stamped the upgraded DB.
 *
 * Version 6 is the spec_executions state widening: migration
 * `0017-spec-execution-abandon-coordinator` rebuilds the table's CHECK to admit
 * `abandoning`, the abandon coordinator's in-flight cleanup state (design §10).
 * A row parked in that state is unreadable to an older build — the spec
 * execution repository throws a PersistenceError on an unknown `state` rather
 * than quarantining the row — so the gate refuses such a build once the
 * migration has stamped the upgraded DB. Like 3 and 4 before them, 5 and 6 were
 * authored concurrently on two branches and both originally claimed 5; they are
 * sequenced here because one number cannot fence two independent cutovers, and
 * 5 is already stamped in live databases by the placement cutover.
 *
 * Version 7 is the engine-seeded shared-document kind: migration
 * `0023-graph-workflow-seeded-documents` stamps the gate for the widened
 * `sharedDocuments[].kind` vocabulary, which admits `seeded` alongside `shared`
 * and `charter`. The value is persisted in `graph_workflow_executions`
 * `runtime_json`, and the repository throws on a kind its enum does not admit —
 * for the whole `listActive()` result rather than the one row — so an older
 * build sharing the database would lose every execution's workflow state, not
 * just the seeded run's. Nothing is rewritten: the migration exists only to
 * publish the barrier and stamp the version.
 *
 * Version 8 is the session-scoped workflow-result notification source. A
 * workflow notification is returned by the same whole-result-set read as job,
 * conversation, and spec notifications, so an older build would reject the
 * widened source vocabulary and lose the entire notification listing. Migration
 * `0027-workflow-result-notifications` publishes the barrier, rebuilds the
 * notification CHECK and columns, and stamps the version before writers can
 * persist the new source.
 *
 * Version 9 is the native-SDD version-2 cutover: migration
 * `0030-native-sdd-v2-cutover` removes every legacy delivery-plan artifact and
 * legacy-linked graph execution before direct-authored attempt activation.
 * Older builds retain the retired plan/compiler runtime and could recreate
 * artifacts for which the version-2 build deliberately has no reader.
 *
 * Version 10 is the candidate-unstable halt vocabulary: migration
 * `0031-graph-workflow-candidate-unstable-halt` stamps the gate for the
 * `candidate_unstable` halt reason (consecutive candidate-mismatch budget, #69
 * change 8) and its `planRepairRounds[].haltType` counterpart. The values are
 * persisted in `graph_workflow_executions` `runtime_json`, and the repository
 * throws on a halt type its enum does not admit — for the whole `listActive()`
 * result rather than the one row — so an older build sharing the database
 * would lose every execution's workflow state, not just the halted run's.
 * Nothing is rewritten: the migration exists only to publish the barrier and
 * stamp the version.
 *
 * Version 11 is the Native SDD attention/citation cutover: migration
 * `0034-native-sdd-attention-citations` rebuilds question and assumption
 * lifecycle storage and makes assumption citations revision-owned. Older
 * readers cannot interpret either contract and are refused before opening the
 * upgraded database.
 *
 * Version 12 is the generalized model-selection cutover: migration
 * `0035-generalized-model-selection` replaces every live provider-specific
 * model tuple with one atomic selection and rebuilds context-artifact
 * provenance storage. Older writers could recreate tuple-shaped config,
 * workflow, snapshot, transcript, or provenance state that this build refuses.
 *
 * Version 13 is the ticket-relationship cutover: migration
 * `0038-ticket-relationships-and-status-updates` moves legacy
 * `related_ticket` attachment rows into first-class relationship storage.
 * Canonical attachment readers no longer admit that discriminator, so an older
 * build must not write legacy rows back after the migration stamps the database.
 *
 * Version 14 is the Native SDD managed-definition cutover: migration
 * `0039-native-sdd-managed-workflow-definitions` removes embedded workflow
 * graphs from delivery-plan blobs and pins candidates to immutable saved
 * workflow-definition revisions. Older writers cannot preserve that ownership
 * or candidate identity contract.
 */
export const KNOWN_SCHEMA_VERSION = 14;

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
    workflow_execution_id TEXT,
    workflow_origin_conversation_id TEXT,
    workflow_deep_link    TEXT,
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
      OR
      (source = 'workflow'
        AND session_name IS NOT NULL
        AND workflow_execution_id IS NOT NULL
        AND workflow_origin_conversation_id IS NOT NULL
        AND workflow_deep_link IS NOT NULL
        AND conversation_id IS NULL
        AND branch_name IS NULL
        AND job_id IS NULL
        AND job_type IS NULL
        AND spec_id IS NULL)
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

/**
 * Spec delivery executions. Extracted from the spec schema block so migration
 * 0015 can rebuild the table from this exact DDL rather than a hand-synced
 * copy — the `state` CHECK is a vocabulary SQLite cannot widen in place.
 */
export const SPEC_EXECUTIONS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_executions (
    id                     TEXT PRIMARY KEY,
    spec_id                TEXT NOT NULL,
    revision_id            TEXT NOT NULL,
    scope_json             TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN (
      'definition_review', 'running', 'delivered', 'abandoned', 'abandoning'
    )),
    cleanup_phase          TEXT CHECK (cleanup_phase IN (
      'abort_workflow', 'finalize'
    )),
    linked_workflow_execution_id TEXT,
    cleanup_last_error     TEXT,
    cleanup_last_error_at  TEXT,
    execution_start_dial   TEXT CHECK (execution_start_dial IN (
      'gate', 'notify', 'off'
    )),
    workflow_definition_id TEXT,
    workflow_definition_revision INTEGER CHECK (
      workflow_definition_revision > 0
    ),
    workflow_seed_source_json TEXT,
    workflow_execution_binding_json TEXT,
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
`;

/**
 * The version-2 spec↔graph link and frozen binding. The workflow execution id
 * remains durable after the graph row is archived, so this row deliberately
 * references the spec execution only; the unique workflow id is the typed
 * authority used by graph-facing adapters.
 */
export const SPEC_EXECUTION_BINDINGS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_execution_bindings (
    spec_execution_id      TEXT PRIMARY KEY,
    workflow_execution_id  TEXT NOT NULL UNIQUE,
    binding_json           TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (spec_execution_id) REFERENCES spec_executions(id)
      ON DELETE CASCADE
  );

  CREATE TRIGGER IF NOT EXISTS spec_execution_bindings_immutable
  BEFORE UPDATE ON spec_execution_bindings
  BEGIN
    SELECT RAISE(ABORT, 'spec execution bindings are immutable');
  END;
`;

export const SPEC_DELIVERY_VERDICTS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_delivery_verdicts (
    id                      TEXT PRIMARY KEY,
    spec_execution_id       TEXT NOT NULL,
    workflow_execution_id   TEXT NOT NULL,
    candidate_id            TEXT NOT NULL,
    candidate_hash          TEXT NOT NULL,
    criterion_element_id    TEXT NOT NULL,
    satisfying_context_id   TEXT NOT NULL,
    verdict_at              TEXT NOT NULL,
    FOREIGN KEY (spec_execution_id) REFERENCES spec_executions(id)
      ON DELETE CASCADE,
    FOREIGN KEY (criterion_element_id) REFERENCES spec_elements(id),
    UNIQUE (
      workflow_execution_id,
      candidate_id,
      candidate_hash,
      criterion_element_id,
      satisfying_context_id
    )
  );

  CREATE INDEX IF NOT EXISTS idx_spec_delivery_verdicts_execution
    ON spec_delivery_verdicts (workflow_execution_id, verdict_at);
  CREATE INDEX IF NOT EXISTS idx_spec_delivery_verdicts_spec_execution
    ON spec_delivery_verdicts (spec_execution_id, verdict_at);
  CREATE INDEX IF NOT EXISTS idx_spec_delivery_verdicts_criterion
    ON spec_delivery_verdicts (criterion_element_id, verdict_at);
`;

/**
 * Gate-admission storage. Exported so the migration that widens the `basis`
 * vocabulary rebuilds the table from this one definition instead of a
 * hand-synced copy (the 0017 precedent).
 */
export const SPEC_GATE_ADMISSIONS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_gate_admissions (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    gate          TEXT NOT NULL CHECK (gate IN (
      'requirements', 'design', 'plan', 'execution_start', 'delivery'
    )),
    basis         TEXT NOT NULL CHECK (basis IN (
      'human_approval', 'notify_policy', 'off_policy', 'import'
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
    UNIQUE (id, spec_id),
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
    citation_contract_version INTEGER NOT NULL DEFAULT 2 CHECK (
      citation_contract_version IN (1, 2)
    ),
    citation_version      INTEGER NOT NULL DEFAULT 1 CHECK (
      citation_version > 0
    ),
    citation_hash         TEXT NOT NULL DEFAULT
      '551ce2879a567c8baca5a19f5af4385373bd63b916be6091fa891dd8a307d1df'
      CHECK (
        length(citation_hash) = 64
        AND citation_hash NOT GLOB '*[^0-9a-f]*'
      ),
    proposed_at           TEXT,
    approved_at           TEXT,
    external_delivery_json TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (id, spec_id),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (based_on_revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_revisions_spec_state
    ON spec_revisions (spec_id, state, number DESC);

  /*
   * Why a proposal ended as superseded (#50). One row per dismissed revision,
   * written in the same transaction as its withdrawal, so the state change can
   * never exist without the record of who ended it and what forked past it.
   */
  CREATE TABLE IF NOT EXISTS spec_revision_supersessions (
    revision_id                TEXT PRIMARY KEY,
    spec_id                    TEXT NOT NULL,
    superseded_by_revision_id  TEXT NOT NULL,
    reason                     TEXT NOT NULL,
    actor_json                 TEXT NOT NULL,
    dismissed_at               TEXT NOT NULL,
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (superseded_by_revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_revision_supersessions_spec
    ON spec_revision_supersessions (spec_id);

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

  ${SPEC_EXECUTIONS_SCHEMA_DDL}

  ${SPEC_EXECUTION_BINDINGS_SCHEMA_DDL}

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

  ${SPEC_GATE_ADMISSIONS_SCHEMA_DDL}

  CREATE TABLE IF NOT EXISTS spec_questions (
    id               TEXT PRIMARY KEY,
    spec_id          TEXT NOT NULL,
    number           INTEGER NOT NULL CHECK (number > 0),
    element_id       TEXT,
    text             TEXT NOT NULL,
    provenance_json  TEXT NOT NULL,
    record_version   INTEGER NOT NULL DEFAULT 1 CHECK (record_version > 0),
    status           TEXT NOT NULL CHECK (status IN (
      'open', 'answered', 'withdrawn'
    )),
    answer           TEXT,
    answered_at      TEXT,
    withdrawn_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (id, spec_id),
    UNIQUE (spec_id, number),
    CHECK (
      (status = 'open' AND answer IS NULL AND answered_at IS NULL
        AND withdrawn_at IS NULL)
      OR
      (status = 'answered' AND answer IS NOT NULL AND length(answer) > 0
        AND answered_at IS NOT NULL AND withdrawn_at IS NULL)
      OR
      (status = 'withdrawn' AND answer IS NULL AND answered_at IS NULL
        AND withdrawn_at IS NOT NULL)
    ),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id, spec_id) REFERENCES spec_elements(id, spec_id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_questions_spec_status
    ON spec_questions (spec_id, status, number);

  CREATE TABLE IF NOT EXISTS spec_assumptions (
    id                           TEXT PRIMARY KEY,
    spec_id                      TEXT NOT NULL,
    number                       INTEGER NOT NULL CHECK (number > 0),
    element_id                   TEXT,
    text                         TEXT NOT NULL,
    proposed_by_json             TEXT NOT NULL,
    record_version               INTEGER NOT NULL DEFAULT 1 CHECK (
      record_version > 0
    ),
    disposition                  TEXT NOT NULL CHECK (disposition IN (
      'proposed', 'confirmed', 'rejected', 'deferred', 'withdrawn'
    )),
    disposed_at                  TEXT,
    withdrawn_at                 TEXT,
    supersedes_assumption_id     TEXT,
    supersession_operation_id    TEXT,
    supersession_request_hash    TEXT CHECK (
      supersession_request_hash IS NULL OR (
        length(supersession_request_hash) = 64
        AND supersession_request_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (id, spec_id),
    UNIQUE (spec_id, number),
    CHECK (
      (disposition = 'proposed' AND disposed_at IS NULL
        AND withdrawn_at IS NULL)
      OR
      (disposition IN ('confirmed', 'rejected', 'deferred')
        AND disposed_at IS NOT NULL AND withdrawn_at IS NULL)
      OR
      (disposition = 'withdrawn' AND disposed_at IS NULL
        AND withdrawn_at IS NOT NULL)
    ),
    CHECK (
      supersedes_assumption_id IS NULL OR id <> supersedes_assumption_id
    ),
    CHECK (
      (supersedes_assumption_id IS NULL
        AND supersession_operation_id IS NULL
        AND supersession_request_hash IS NULL)
      OR
      (supersedes_assumption_id IS NOT NULL
        AND supersession_operation_id IS NOT NULL
        AND supersession_request_hash IS NOT NULL)
    ),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (element_id, spec_id) REFERENCES spec_elements(id, spec_id),
    FOREIGN KEY (supersedes_assumption_id, spec_id)
      REFERENCES spec_assumptions(id, spec_id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_assumptions_spec_disposition
    ON spec_assumptions (spec_id, disposition, number);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_assumptions_predecessor
    ON spec_assumptions (spec_id, supersedes_assumption_id)
    WHERE supersedes_assumption_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_spec_assumptions_operation
    ON spec_assumptions (spec_id, supersession_operation_id)
    WHERE supersession_operation_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_revision_assumption_citations (
    revision_id              TEXT NOT NULL,
    spec_id                  TEXT NOT NULL,
    element_id               TEXT NOT NULL,
    assumption_id            TEXT NOT NULL,
    assumption_snapshot_json TEXT NOT NULL CHECK (
      json_valid(assumption_snapshot_json)
    ),
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    PRIMARY KEY (revision_id, element_id, assumption_id),
    FOREIGN KEY (revision_id, spec_id)
      REFERENCES spec_revisions(id, spec_id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id, element_id)
      REFERENCES spec_element_versions(revision_id, element_id)
        ON DELETE CASCADE,
    FOREIGN KEY (assumption_id, spec_id)
      REFERENCES spec_assumptions(id, spec_id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_revision_citations_revision_assumption
    ON spec_revision_assumption_citations (revision_id, assumption_id);
  CREATE INDEX IF NOT EXISTS idx_spec_revision_citations_assumption_revision
    ON spec_revision_assumption_citations (assumption_id, revision_id);

  CREATE TRIGGER IF NOT EXISTS spec_revision_citations_same_spec_insert
  BEFORE INSERT ON spec_revision_assumption_citations
  WHEN NOT EXISTS (
    SELECT 1 FROM spec_elements
    WHERE id = NEW.element_id AND spec_id = NEW.spec_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'citation element must belong to the same spec');
  END;

  CREATE TRIGGER IF NOT EXISTS spec_revision_citations_same_spec_update
  BEFORE UPDATE ON spec_revision_assumption_citations
  WHEN NOT EXISTS (
    SELECT 1 FROM spec_elements
    WHERE id = NEW.element_id AND spec_id = NEW.spec_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'citation element must belong to the same spec');
  END;

  CREATE TRIGGER IF NOT EXISTS spec_revision_citations_frozen_insert
  BEFORE INSERT ON spec_revision_assumption_citations
  WHEN COALESCE((
    SELECT state FROM spec_revisions WHERE id = NEW.revision_id
  ), '') <> 'draft'
  BEGIN
    SELECT RAISE(ABORT, 'frozen revision citations require a draft');
  END;

  CREATE TRIGGER IF NOT EXISTS spec_revision_citations_frozen_update
  BEFORE UPDATE ON spec_revision_assumption_citations
  WHEN COALESCE((
    SELECT state FROM spec_revisions WHERE id = OLD.revision_id
  ), '') <> 'draft'
    OR COALESCE((
      SELECT state FROM spec_revisions WHERE id = NEW.revision_id
    ), '') <> 'draft'
  BEGIN
    SELECT RAISE(ABORT, 'frozen revision citations require a draft');
  END;

  CREATE TRIGGER IF NOT EXISTS spec_revision_citations_frozen_delete
  BEFORE DELETE ON spec_revision_assumption_citations
  WHEN COALESCE((
    SELECT state FROM spec_revisions WHERE id = OLD.revision_id
  ), '') <> 'draft'
  BEGIN
    SELECT RAISE(ABORT, 'frozen revision citations require a draft');
  END;

  CREATE TRIGGER IF NOT EXISTS spec_revision_citation_metadata_frozen_update
  BEFORE UPDATE OF
    citation_contract_version, citation_version, citation_hash
  ON spec_revisions
  WHEN OLD.state <> 'draft' AND (
    NEW.citation_contract_version <> OLD.citation_contract_version
    OR NEW.citation_version <> OLD.citation_version
    OR NEW.citation_hash <> OLD.citation_hash
  )
  BEGIN
    SELECT RAISE(ABORT, 'frozen revision citation metadata requires a draft');
  END;

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

  ${SPEC_DELIVERY_VERDICTS_SCHEMA_DDL}

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

/**
 * `DeliveryPlanAttempt` storage (design §4). The attempt is the per-execution
 * delivery plan document that is also the scope; it is keyed by its own id,
 * independently of evergreen revisions and workflow executions, because it
 * exists before the execution does.
 *
 * The document lives whole in `content_json` rather than in normalized child
 * tables: it is edited, proposed, and materialized as one unit under a single
 * compare-and-swap token, and a per-node table would let a partial write leave
 * a plan whose contexts and dispositions disagree.
 *
 * Snapshots are append-only. Nothing updates a snapshot row — a reopen bumps
 * the attempt's `draft_revision` and clears `approval_json`, and the prior
 * snapshots stay readable exactly as they were proposed.
 *
 * A compiled candidate is keyed one-to-one to the snapshot it materialized:
 * the UNIQUE constraint on `snapshot_id` is what makes "exactly one immutable
 * candidate per proposed snapshot" a database fact rather than a service
 * convention, so a second materialization of the same proposal cannot quietly
 * replace the bytes a human approved (`exact-approval`).
 *
 * Exported so migrations 0015 and 0016 apply the identical DDL to pre-floor
 * databases without a second hand-synced copy.
 */
export const SPEC_DELIVERY_PLAN_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_delivery_plan_attempts (
    id                        TEXT PRIMARY KEY,
    spec_id                   TEXT NOT NULL,
    pinned_revision_id        TEXT NOT NULL,
    delta_basis_execution_id  TEXT,
    status                    TEXT NOT NULL CHECK (status IN (
      'draft', 'proposed', 'approved', 'parked', 'launched', 'abandoned'
    )),
    draft_revision            INTEGER NOT NULL CHECK (draft_revision > 0),
    content_json              TEXT NOT NULL,
    proposed_snapshot_id      TEXT,
    approval_json             TEXT,
    prelaunch_json            TEXT,
    launched_execution_id     TEXT,
    workflow_definition_id    TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (pinned_revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (delta_basis_execution_id) REFERENCES spec_executions(id),
    FOREIGN KEY (launched_execution_id) REFERENCES spec_executions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_delivery_plan_attempts_spec
    ON spec_delivery_plan_attempts (spec_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spec_delivery_plan_attempts_revision
    ON spec_delivery_plan_attempts (pinned_revision_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_delivery_plan_attempts_definition
    ON spec_delivery_plan_attempts (workflow_definition_id)
    WHERE workflow_definition_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_delivery_plan_snapshots (
    id                  TEXT PRIMARY KEY,
    attempt_id          TEXT NOT NULL,
    candidate_id        TEXT NOT NULL,
    candidate_hash      TEXT NOT NULL,
    draft_revision      INTEGER NOT NULL CHECK (draft_revision > 0),
    content_json        TEXT NOT NULL,
    pinned_revision_id  TEXT NOT NULL,
    proposed_at         TEXT NOT NULL,
    proposed_by_json    TEXT NOT NULL,
    workflow_definition_id        TEXT,
    workflow_definition_revision  INTEGER,
    workflow_definition_hash      TEXT,
    binding_hash                  TEXT,
    UNIQUE (attempt_id, draft_revision),
    FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_delivery_plan_snapshots_attempt
    ON spec_delivery_plan_snapshots (attempt_id, draft_revision DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_delivery_plan_snapshots_definition
    ON spec_delivery_plan_snapshots (workflow_definition_id)
    WHERE workflow_definition_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS spec_delivery_plan_candidate_approvals (
    snapshot_id       TEXT PRIMARY KEY,
    candidate_id      TEXT NOT NULL,
    candidate_hash    TEXT NOT NULL,
    approved_at       TEXT NOT NULL,
    approved_by_json  TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES spec_delivery_plan_snapshots(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS spec_delivery_plan_comments (
    id           TEXT PRIMARY KEY,
    attempt_id   TEXT NOT NULL,
    context_id   TEXT NOT NULL,
    body         TEXT NOT NULL,
    author_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_delivery_plan_comments_attempt
    ON spec_delivery_plan_comments (attempt_id, created_at ASC);
`;

/**
 * Work a running execution found and deliberately left for the next plan
 * (design §11). Kept out of `SPEC_DELIVERY_PLAN_SCHEMA_DDL` so the migration
 * that introduced the attempt tables keeps meaning exactly what it meant.
 *
 * `attempt_id` is nullable because a legacy compiled run has no attempt behind
 * it, and it is `ON DELETE SET NULL` rather than cascading: the discovery is
 * work the next plan still owes, so it must outlive the attempt that found it.
 */
export const SPEC_DELIVERY_DISCOVERY_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_delivery_discoveries (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    execution_id          TEXT NOT NULL,
    attempt_id            TEXT,
    pinned_revision_id    TEXT NOT NULL,
    discovered_task_json  TEXT NOT NULL,
    blocking_reason       TEXT,
    captured_by_json      TEXT NOT NULL,
    captured_at           TEXT NOT NULL,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
      ON DELETE CASCADE,
    FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
      ON DELETE SET NULL,
    FOREIGN KEY (pinned_revision_id) REFERENCES spec_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_delivery_discoveries_spec
    ON spec_delivery_discoveries (spec_id, captured_at ASC, id ASC);
  CREATE INDEX IF NOT EXISTS idx_spec_delivery_discoveries_execution
    ON spec_delivery_discoveries (execution_id);
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

  ${SPEC_EXECUTIONS_SCHEMA_DDL}

  ${SPEC_EXECUTION_BINDINGS_SCHEMA_DDL}

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

/**
 * Validation run ledger (design: validation-concurrency §4/§12): operational
 * ownership state for crash recovery first; terminal rows are RETAINED as the
 * per-run timing record, so there is deliberately no delete-on-terminal path.
 * Deliberately no FK to projects/sessions — the ledger is an append-mostly
 * operational log whose lifecycle is independent of project/session rows.
 *
 * Exported so migration 0011 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy.
 */
export const VALIDATION_RUNS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS validation_runs (
    run_id                TEXT PRIMARY KEY,
    source                TEXT NOT NULL CHECK (source IN (
      'agent_cli', 'graph_script_validator', 'graph_lane_merge',
      'smart_merge', 'smart_commit'
    )),
    command_name          TEXT NOT NULL,
    cost                  INTEGER NOT NULL CHECK (cost > 0),
    queue_order           INTEGER NOT NULL CHECK (queue_order >= 0),
    status                TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'passed', 'failed', 'timed_out',
      'cancelled', 'interrupted', 'cost_exceeds_limit'
    )),
    nonce                 TEXT NOT NULL,
    lease_token           TEXT,
    lease_expires_at      TEXT,
    process_group_pid     INTEGER,
    project_path          TEXT NOT NULL,
    worktree_path         TEXT NOT NULL,
    session_name          TEXT,
    conversation_id       TEXT,
    workflow_execution_id TEXT,
    workflow_context_id   TEXT,
    workflow_role         TEXT CHECK (workflow_role IN (
      'implementer', 'context_validator'
    )),
    submitted_at          TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    queue_ms              INTEGER,
    exec_ms               INTEGER,
    requested_scope       TEXT CHECK (requested_scope IN ('changed', 'full')),
    effective_scope       TEXT CHECK (effective_scope IN ('changed', 'full')),
    scoped                INTEGER NOT NULL DEFAULT 0,
    scoped_path_count     INTEGER NOT NULL DEFAULT 0,
    exit_code             INTEGER,
    timed_out             INTEGER NOT NULL DEFAULT 0
  );

  -- Admission and crash recovery scan by status; queue_order keeps strict
  -- FIFO ordering a single index range.
  CREATE INDEX IF NOT EXISTS idx_validation_runs_status_queue
    ON validation_runs (status, queue_order);
  -- Timing accounting reads per project x command distributions (design 12).
  CREATE INDEX IF NOT EXISTS idx_validation_runs_project_command
    ON validation_runs (project_path, command_name);
`;

/**
 * The result-delivery ledger (D7 decision D8): one row per lifecycle boundary
 * of an execution whose origin conversation is alive, inserted in the same
 * transaction as the boundary's event append. `(execution_id, boundary_seq)` is
 * the primary key, so a replayed recording collides instead of double-
 * delivering, and the pending scan a turn performs is one index range.
 *
 * Deliberately no FK on `origin_conversation_id`: deleting the origin
 * conversation must leave the pending rows alive long enough to settle once
 * into a session-scoped notification. The session FK cascades, because a
 * deleted session takes its executions with it.
 *
 * Exported so migration 0024 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy.
 */
export const GRAPH_WORKFLOW_RESULT_DELIVERIES_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS graph_workflow_result_deliveries (
    execution_id           TEXT NOT NULL,
    boundary_seq           INTEGER NOT NULL,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    origin_conversation_id TEXT NOT NULL,
    payload_json           TEXT NOT NULL,
    recorded_at            TEXT NOT NULL,
    delivery_state         TEXT NOT NULL DEFAULT 'pending' CHECK (
      delivery_state IN ('pending', 'delivering', 'delivered')
    ),
    attempt_id             TEXT,
    attempt_count          INTEGER NOT NULL DEFAULT 0,
    delivered_at           TEXT,
    effects_delivered_at   TEXT,
    PRIMARY KEY (execution_id, boundary_seq),
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  -- Turn assembly claims this conversation's undelivered rows in boundary order.
  CREATE INDEX IF NOT EXISTS idx_graph_workflow_result_deliveries_pending
    ON graph_workflow_result_deliveries (
      origin_conversation_id, delivery_state, boundary_seq
    );
  -- Every delivery read is scoped by the full project/session/execution triple.
  CREATE INDEX IF NOT EXISTS idx_graph_workflow_result_deliveries_session
    ON graph_workflow_result_deliveries (
      project_path, session_name, execution_id
    );
`;

/**
 * The reserved-but-unmaterialized artifacts of one launch (D7 R3.4): the seeded
 * documents' CONTENTS, inserted in the same transaction that installs the
 * winner's execution row and deleted once its `.cc` writes succeed.
 *
 * One row per execution, because the record answers a yes/no question about one
 * launch — "are this run's artifacts known to be on disk?" — and its presence is
 * the marker a kickoff retries from. The session FK cascades: a deleted session
 * has no run left to materialize for.
 *
 * Exported so migration 0025 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy.
 */
export const GRAPH_WORKFLOW_PENDING_ARTIFACTS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS graph_workflow_pending_artifacts (
    execution_id   TEXT PRIMARY KEY,
    project_path   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    documents_json TEXT NOT NULL,
    recorded_at    TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  -- Every pending-artifact read is scoped by the full project/session/execution
  -- triple, so a same-id record from another session cannot reach a retry.
  CREATE INDEX IF NOT EXISTS idx_graph_workflow_pending_artifacts_session
    ON graph_workflow_pending_artifacts (
      project_path, session_name, execution_id
    );
`;

/**
 * Terminal plan-review verdicts (#69 change 5): one row per concluded review,
 * bound to the reviewed revision by `workingDefinitionHash` rather than by a
 * plan id, so the record answers "was THIS revision judged?" after any edit.
 *
 * Deliberately unscoped — no project, session, or execution foreign key. A plan
 * is reviewed before it is created, so at record time there is no execution row
 * to hang the verdict off, and the review's value is precisely that it outlives
 * the revision it judged. `reviewer_conversation_id` likewise carries no FK: a
 * compacted or deleted reviewing conversation must not silently delete the
 * verdict it produced.
 *
 * Many rows per hash by design: a revision can be reviewed more than once, and
 * the read path takes the most recent by `reviewed_at` rather than assuming a
 * single verdict. The CHECK pins the terminal-only vocabulary at the storage
 * layer — a draft or canceled review has no row here at all.
 *
 * Exported so migration 0032 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy.
 */
export const GRAPH_PLAN_REVIEWS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS graph_plan_reviews (
    id                       TEXT PRIMARY KEY,
    definition_hash          TEXT NOT NULL,
    reviewer_conversation_id TEXT NOT NULL,
    verdict                  TEXT NOT NULL CHECK (
      verdict IN ('approved', 'changes_requested')
    ),
    findings                 TEXT,
    reviewed_at              TEXT NOT NULL
  );

  -- The one read shape: every review of one exact revision, newest last.
  CREATE INDEX IF NOT EXISTS idx_graph_plan_reviews_definition_hash
    ON graph_plan_reviews (definition_hash, reviewed_at);
`;

/**
 * Notepads: durable, reference-aware working context shared by the user and
 * agents. Three tables — the head row, its append-only revision history, and
 * the metadata for images whose bytes live in the notepad content store.
 *
 * `project_path` is nullable because a notepad is either global or owned by one
 * project, and the CHECK pins that pairing in both directions so a project-scoped
 * row can never lose its owner and a global row can never acquire one. Name
 * uniqueness is an expression index over `IFNULL(project_path, '')` rather than
 * a plain UNIQUE constraint: SQLite treats every NULL as distinct, so a plain
 * constraint would let the global scope hold unlimited same-named notepads.
 *
 * `revision` is the monotonic per-notepad compare-and-swap token agent writes
 * state; `write_mode` is the user's cooperative guardrail over agent writes and
 * defaults to `full-edit` at the storage layer so the UI and the agent `create`
 * verb inherit one default.
 *
 * `notepad_revisions.author_conversation_id` deliberately carries NO foreign key
 * (the `graph_plan_reviews` precedent): deleting or compacting a conversation
 * must not delete the history it authored. Content is a full snapshot per
 * revision, which makes restore a row copy instead of a reconstruction.
 *
 * Row cascades cover only the database — image BYTES are removed by the notepad
 * content store, which the notepad and project deletion paths call explicitly.
 *
 * Exported so migration 0035 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy. Purely additive, so no
 * KNOWN_SCHEMA_VERSION bump: an older build sharing `command-center.db` simply
 * ignores tables it has no reader for.
 */
export const NOTEPADS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS notepads (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_path TEXT,
    name         TEXT NOT NULL,
    content      TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    write_mode   TEXT NOT NULL DEFAULT 'full-edit' CHECK (write_mode IN (
      'read-only', 'append-only', 'full-edit'
    )),
    pinned       INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CHECK ((scope = 'project') = (project_path IS NOT NULL)),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  -- Names are unique per scope. The IFNULL collapses the global scope's NULL
  -- project onto one bucket so its names actually collide.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_notepads_scope_name
    ON notepads (scope, IFNULL(project_path, ''), name);

  -- The panel and picker read shape: one scope's unarchived notepads, pinned
  -- first, most recently touched first.
  CREATE INDEX IF NOT EXISTS idx_notepads_scope_listing
    ON notepads (scope, project_path, archived, pinned DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS notepad_revisions (
    id                     TEXT PRIMARY KEY,
    notepad_id             TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    content                TEXT NOT NULL,
    author_kind            TEXT NOT NULL CHECK (author_kind IN (
      'user', 'agent'
    )),
    author_conversation_id TEXT,
    origin                 TEXT NOT NULL CHECK (origin IN (
      'create', 'edit', 'append', 'restore'
    )),
    base_revision          INTEGER,
    restored_from_revision INTEGER,
    created_at             TEXT NOT NULL,
    UNIQUE (notepad_id, revision),
    FOREIGN KEY (notepad_id) REFERENCES notepads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notepad_images (
    id           TEXT PRIMARY KEY,
    notepad_id   TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    media_type   TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    snapshot_key TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (notepad_id) REFERENCES notepads(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notepad_images_notepad_created
    ON notepad_images (notepad_id, created_at);
`;

/**
 * Review comments on a notepad passage and their replies (spec design D15).
 * Separate from `NOTEPADS_SCHEMA_DDL` so migration `0036-add-notepad-comments`
 * applies exactly these two tables to a database that already recorded the
 * notepad tables — the same exported-DDL recipe, one constant per ledger entry.
 *
 * The anchor is stored as flat columns rather than a JSON blob: every field is
 * a scalar the durability contract can see, and none of them is read as a set.
 */
export const NOTEPAD_COMMENTS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS notepad_comments (
    id                     TEXT PRIMARY KEY,
    notepad_id             TEXT NOT NULL,
    section_id             TEXT NOT NULL,
    heading_label          TEXT NOT NULL,
    line                   INTEGER NOT NULL,
    char_start             INTEGER NOT NULL,
    char_end               INTEGER NOT NULL,
    quote                  TEXT NOT NULL,
    prefix                 TEXT NOT NULL,
    suffix                 TEXT NOT NULL,
    -- The notepad revision the passage was quoted from, so a stale anchor can
    -- name the version it was authored against.
    notepad_revision       INTEGER NOT NULL,
    body                   TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN (
      'open', 'resolved'
    )),
    author_kind            TEXT NOT NULL CHECK (author_kind IN (
      'user', 'agent'
    )),
    -- Deliberately FK-less, like notepad_revisions: deleting a conversation
    -- must not delete the review it authored.
    author_conversation_id TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    resolved_at            TEXT,
    FOREIGN KEY (notepad_id) REFERENCES notepads(id) ON DELETE CASCADE
  );

  -- The listing read shape: one notepad's comments, open set first-class,
  -- oldest first so a review reads in the order it was written.
  CREATE INDEX IF NOT EXISTS idx_notepad_comments_notepad_status
    ON notepad_comments (notepad_id, status, created_at);

  CREATE TABLE IF NOT EXISTS notepad_comment_replies (
    id                     TEXT PRIMARY KEY,
    comment_id             TEXT NOT NULL,
    body                   TEXT NOT NULL,
    author_kind            TEXT NOT NULL CHECK (author_kind IN (
      'user', 'agent'
    )),
    author_conversation_id TEXT,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (comment_id) REFERENCES notepad_comments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notepad_comment_replies_comment
    ON notepad_comment_replies (comment_id, created_at);
`;

/**
 * Per conversation and notepad, the state last presented to the agent — the
 * delivery watermark change notices compare against (spec design D17).
 *
 * `conversation_id` is deliberately FK-less, like `notepad_revisions`: a
 * conversation lives in a different table family and may be compacted or
 * removed without taking the notepad's delivery history with it. The notepad
 * side DOES cascade, because a watermark for a deleted notepad can never
 * produce a notice again.
 *
 * The composite primary key is `(conversation_id, notepad_id)`, so the one read
 * shape — every notepad a conversation has seen — rides its leftmost prefix and
 * needs no second index. Recording is an upsert on that key: a conversation
 * holds exactly one watermark per notepad, never a delivery log.
 *
 * Content-free by construction: versions and counts only, never notepad text or
 * a comment body.
 */
export const NOTEPAD_DELIVERY_WATERMARKS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS notepad_delivery_watermarks (
    conversation_id        TEXT NOT NULL,
    notepad_id             TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    open_comment_count     INTEGER NOT NULL,
    latest_open_comment_at TEXT,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (conversation_id, notepad_id),
    FOREIGN KEY (notepad_id) REFERENCES notepads(id) ON DELETE CASCADE
  );
`;

export const TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS ticket_relationships (
    id               TEXT PRIMARY KEY,
    relation_type    TEXT NOT NULL CHECK (relation_type IN (
      'related', 'depends_on', 'parent_child'
    )),
    source_ticket_id TEXT NOT NULL,
    target_ticket_id TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CHECK (source_ticket_id <> target_ticket_id),
    CHECK (relation_type <> 'related' OR source_ticket_id < target_ticket_id),
    UNIQUE (relation_type, source_ticket_id, target_ticket_id),
    FOREIGN KEY (source_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (target_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_relationships_source_updated
    ON ticket_relationships (source_ticket_id, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ticket_relationships_target_updated
    ON ticket_relationships (target_ticket_id, updated_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_relationships_parent_child_target
    ON ticket_relationships (target_ticket_id)
    WHERE relation_type = 'parent_child';

  CREATE TABLE IF NOT EXISTS ticket_status_updates (
    id            TEXT PRIMARY KEY,
    ticket_id     TEXT NOT NULL,
    body_markdown TEXT NOT NULL CHECK (length(trim(body_markdown)) > 0),
    author_json   TEXT NOT NULL CHECK (json_valid(author_json)),
    created_at    TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_status_updates_ticket_created
    ON ticket_status_updates (ticket_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS ticket_relationship_legacy_aliases (
    legacy_attachment_id TEXT PRIMARY KEY,
    relationship_id      TEXT NOT NULL,
    anchor_ticket_id     TEXT NOT NULL,
    FOREIGN KEY (relationship_id)
      REFERENCES ticket_relationships(id) ON DELETE CASCADE,
    FOREIGN KEY (anchor_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_relationship_legacy_aliases_anchor_relationship
    ON ticket_relationship_legacy_aliases (anchor_ticket_id, relationship_id);
`;

/**
 * Memory Notes: the Command Center-native shared memory the `memory` spec
 * defines (R1-R4, D1-D3). Four canonical tables — the head note, its flat
 * aliases, its full-snapshot revision history, and its typed artifact links.
 * The derived FTS5 index is a SEPARATE constant so its ledger entry stands
 * alone, matching the notepad recipe of one DDL constant per migration.
 *
 * `search_rowid` is an INTEGER PRIMARY KEY — a true rowid alias — because it is
 * the rowid the contentless FTS5 index joins back on. The implicit rowid of a
 * TEXT-primary-key table would have served until the first `VACUUM` renumbered
 * it and silently pointed every search hit at the wrong note. `id` stays the
 * immutable identity every other table references.
 *
 * The CHECK constraints hold the schema-level rules from the other side:
 * scope pairs with its owner in both directions, session identity is the exact
 * incarnation (name AND created-at, mirroring `ticket_sessions`), the wholly
 * perishable `state` kind is session-only, and a `state` note never nests the
 * perishable status line that exists to keep a DURABLE note deliverable.
 *
 * Slug uniqueness is partial — `WHERE lifecycle <> 'archived'` — because
 * supersession archives a predecessor and the successor commonly takes its
 * slug. An archived note keeps its slug for history and explicit archived
 * reads, and never disambiguates a bare one (R4).
 *
 * Session identity carries NO foreign key to `sessions`, following
 * `ticket_sessions`: the incarnation is a recorded value, and a session that is
 * deleted must not take the durable notes awaiting promotion with it. The
 * project FK does cascade, because a removed project's memory has no reader.
 *
 * Exported so migration 0040 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy. Purely additive, so no
 * KNOWN_SCHEMA_VERSION bump: an older build sharing `command-center.db` simply
 * ignores tables it has no reader for.
 */
export const MEMORY_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS memory_notes (
    search_rowid             INTEGER PRIMARY KEY,
    id                       TEXT NOT NULL UNIQUE,
    slug                     TEXT NOT NULL,
    scope                    TEXT NOT NULL CHECK (scope IN (
      'global', 'project', 'session'
    )),
    project_path             TEXT,
    session_name             TEXT,
    session_created_at       TEXT,
    kind                     TEXT NOT NULL CHECK (kind IN (
      'lesson', 'procedure', 'preference', 'state'
    )),
    hook                     TEXT NOT NULL,
    body                     TEXT NOT NULL,
    status_note_text         TEXT,
    status_note_updated_at   TEXT,
    status_note_review_after TEXT,
    index_mode               TEXT NOT NULL CHECK (index_mode IN (
      'auto', 'always', 'search-only'
    )),
    lifecycle                TEXT NOT NULL CHECK (lifecycle IN (
      'proposed', 'active', 'archived'
    )),
    review_after             TEXT,
    expires_at               TEXT,
    supersedes_id            TEXT,
    superseded_by_id         TEXT,
    created_by               TEXT NOT NULL CHECK (created_by IN (
      'user', 'agent'
    )),
    author_conversation_id   TEXT,
    revision                 INTEGER NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    CHECK ((scope = 'global') = (project_path IS NULL)),
    CHECK ((scope = 'session') = (session_name IS NOT NULL)),
    CHECK ((session_name IS NULL) = (session_created_at IS NULL)),
    CHECK (kind <> 'state' OR scope = 'session'),
    CHECK (kind <> 'state' OR status_note_text IS NULL),
    CHECK ((status_note_text IS NULL) = (status_note_updated_at IS NULL)),
    CHECK ((status_note_text IS NULL) = (status_note_review_after IS NULL)),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE,
    FOREIGN KEY (supersedes_id) REFERENCES memory_notes(id) ON DELETE SET NULL,
    FOREIGN KEY (superseded_by_id) REFERENCES memory_notes(id) ON DELETE SET NULL
  );

  -- Slugs are unique per scope owner among the records a bare slug resolves.
  -- The IFNULLs collapse each scope's NULL owner columns onto one bucket so
  -- names actually collide there, exactly as the notepad name index does.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_notes_scope_slug
    ON memory_notes (
      scope, IFNULL(project_path, ''), IFNULL(session_name, ''),
      IFNULL(session_created_at, ''), slug
    )
    WHERE lifecycle <> 'archived';

  -- The delivery read shape: one conversation's visible scope union, freshest
  -- first, with the archived tail excluded.
  CREATE INDEX IF NOT EXISTS idx_memory_notes_scope_listing
    ON memory_notes (scope, project_path, lifecycle, updated_at DESC);

  CREATE TABLE IF NOT EXISTS memory_note_aliases (
    memory_id TEXT NOT NULL,
    alias     TEXT NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (memory_id, alias),
    FOREIGN KEY (memory_id) REFERENCES memory_notes(id) ON DELETE CASCADE
  );

  -- Resolution reads aliases by value across the visible scopes.
  CREATE INDEX IF NOT EXISTS idx_memory_note_aliases_alias
    ON memory_note_aliases (alias);

  CREATE TABLE IF NOT EXISTS memory_note_revisions (
    id                     TEXT PRIMARY KEY,
    memory_id              TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    -- The WHOLE note as it stood, so restore is a snapshot copy forward.
    snapshot_json          TEXT NOT NULL,
    origin                 TEXT NOT NULL CHECK (origin IN (
      'create', 'edit', 'restore', 'archive'
    )),
    base_revision          INTEGER,
    restored_from_revision INTEGER,
    author_kind            TEXT NOT NULL CHECK (author_kind IN (
      'user', 'agent'
    )),
    -- Deliberately FK-less, like notepad_revisions: deleting or compacting a
    -- conversation must not delete the history it authored.
    author_conversation_id TEXT,
    created_at             TEXT NOT NULL,
    UNIQUE (memory_id, revision),
    FOREIGN KEY (memory_id) REFERENCES memory_notes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_links (
    id                          TEXT PRIMARY KEY,
    memory_id                   TEXT NOT NULL,
    kind                        TEXT NOT NULL CHECK (kind IN (
      'about', 'source'
    )),
    artifact_kind               TEXT NOT NULL CHECK (artifact_kind IN (
      'ticket', 'spec', 'session', 'workflow_execution'
    )),
    artifact_id                 TEXT,
    -- Set only beside a workflow_execution id: the row then references one
    -- execution context of that run rather than the whole run. Added after
    -- the table shipped, so it also appears in ADDITIVE_COLUMNS.
    artifact_context_id         TEXT,
    artifact_project_path       TEXT,
    artifact_session_name       TEXT,
    artifact_session_created_at TEXT,
    created_at                  TEXT NOT NULL,
    -- A session artifact is its exact incarnation; every other kind is one
    -- immutable native id.
    CHECK ((artifact_kind = 'session') = (artifact_id IS NULL)),
    CHECK ((artifact_kind = 'session') = (artifact_project_path IS NOT NULL)),
    CHECK ((artifact_kind = 'session') = (artifact_session_name IS NOT NULL)),
    CHECK ((artifact_kind = 'session') = (artifact_session_created_at IS NOT NULL)),
    FOREIGN KEY (memory_id) REFERENCES memory_notes(id) ON DELETE CASCADE
  );

  -- The link identity index lives in MEMORY_LINKS_IDENTITY_INDEX_DDL: it names
  -- artifact_context_id, which a database created before that column existed
  -- only gains in the additive-column pass that follows this DDL.

  -- The two link read shapes: one note's links, and every note pointed at one
  -- artifact (about-ranking).
  CREATE INDEX IF NOT EXISTS idx_memory_links_memory_kind
    ON memory_links (memory_id, kind);
  CREATE INDEX IF NOT EXISTS idx_memory_links_artifact
    ON memory_links (artifact_kind, artifact_id);
`;

/**
 * The memory-link identity index, applied AFTER the additive-column pass
 * because it names `artifact_context_id`. One row per (note, kind, artifact):
 * re-linking the same thing lands on the row that already exists rather than
 * accumulating a duplicate. The v1 index predates the context column and would
 * collapse two context links of one note into one execution onto a single row,
 * so it is retired here (a no-op once gone).
 */
export const MEMORY_LINKS_IDENTITY_INDEX_DDL = `
  DROP INDEX IF EXISTS uq_memory_links_identity;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_links_identity_v2
    ON memory_links (
      memory_id, kind, artifact_kind, IFNULL(artifact_id, ''),
      IFNULL(artifact_context_id, ''), IFNULL(artifact_project_path, ''),
      IFNULL(artifact_session_name, ''), IFNULL(artifact_session_created_at, '')
    );
`;

/**
 * The derived Memory Note search index (spec `memory`, D1 and the
 * `inv-fts-derived-rebuildable` invariant). Separate from
 * {@link MEMORY_SCHEMA_DDL} so its ledger entry stands alone, matching the
 * notepad recipe of one DDL constant per migration.
 *
 * `content=''` makes it CONTENTLESS: FTS5 stores the inverted index and no
 * column values at all, so canonical content cannot come to live here — a
 * `SELECT` returns NULL for every column. That is the invariant enforced by
 * construction rather than by convention, and it costs nothing the recall path
 * wants, since bodies are read from `memory_notes`. `contentless_delete=1`
 * keeps DELETE and re-INSERT available, which is how a note's row is refreshed
 * in the same write path as the canonical tables.
 *
 * The rowid is `memory_notes.search_rowid` — an INTEGER PRIMARY KEY alias, so
 * it survives a VACUUM that would renumber an implicit rowid and silently point
 * every hit at the wrong note.
 *
 * `porter unicode61` stems, so a note written about "running" answers a search
 * for "run"; the corpus-seeded recall evaluation depends on it.
 *
 * Exported so migration 0041 applies the identical DDL to pre-floor databases.
 * Purely additive and fully rebuildable: an older build ignores it, and a build
 * that never writes it can restore it from the canonical tables at any time.
 */
export const MEMORY_SEARCH_SCHEMA_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
    slug,
    hook,
    aliases,
    body,
    content='',
    contentless_delete=1,
    tokenize='porter unicode61'
  );
`;

/**
 * Delivery watermarks and observation counters for Memory Notes (spec R15).
 * All three tables are evaluation instruments and delta inputs: they record
 * what a conversation was shown and how often a record was retrieved, and
 * NOTHING reads them back into selection. That separation is structural rather
 * than conventional — they sit outside `MEMORY_SCHEMA_DDL` and outside
 * `MemoryRepo`, so the composer and the recall ranker have no route to a
 * counter to consult (`inv-no-popularity-or-telemetry-rank`).
 *
 * `memory_delivery_watermarks` follows the notepad delivery precedent exactly:
 * an upsert keyed by `(conversation_id, memory_id, channel)` stating where the
 * conversation stands, not how it got there. `channel` splits the two ways a
 * record reaches an agent — the ambient `index` block and an `expanded` recall
 * pack — because R15 names both and an evaluation that could not tell them
 * apart could not say whether the ambient block is doing the work.
 *
 * `status_delivered` records whether that delivery carried the note's status
 * line, which is what makes a status withheld or restored since the last
 * delivery detectable as a delta entry rather than only as current state.
 *
 * `conversation_id` is deliberately FK-less, like `notepad_delivery_watermarks`
 * and `memory_note_revisions`: a compacted or deleted conversation must not
 * take the delivery record with it. The memory side DOES cascade, because a
 * watermark for a deleted note can never be read again.
 *
 * `memory_index_delivery_state` holds a conversation's place in the
 * once-then-delta delivery: one row, created by its first full block, read
 * before every ambient composition to decide what the next turn is due, and
 * deleted on a context loss. Read before composition, yes — but only to decide
 * what a delta carries, never to order or select a note.
 *
 * `memory_observation_counters` is aggregate by construction — one row per
 * `(kind, memory_id)` carrying a count — never a per-delivery ledger. A ledger
 * would grow by the whole index block every turn, and no question R15 asks
 * needs the individual rows. `count` is the number of times the observation was
 * RECORDED (a note delivered on ten turns counts ten); the number of DISTINCT
 * notes behind a kind is that kind's row count.
 *
 * `memory_id` is nullable so an unattributed observation — a validator round
 * that re-derived a fact without naming which record held it — still has a
 * home. That nullability is exactly why identity is carried by a DERIVED `id`
 * (`<kind>:<memoryId ?? "">`) rather than by a composite primary key: SQLite
 * treats NULLs in a unique index as distinct, so `(kind, NULL)` would insert a
 * fresh row on every unattributed observation instead of raising the count.
 *
 * Content-free by construction: ids, counts, and timestamps only, never a hook
 * or a body.
 *
 * Exported so migration 0042 applies the identical DDL to pre-floor databases
 * without a second hand-synced copy. Purely additive, so no
 * KNOWN_SCHEMA_VERSION bump: an older build sharing `command-center.db` simply
 * ignores tables it has no reader for.
 */
export const MEMORY_TELEMETRY_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS memory_delivery_watermarks (
    conversation_id TEXT NOT NULL,
    memory_id       TEXT NOT NULL,
    channel         TEXT NOT NULL CHECK (channel IN ('index', 'expanded')),
    revision        INTEGER NOT NULL,
    -- Whether the delivered text carried the note's status line. A delta
    -- reports a status line withheld or restored since the last delivery, and
    -- that transition is only visible against what was last delivered.
    status_delivered INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (conversation_id, memory_id, channel),
    FOREIGN KEY (memory_id) REFERENCES memory_notes(id) ON DELETE CASCADE
  );

  -- Where one conversation stands with the ambient index. Read before
  -- composition to decide whether the next turn is due the full block or a
  -- delta, and DELETED on a context loss: an absent row is the conversation
  -- that holds no block, which is the same state it was in before its first
  -- turn, so no separate reset marker is needed.
  --
  -- conversation_id is FK-less for the same reason the watermark's is, and
  -- both instants are composition instants supplied by the delivering seam
  -- rather than write clocks.
  CREATE TABLE IF NOT EXISTS memory_index_delivery_state (
    conversation_id  TEXT PRIMARY KEY,
    last_full_at     TEXT NOT NULL,
    last_delivery_at TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_observation_counters (
    -- '<kind>:<memoryId ?? "">' — identity, derived, never displayed.
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN (
      'retrieval_index', 'retrieval_expanded', 'promotion_candidate',
      'promoted', 'validator_rederivation'
    )),
    memory_id         TEXT,
    count             INTEGER NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at  TEXT NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memory_notes(id) ON DELETE CASCADE
  );

  -- The read shape: one note's whole observation record.
  CREATE INDEX IF NOT EXISTS idx_memory_observation_counters_memory
    ON memory_observation_counters (memory_id);
`;

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
    name_origin           TEXT NOT NULL DEFAULT 'default' CHECK (name_origin IN ('default', 'auto', 'manual')),
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
    conversation_owner    TEXT,
    turn_generation       INTEGER NOT NULL DEFAULT 0,
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
    name_origin           TEXT NOT NULL DEFAULT 'default' CHECK (name_origin IN ('default', 'auto', 'manual')),
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
    conversation_owner    TEXT,
    turn_generation       INTEGER NOT NULL DEFAULT 0,
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
    candidate_validation TEXT,
    parked_ref     TEXT,
    prepared_sha   TEXT,
    expected_target_sha TEXT,
    finalize_session_on_publish INTEGER,
    resolution_context TEXT
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

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_events_scope_execution
    ON graph_workflow_events(project_path, session_name, execution_id, id);
  CREATE INDEX IF NOT EXISTS idx_graph_workflow_events_scope_context
    ON graph_workflow_events(
      project_path, session_name, execution_id, context_id, event_type, id
    );

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
    -- Derived projection of holdsExecutionLease(status, haltReason,
    -- abandonment) (D7 decision D15), written by the repository on every
    -- setActive so SQL-side ambient projections never re-derive the classifier.
    -- Last in the column list so an ALTER-upgraded database and a fresh floor
    -- agree on shape. Defaults held: an unprojected row refuses a launch rather
    -- than admitting a second Current run.
    lease_held                INTEGER NOT NULL DEFAULT 1,
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
    backend                    TEXT NOT NULL,             -- claude | codex | cursor
    model_selection_json       TEXT NOT NULL CHECK (
      json_valid(model_selection_json)
    ),
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

  ${TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_DDL}

  ${VALIDATION_RUNS_SCHEMA_DDL}

  ${SPEC_SCHEMA_DDL}

  ${SPEC_DELIVERY_PLAN_SCHEMA_DDL}

  ${SPEC_DELIVERY_DISCOVERY_SCHEMA_DDL}

  ${GRAPH_WORKFLOW_RESULT_DELIVERIES_SCHEMA_DDL}

  ${GRAPH_WORKFLOW_PENDING_ARTIFACTS_SCHEMA_DDL}

  ${GRAPH_PLAN_REVIEWS_SCHEMA_DDL}

  ${NOTEPADS_SCHEMA_DDL}

  ${NOTEPAD_COMMENTS_SCHEMA_DDL}

  ${NOTEPAD_DELIVERY_WATERMARKS_SCHEMA_DDL}

  ${MEMORY_SCHEMA_DDL}

  ${MEMORY_SEARCH_SCHEMA_DDL}

  ${MEMORY_TELEMETRY_SCHEMA_DDL}
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
  { table: "memory_links", column: "artifact_context_id", type: "TEXT" },
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
  // Nullable here on purpose even though the floor declares them NOT NULL: an
  // older database reaches `migrateSpecDirectLaunchStorage` through this
  // back-fill, and that rebuild needs both columns to exist before it can
  // separate finalized snapshots from pre-version-2 ones it must discard.
  {
    table: "spec_delivery_plan_snapshots",
    column: "candidate_id",
    type: "TEXT",
  },
  {
    table: "spec_delivery_plan_snapshots",
    column: "candidate_hash",
    type: "TEXT",
  },
  { table: "job_records", column: "execution_id", type: "TEXT" },
  {
    table: "job_records",
    column: "final_publish",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "job_records", column: "candidate_validation", type: "TEXT" },
  // Parked-merge bookkeeping for a `ready-to-land` job. Additive and nullable
  // with no back-fill: a job that parked a commit before these columns existed
  // left the fact only in the in-memory registry, so null is the truth for
  // every pre-existing row and there is nothing to reconstruct.
  { table: "job_records", column: "parked_ref", type: "TEXT" },
  { table: "job_records", column: "prepared_sha", type: "TEXT" },
  { table: "job_records", column: "expected_target_sha", type: "TEXT" },
  // Nullable rather than `NOT NULL DEFAULT 0`: a row that predates the column
  // never recorded the decision, and defaulting it to "does not finalize" would
  // manufacture a graph-lane fact for a user-driven merge.
  {
    table: "job_records",
    column: "finalize_session_on_publish",
    type: "INTEGER",
  },
  { table: "job_records", column: "resolution_context", type: "TEXT" },
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
  // Resolved agent-profile snapshot, on both conversation tables. Additive and
  // nullable with no row rewrite: null is the meaningful legacy value (D27), so
  // every pre-feature conversation reads back as no-profile rather than being
  // backfilled with a profile it never ran under.
  // Conversation ownership, on both conversation tables. Additive with no row
  // rewrite: null owner and generation 0 are the meaningful legacy values —
  // nothing that predates the column was ever held by a non-prompt turn, and a
  // generation only has to be monotonic from whenever it starts counting.
  { table: "conversations", column: "conversation_owner", type: "TEXT" },
  {
    table: "conversations",
    column: "turn_generation",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "project_conversations",
    column: "conversation_owner",
    type: "TEXT",
  },
  {
    table: "project_conversations",
    column: "turn_generation",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "conversations", column: "profile_snapshot", type: "TEXT" },
  { table: "conversations", column: "profile_locked_at", type: "TEXT" },
  { table: "project_conversations", column: "profile_snapshot", type: "TEXT" },
  { table: "project_conversations", column: "profile_locked_at", type: "TEXT" },
  {
    table: "spec_revisions",
    column: "authoring_stage",
    type: "TEXT NOT NULL DEFAULT 'plan' CHECK (authoring_stage IN ('requirements', 'design', 'plan'))",
  },
  // The external-delivery claim an imported revision carries. Additive and
  // nullable with no back-fill: every revision this system authored has no such
  // claim, so null is the meaningful legacy value and there is nothing to
  // reconstruct for the rows that predate the column.
  { table: "spec_revisions", column: "external_delivery_json", type: "TEXT" },
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
  {
    table: "spec_executions",
    column: "workflow_seed_source_json",
    type: "TEXT",
  },
  {
    table: "spec_executions",
    column: "workflow_execution_binding_json",
    type: "TEXT",
  },
  // Abandon-coordinator cleanup state (design §10). Additive and nullable: a
  // legacy row has no cleanup in flight, so null is the meaningful value and
  // no backfill is possible or wanted. Widening the `state` CHECK to admit
  // `abandoning` needs a table rebuild instead — migration 0015.
  {
    table: "spec_executions",
    column: "cleanup_phase",
    type: "TEXT CHECK (cleanup_phase IN ('abort_workflow', 'finalize'))",
  },
  {
    table: "spec_executions",
    column: "linked_workflow_execution_id",
    type: "TEXT",
  },
  { table: "spec_executions", column: "cleanup_last_error", type: "TEXT" },
  { table: "spec_executions", column: "cleanup_last_error_at", type: "TEXT" },
  { table: "validation_runs", column: "session_name", type: "TEXT" },
  // The durable prelaunch review record `spec start --park` writes (design
  // §5). Additive and nullable: an attempt that was never parked has no
  // prelaunch record, so null is the meaningful legacy value and there is
  // nothing to backfill.
  {
    table: "spec_delivery_plan_attempts",
    column: "prelaunch_json",
    type: "TEXT",
  },
  {
    table: "validation_runs",
    column: "requested_scope",
    type: "TEXT CHECK (requested_scope IN ('changed', 'full'))",
  },
  {
    table: "validation_runs",
    column: "effective_scope",
    type: "TEXT CHECK (effective_scope IN ('changed', 'full'))",
  },
  {
    table: "conversations",
    column: "name_origin",
    type: "TEXT NOT NULL DEFAULT 'default' CHECK (name_origin IN ('default', 'auto', 'manual'))",
  },
  {
    table: "project_conversations",
    column: "name_origin",
    type: "TEXT NOT NULL DEFAULT 'default' CHECK (name_origin IN ('default', 'auto', 'manual'))",
  },
  // The repository-derived lease projection (D7 decision D15). Present at open
  // time rather than only after migration 0024, because the repository writes
  // it on every setActive. The `1` default is the fail-closed reading of a row
  // no projection has visited yet — it refuses a launch instead of admitting a
  // second Current run — and 0024 replaces it with the classifier's verdict.
  {
    table: "graph_workflow_executions",
    column: "lease_held",
    type: "INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "graph_workflow_result_deliveries",
    column: "effects_delivered_at",
    type: "TEXT",
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

function ensureManagedDeliveryPlanIndexColumns(db: Db): void {
  const columns = [
    {
      table: "spec_delivery_plan_attempts",
      column: "workflow_definition_id",
      type: "TEXT",
    },
    {
      table: "spec_delivery_plan_snapshots",
      column: "workflow_definition_id",
      type: "TEXT",
    },
    {
      table: "spec_delivery_plan_snapshots",
      column: "workflow_definition_revision",
      type: "INTEGER",
    },
    {
      table: "spec_delivery_plan_snapshots",
      column: "workflow_definition_hash",
      type: "TEXT",
    },
    {
      table: "spec_delivery_plan_snapshots",
      column: "binding_hash",
      type: "TEXT",
    },
  ] as const;
  for (const { table, column, type } of columns) {
    if (
      getTableColumns(db, table).length === 0 ||
      columnExists(db, table, column)
    ) {
      continue;
    }
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

function migrateNotificationsTable(db: Db, requireWorkflow = false): void {
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
  const missingWorkflowColumns = [
    "workflow_execution_id",
    "workflow_origin_conversation_id",
    "workflow_deep_link",
  ].some((column) => !columnNames.has(column));
  const jobContextIsStrict = columns.some(
    (column) =>
      ["session_name", "branch_name", "job_id", "job_type"].includes(
        column.name,
      ) && column.notnull === 1,
  );

  if (
    !missingRequiredColumns &&
    !jobContextIsStrict &&
    (!requireWorkflow || !missingWorkflowColumns)
  ) {
    return;
  }

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
      spec_approval_id,
      workflow_execution_id,
      workflow_origin_conversation_id,
      workflow_deep_link
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
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "workflow_execution_id",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "workflow_origin_conversation_id",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "workflow_deep_link",
        "NULL",
      )}
    FROM notifications_legacy_migration;

    DROP TABLE notifications_legacy_migration;
  `);
  db.exec(NOTIFICATIONS_INDEX_DDL);
}

export function migrateNotificationsTableForWorkflowResults(db: Db): void {
  migrateNotificationsTable(db, true);
}

function migrateGraphWorkflowExecutionsSeedProjection(db: Db): void {
  const columns = getTableColumns(db, "graph_workflow_executions");
  const hasRequiredSavedDefinitionProjection = columns.some(
    (column) =>
      (column.name === "seed_definition_id" ||
        column.name === "seed_definition_revision") &&
      column.notnull === 1,
  );
  if (!hasRequiredSavedDefinitionProjection) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_graph_workflow_executions_status;
    ALTER TABLE graph_workflow_executions
      RENAME TO graph_workflow_executions_legacy_seed_projection;

    CREATE TABLE graph_workflow_executions (
      project_path              TEXT NOT NULL,
      session_name              TEXT NOT NULL,
      execution_id              TEXT NOT NULL,
      seed_definition_id        TEXT,
      seed_definition_revision  INTEGER,
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

    INSERT INTO graph_workflow_executions (
      project_path, session_name, execution_id, seed_definition_id,
      seed_definition_revision, started_at, status, completed_at,
      definition_json, runtime_json, updated_at
    ) SELECT
      project_path, session_name, execution_id, seed_definition_id,
      seed_definition_revision, started_at, status, completed_at,
      definition_json, runtime_json, updated_at
    FROM graph_workflow_executions_legacy_seed_projection;

    DROP TABLE graph_workflow_executions_legacy_seed_projection;

    CREATE INDEX idx_graph_workflow_executions_status
      ON graph_workflow_executions(project_path, session_name, status);
  `);
  logger.info("state-store.graph_workflow_execution_seed_projection_relaxed");
}

function specDirectLaunchExecutionNeedsRebuild(db: Db): boolean {
  const executionColumns = getTableColumns(db, "spec_executions");
  return executionColumns.some(
    (column) =>
      column.name === "workflow_definition_id" && column.notnull === 1,
  );
}

function migrateSpecDirectLaunchStorage(db: Db): void {
  const executionNeedsRebuild = specDirectLaunchExecutionNeedsRebuild(db);
  if (executionNeedsRebuild) {
    const before = (
      db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get() as {
        count: number;
      }
    ).count;
    db.exec(`
      DROP TRIGGER IF EXISTS spec_execution_bindings_immutable;
      DROP TABLE IF EXISTS spec_execution_bindings;
      DROP INDEX IF EXISTS idx_spec_executions_spec_state;
      DROP INDEX IF EXISTS uq_spec_executions_workflow_execution;
      ALTER TABLE spec_executions
        RENAME TO spec_executions_legacy_direct_launch;
    `);
    db.exec(SPEC_EXECUTIONS_SCHEMA_DDL);
    db.exec(`
      INSERT INTO spec_executions (
        id, spec_id, revision_id, scope_json, state, cleanup_phase,
        linked_workflow_execution_id, cleanup_last_error,
        cleanup_last_error_at, execution_start_dial,
        workflow_definition_id, workflow_definition_revision,
        workflow_seed_source_json, workflow_execution_binding_json,
        workflow_execution_id, session_name,
        delivered_at, abandoned_reason, created_at, updated_at
      ) SELECT
        id, spec_id, revision_id, scope_json, state, cleanup_phase,
        linked_workflow_execution_id, cleanup_last_error,
        cleanup_last_error_at, execution_start_dial,
        workflow_definition_id, workflow_definition_revision,
        workflow_seed_source_json, workflow_execution_binding_json,
        workflow_execution_id, session_name,
        delivered_at, abandoned_reason, created_at, updated_at
      FROM spec_executions_legacy_direct_launch;
    `);
    const after = (
      db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get() as {
        count: number;
      }
    ).count;
    if (after !== before) {
      throw new Error(
        `Direct-launch storage rebuild copied ${after} of ${before} spec_executions rows; refusing to drop the original`,
      );
    }
    db.exec("DROP TABLE spec_executions_legacy_direct_launch;");
    db.exec(SPEC_EXECUTION_BINDINGS_SCHEMA_DDL);
  }

  const snapshotColumns = getTableColumns(db, "spec_delivery_plan_snapshots");
  const snapshotNeedsRebuild = snapshotColumns.some(
    (column) =>
      column.name === "plan_hash" ||
      ((column.name === "candidate_id" || column.name === "candidate_hash") &&
        column.notnull === 0),
  );
  const legacyCandidateTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_candidates'",
    )
    .get();
  if (!snapshotNeedsRebuild && legacyCandidateTable === undefined) {
    if (executionNeedsRebuild) {
      logger.info("state-store.spec_direct_launch_storage_rebuilt", {
        executionsRebuilt: true,
        snapshotsRebuilt: false,
        discardedSnapshots: 0,
      });
    }
    return;
  }

  // A snapshot without a finalized candidate identity is a pre-version-2
  // proposal. Version 2 has no reader for it, so the rebuild discards the
  // snapshot and returns its attempt to draft rather than leaving an approval
  // pointing at bytes nothing can parse.
  const discardedSnapshots = snapshotNeedsRebuild
    ? (db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM spec_delivery_plan_snapshots
            WHERE candidate_id IS NULL OR candidate_hash IS NULL`,
        )
        .get() as { count: number })
    : { count: 0 };
  db.exec("DROP INDEX IF EXISTS idx_spec_delivery_plan_candidates_attempt;");
  db.exec("DROP TABLE IF EXISTS spec_delivery_plan_candidates;");
  if (snapshotNeedsRebuild) {
    db.exec(`
      UPDATE spec_delivery_plan_attempts
         SET status = 'draft',
             proposed_snapshot_id = NULL,
             approval_json = NULL,
             prelaunch_json = NULL,
             updated_at = datetime('now')
       WHERE id IN (
         SELECT attempt_id
           FROM spec_delivery_plan_snapshots
          WHERE candidate_id IS NULL OR candidate_hash IS NULL
       )
         AND status IN ('proposed', 'approved', 'parked');

      DELETE FROM spec_delivery_plan_snapshots
       WHERE candidate_id IS NULL OR candidate_hash IS NULL;

      DROP INDEX IF EXISTS idx_spec_delivery_plan_snapshots_attempt;
      ALTER TABLE spec_delivery_plan_snapshots
        RENAME TO spec_delivery_plan_snapshots_legacy_direct_launch;
    `);
    db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
    db.exec(`
      INSERT INTO spec_delivery_plan_snapshots (
        id, attempt_id, candidate_id, candidate_hash, draft_revision,
        content_json, pinned_revision_id, proposed_at, proposed_by_json
      ) SELECT
        id, attempt_id, candidate_id, candidate_hash, draft_revision,
        content_json, pinned_revision_id, proposed_at, proposed_by_json
      FROM spec_delivery_plan_snapshots_legacy_direct_launch;

      DROP TABLE spec_delivery_plan_snapshots_legacy_direct_launch;
    `);
  }
  logger.info("state-store.spec_direct_launch_storage_rebuilt", {
    executionsRebuilt: executionNeedsRebuild,
    snapshotsRebuilt: snapshotNeedsRebuild,
    discardedSnapshots: discardedSnapshots.count,
  });
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
  if (
    columnExists(db, "spec_revisions", "content_hash") &&
    !columnExists(db, "spec_revisions", "citation_contract_version")
  ) {
    const startedAt = Date.now();
    if (dbPath !== ":memory:") {
      publishSchemaCompatibilityBarrierSync(
        path.dirname(dbPath),
        NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
      );
    }
    const result = applyNativeSddAttentionCitationsSchema(db);
    logger.info("state-store.attention_citations_floor_complete", {
      ...result,
      durationMs: Date.now() - startedAt,
    });
  }
  // The schema floor creates indexes over the managed-definition columns.
  // Existing delivery-plan tables need those additive columns before SQLite
  // can evaluate the `CREATE INDEX IF NOT EXISTS` statements in SCHEMA_DDL.
  ensureManagedDeliveryPlanIndexColumns(db);
  db.exec(SCHEMA_DDL);
  migrateNotificationsTable(db);
  db.exec(NOTIFICATIONS_INDEX_DDL);
  // The seed-projection relaxation rebuilds graph_workflow_executions without
  // the additive columns, so it must run before ensureAdditiveColumns restores
  // them; the direct-launch rebuild runs after, against the settled shape.
  migrateGraphWorkflowExecutionsSeedProjection(db);
  ensureAdditiveColumns(db);
  // Names an additive column, so it cannot sit in SCHEMA_DDL above.
  db.exec(MEMORY_LINKS_IDENTITY_INDEX_DDL);
  migrateSpecDirectLaunchStorage(db);
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
    const executionNeedsDirectLaunchRebuild =
      specDirectLaunchExecutionNeedsRebuild(db);
    const foreignKeysEnabled =
      db.pragma("foreign_keys", { simple: true }) === 1;
    const legacyAlterTableEnabled =
      db.pragma("legacy_alter_table", { simple: true }) === 1;

    // `spec_executions` is a foreign-key parent. SQLite would otherwise
    // rewrite every child reference to the temporary legacy table during the
    // rename, then refuse or cascade those rows when that table is dropped.
    // These connection pragmas are no-ops inside a transaction, so apply them
    // around the locked initialization window and restore the caller's state.
    if (executionNeedsDirectLaunchRebuild) {
      if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
      if (!legacyAlterTableEnabled) db.pragma("legacy_alter_table = ON");
    }
    // Hold the write lock from the second version check through schema setup,
    // so a concurrently starting newer build cannot advance the compatibility
    // version between the gate and this build's DDL/data migrations.
    const initialize = db.transaction(() => initializeSchema(db, dbPath));
    try {
      initialize.immediate();
    } finally {
      if (executionNeedsDirectLaunchRebuild) {
        if (!legacyAlterTableEnabled) db.pragma("legacy_alter_table = OFF");
        if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
      }
    }
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
/**
 * The shadow tables SQLite creates for a virtual table (`memory_notes_fts_data`
 * and friends). They appear in `sqlite_master` as ordinary tables but refuse
 * direct modification in better-sqlite3's defensive mode, and emptying them
 * would corrupt the index the virtual table owns. Deleting from the VIRTUAL
 * table clears its content properly, so the reset drops the shadows and keeps
 * the parent.
 *
 * `PRAGMA table_list` is the classification SQLite itself publishes, which
 * beats guessing at name prefixes.
 */
function shadowTableNames(db: Db): Set<string> {
  const names = new Set<string>();
  for (const row of db.pragma("table_list") as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as { name?: unknown; type?: unknown; schema?: unknown };
    if (entry.schema !== "main" || entry.type !== "shadow") continue;
    if (typeof entry.name === "string") names.add(entry.name);
  }
  return names;
}

export function truncateAllTables(db: Db): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const shadowTables = shadowTableNames(db);
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
    if (shadowTables.has(name)) {
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
