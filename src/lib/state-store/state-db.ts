import Database from "better-sqlite3";
import { SUPERVISION_SCHEMA_DDL } from "./supervision-schema";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigDirPath } from "../config/loader";
import { createLogger } from "@/lib/logging";
import {
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "../shared/global-singleton";
import { resetInstalledStateDbForTesting } from "./reset-installed-state-db";
import { STATE_DB_GLOBAL_KEY } from "./state-db-global-key";
import {
  classifyMigrationHistory,
  stampRetiredMigrationHistory,
} from "./migration-history";
import {
  enforceCurrentSchemaCompatibility,
  enforceSchemaCompatibilityBarrier,
} from "./schema-compatibility";

const logger = createLogger("state-store/state-db");

type Db = InstanceType<typeof Database>;

const GLOBAL_KEY = STATE_DB_GLOBAL_KEY;
const DB_FILE_NAME = "command-center.db";

export const KNOWN_SCHEMA_VERSION = 30;

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

export const SPEC_GATE_ADMISSIONS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS spec_gate_admissions (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    gate          TEXT NOT NULL CHECK (gate IN (
      'requirements', 'design', 'plan'
    )),
    basis         TEXT NOT NULL CHECK (basis IN (
      'human_approval', 'notify_policy', 'off_policy', 'import'
    )),
    approval_id   TEXT,
    revision_id   TEXT,
    actor_json    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (approval_id) REFERENCES spec_approvals(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id)
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
      'draft', 'approved', 'withdrawn'
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
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (id, spec_id),
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
    -- Added after the table shipped, so it also appears in ADDITIVE_COLUMNS.
    subject_fingerprint_json TEXT,
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

export const RUNTIME_OWNER_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS graph_workflow_runtime_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL,
    token TEXT NOT NULL
  );


  -- Every pending-artifact read is scoped by the full project/session/execution
  -- triple, so a same-id record from another session cannot reach a retry.
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
 * Purely additive, so no KNOWN_SCHEMA_VERSION bump: an older build sharing
 * `command-center.db` simply ignores tables it has no reader for.
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
    end_line               INTEGER,
    end_section_id         TEXT,
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
    observed_comment_ids_json TEXT,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (conversation_id, notepad_id),
    FOREIGN KEY (notepad_id) REFERENCES notepads(id) ON DELETE CASCADE
  );
`;

/** Subscription evidence survives source deletion and recipient retirement. */
export const CONVERSATION_SUBSCRIPTIONS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS conversation_subscriptions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('notepad','ticket','spec','validation','git_job','conversation','run')),
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('passive','active')),
    wakes INTEGER NOT NULL DEFAULT 0 CHECK (wakes IN (0,1)),
    event_kinds_json TEXT,
    expires_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('following','unfollowed')),
    cursor TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    unfollowed_at TEXT,
    paused_at TEXT,
    missing_at TEXT,
    last_error TEXT,
    UNIQUE (project_path, conversation_id, source_kind, source_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_subscription_deliveries (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('notepad','ticket','spec','validation','git_job','conversation','run')),
    source_id TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    fact_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','queued','accepted','failed','uncertain','superseded')),
    attempt_id TEXT,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    queued_at TEXT,
    accepted_at TEXT,
    finished_at TEXT,
    last_error TEXT,
    UNIQUE (project_path, conversation_id, source_kind, source_id, occurrence_id)
  );
  CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_inbox
    ON conversation_subscription_deliveries (project_path, conversation_id, state, recorded_at, id);
  CREATE TABLE IF NOT EXISTS ticket_status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_conversation_id TEXT,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_status_changes_ticket
    ON ticket_status_changes (ticket_id, id);
`;

export const CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS conversation_subscription_preferences (
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    hints_enabled INTEGER NOT NULL CHECK (hints_enabled IN (0,1)),
    PRIMARY KEY (project_path,conversation_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_subscription_read_state (
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (project_path,conversation_id,delivery_id)
  );
`;

export const CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS conversation_subscription_waits (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting','ready','settled','cancelled')),
    expires_at TEXT NOT NULL,
    delivery_id TEXT,
    batch_id TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_waits_one_live
    ON conversation_subscription_waits(subscription_id) WHERE state IN ('waiting','ready');
  CREATE INDEX IF NOT EXISTS idx_subscription_waits_recipient
    ON conversation_subscription_waits (project_path,conversation_id,state);
  CREATE TABLE IF NOT EXISTS conversation_subscription_wake_batches (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('planned','queued','accepted','failed','uncertain','cancelled')),
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_wake_one_pending
    ON conversation_subscription_wake_batches (project_path,conversation_id)
    WHERE state IN ('planned','queued','failed','uncertain');
  CREATE INDEX IF NOT EXISTS idx_subscription_wake_rate
    ON conversation_subscription_wake_batches (project_path,conversation_id,created_at);
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
 * Purely additive, so no KNOWN_SCHEMA_VERSION bump: an older build sharing
 * `command-center.db` simply ignores tables it has no reader for.
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
 * Purely additive, so no KNOWN_SCHEMA_VERSION bump: an older build sharing
 * `command-center.db` simply ignores tables it has no reader for.
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

/**
 * Durable checkpoint operations and their immutable payloads.
 *
 * Two tables rather than one because they have different write rules: the
 * operation row is mutated through validated transitions for the life of the
 * conversation, while the payload is inserted exactly once and never updated.
 * Splitting them lets the BEFORE UPDATE trigger below make immutability a
 * property of the schema instead of a convention every future caller must keep.
 *
 * **No FK to a conversation.** Conversations live in two tables
 * (`conversations` at session scope, `project_conversations` at project scope),
 * so one FK target does not exist — the same two-parent shape as
 * `conversation_machine_snapshots`, and cleanup uses that table's proven owner:
 * AFTER DELETE triggers on both parents, which fire for direct deletes and FK
 * cascade deletes alike.
 *
 * `session_name` is NULL at project scope rather than the internal sentinel, so
 * no read of this table can hand a sentinel-valued session name to a log field
 * or a projection.
 *
 * Unlike the other additive tables here, this one DOES carry a
 * KNOWN_SCHEMA_VERSION bump (15, migration
 * `0044-add-conversation-checkpoints`). Ignoring a table it has no reader for
 * is not harmless in this case: an older build sees a conversation mid-
 * retirement as an ordinary idle one, admits a turn, and mints a provider
 * reference the frozen seed can never be delivered into.
 */
export const CONVERSATION_CHECKPOINTS_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS conversation_checkpoint_operations (
    -- The caller's request UUID, the operation id, and the payload id are one
    -- value: reusing a request id is therefore a primary-key hit, which is what
    -- makes idempotent admission a property of the schema.
    id                          TEXT PRIMARY KEY,
    scope                       TEXT NOT NULL CHECK (scope IN ('session', 'project')),
    project_path                TEXT NOT NULL,
    session_name                TEXT,
    conversation_id             TEXT NOT NULL,
    ordinal                     INTEGER NOT NULL CHECK (ordinal > 0),
    phase                       TEXT NOT NULL CHECK (phase IN (
      'building', 'retiring', 'ready', 'delivering', 'applied',
      'failed', 'cancelled', 'needs_reconciliation'
    )),
    last_stable_phase           TEXT,
    -- The captured source boundary is written with the building row, so both
    -- columns are load-bearing from the first insert.
    captured_through_seq        INTEGER NOT NULL,
    source_hash                 TEXT NOT NULL,
    -- Protected provider references. Never selected into a receipt, a list
    -- projection, or a log field.
    prior_backend_ref           TEXT,
    accepted_backend_ref        TEXT,
    payload_id                  TEXT,
    delivery_attempt_id         TEXT,
    delivery_input_fingerprint  TEXT,
    -- Added after the table shipped, so it also appears in ADDITIVE_COLUMNS.
    delivery_submitted_input_fingerprint TEXT,
    queued_delivery_attempt_id  TEXT,
    queued_delivery_message_id  TEXT,
    accepted_attempt_id         TEXT,
    accepted_seed_hash          TEXT,
    accepted_at                 TEXT,
    failure_code                TEXT,
    failure_message             TEXT,
    recovers_operation_id       TEXT,
    superseded_by_operation_id  TEXT,
    generation_pass_count       INTEGER,
    handoff_json                TEXT,
    -- Measured usage stays nullable in every column: a backend that does not
    -- report a counter leaves it unavailable, which is not zero.
    usage_input_tokens          INTEGER,
    -- Added after the table shipped, so it also appears in ADDITIVE_COLUMNS.
    -- Kept beside fresh input rather than summed into it: the providers bill
    -- them differently, so one column cannot honestly carry both.
    usage_cached_input_tokens   INTEGER,
    usage_output_tokens         INTEGER,
    usage_cost_usd              REAL,
    usage_duration_ms           INTEGER,
    requested_at                TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    -- A session-scoped operation names its session; a project-scoped one has
    -- no session to name.
    CHECK (
      (scope = 'session' AND session_name IS NOT NULL)
      OR (scope = 'project' AND session_name IS NULL)
    )
    -- The two linkage columns name rows in this same table and are deliberately
    -- FK-free. Superseding writes the link and the linked row in one
    -- transaction, so a self-FK would only force an ordering that the partial
    -- unique index below already forbids; and the cleanup triggers drop a
    -- conversation's operations together, so a dangling link cannot outlive
    -- its target.
  );

  -- One conversation holds at most one checkpoint slot. A superseded operation
  -- is excluded rather than moved to a terminal phase: recovery needs to admit
  -- its build while the blocked operation still records WHY it was blocked, and
  -- restoring the gate after a failed recovery is then the removal of a link
  -- rather than a backward edge out of a terminal phase.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_checkpoint_active
    ON conversation_checkpoint_operations (scope, conversation_id)
    WHERE phase IN ('building', 'retiring', 'ready', 'delivering', 'needs_reconciliation')
      AND superseded_by_operation_id IS NULL;

  -- Ordinals are allocated per conversation, so the uniqueness that makes
  -- MAX(ordinal) + 1 safe has to be scoped the same way.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_checkpoint_ordinal
    ON conversation_checkpoint_operations (scope, conversation_id, ordinal);

  -- The list read: one conversation's receipts, newest first.
  CREATE INDEX IF NOT EXISTS idx_conversation_checkpoint_operations_conversation
    ON conversation_checkpoint_operations (scope, conversation_id, ordinal DESC);

  CREATE TABLE IF NOT EXISTS conversation_checkpoints (
    -- Equal to the owning operation's id.
    id                     TEXT PRIMARY KEY,
    schema_version         INTEGER NOT NULL,
    captured_through_seq   INTEGER NOT NULL,
    source_hash            TEXT NOT NULL,
    source_artifact_id     TEXT,
    source_artifact_hash   TEXT,
    generator_version      TEXT NOT NULL,
    builder_version        TEXT NOT NULL,
    normalizer_version     TEXT NOT NULL,
    model_selection_json   TEXT NOT NULL CHECK (json_valid(model_selection_json)),
    sections_json          TEXT NOT NULL CHECK (json_valid(sections_json)),
    -- The exact string injected into the next turn's prompt context.
    seed_text              TEXT NOT NULL,
    seed_sha256            TEXT NOT NULL,
    section_bytes_json     TEXT NOT NULL CHECK (json_valid(section_bytes_json)),
    omissions_json         TEXT NOT NULL CHECK (json_valid(omissions_json)),
    generation_pass_count  INTEGER NOT NULL,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (id) REFERENCES conversation_checkpoint_operations(id)
      ON DELETE CASCADE
  );

  -- Immutability as a schema property. A frozen payload is the evidence a
  -- retired runtime cannot be recovered from anywhere else, so "no update API"
  -- is not enough: a later package, a migration, or an artifact refresh reaching
  -- this table aborts instead of rewriting a byte.
  CREATE TRIGGER IF NOT EXISTS conversation_checkpoints_immutable
  BEFORE UPDATE ON conversation_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'conversation checkpoints are immutable');
  END;

  -- DB-enforced retention: a checkpoint record outlives compaction and
  -- archiving (both are ordinary row updates) but never its owning
  -- conversation. Four explicit deletion callers reach these rows: conversation
  -- delete, session delete, fused session delete, and project delete. Only the
  -- first removes a conversation row directly; the other three arrive by FK
  -- CASCADE. AFTER DELETE triggers fire for both kinds, inside the deleting
  -- transaction, so one owner covers every path and a fifth caller cannot
  -- forget. The payload row follows by its own FK CASCADE.
  CREATE TRIGGER IF NOT EXISTS trg_conversation_checkpoints_session_cleanup
    AFTER DELETE ON conversations
  BEGIN
    DELETE FROM conversation_checkpoint_operations
      WHERE scope = 'session' AND conversation_id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_conversation_checkpoints_project_cleanup
    AFTER DELETE ON project_conversations
  BEGIN
    DELETE FROM conversation_checkpoint_operations
      WHERE scope = 'project' AND conversation_id = OLD.id;
  END;
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
    checkpoint_fork       TEXT,
    role                  TEXT,
    context_tokens        INTEGER,
    context_window_max    INTEGER,
    debug_mode            TEXT,
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
    checkpoint_fork       TEXT,
    role                  TEXT,
    context_tokens        INTEGER,
    context_window_max    INTEGER,
    debug_mode            TEXT,
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


  -- DB-enforced sidecar cleanup. The sidecar's owner discriminator ties one
  -- table to two possible parents (conversations / project_conversations), which
  -- a single foreign key cannot express — so a parent row dying by FK CASCADE
  -- (deleting a session removes its conversations; deleting a project removes
  -- both its sessions' conversations and its project conversations) would leave
  -- the sidecar orphaned. These AFTER DELETE triggers fire for BOTH direct
  -- deletes and FK cascade deletes, within the same transaction as the parent
  -- delete, so a sidecar row can never outlive its owning conversation.


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
    end_line      INTEGER,
    end_section_id TEXT,
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

  ${NOTIFICATIONS_INDEX_DDL}

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
    parked_ref     TEXT,
    prepared_sha   TEXT,
    expected_target_sha TEXT,
    finalize_session_on_publish INTEGER,
    resolution_context TEXT,
    skip_mark_merged INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_job_records_status ON job_records(status);









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

  CREATE TABLE IF NOT EXISTS ticket_bundle_imports (
    ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    source_ticket_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_bundle_imports_source
    ON ticket_bundle_imports(source_ticket_id);

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




  ${RUNTIME_OWNER_SCHEMA_DDL}


  ${SUPERVISION_SCHEMA_DDL}

  ${NOTEPADS_SCHEMA_DDL}

  ${NOTEPAD_COMMENTS_SCHEMA_DDL}

  ${NOTEPAD_DELIVERY_WATERMARKS_SCHEMA_DDL}
  ${CONVERSATION_SUBSCRIPTIONS_SCHEMA_DDL}
  ${CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_DDL}
  ${CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_DDL}

  ${MEMORY_SCHEMA_DDL}

  ${MEMORY_SEARCH_SCHEMA_DDL}

  ${MEMORY_TELEMETRY_SCHEMA_DDL}

  ${CONVERSATION_CHECKPOINTS_SCHEMA_DDL}
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
  { table: "conversation_subscriptions", column: "paused_at", type: "TEXT" },
  {
    table: "conversation_checkpoint_operations",
    column: "handoff_json",
    type: "TEXT",
  },
  { table: "document_comments", column: "end_line", type: "INTEGER" },
  {
    table: "spec_approvals",
    column: "subject_fingerprint_json",
    type: "TEXT",
  },
  { table: "document_comments", column: "end_section_id", type: "TEXT" },
  { table: "notepad_comments", column: "end_line", type: "INTEGER" },
  { table: "notepad_comments", column: "end_section_id", type: "TEXT" },
  { table: "conversations", column: "pending_prompt_text", type: "TEXT" },
  { table: "conversations", column: "checkpoint_fork", type: "TEXT" },
  { table: "project_conversations", column: "checkpoint_fork", type: "TEXT" },
  {
    table: "conversation_checkpoint_operations",
    column: "delivery_submitted_input_fingerprint",
    type: "TEXT",
  },
  {
    table: "conversation_checkpoint_operations",
    column: "usage_cached_input_tokens",
    type: "INTEGER",
  },
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
  // A run's template origin. Additive and nullable with no schema version bump:
  // a build without it names its columns and keeps reading and writing runs.
  { table: "runs", column: "origin_json", type: "TEXT" },
  // Nullable here on purpose even though the floor declares them NOT NULL: an
  // older database reaches `migrateSpecDirectLaunchStorage` through this
  // back-fill, and that rebuild needs both columns to exist before it can
  // separate finalized snapshots from pre-version-2 ones it must discard.

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
  { table: "job_records", column: "skip_mark_merged", type: "INTEGER" },
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

  // Abandon-coordinator cleanup state (design §10). Additive and nullable: a
  // legacy row has no cleanup in flight, so null is the meaningful value and
  // no backfill is possible or wanted. Widening the `state` CHECK to admit
  // `abandoning` needs a table rebuild instead — migration 0015.

  { table: "validation_runs", column: "session_name", type: "TEXT" },
  // The durable prelaunch review record `spec start --park` writes (design
  // §5). Additive and nullable: an attempt that was never parked has no
  // prelaunch record, so null is the meaningful legacy value and there is
  // nothing to backfill.

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
    table: "notepad_delivery_watermarks",
    column: "observed_comment_ids_json",
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

function initializeSchema(db: Db, dbPath: string): void {
  enforceCurrentSchemaCompatibility(db, dbPath, KNOWN_SCHEMA_VERSION);
  // Before any write: a database that has not finished the retired history is
  // refused whole, so this build never builds its floor over a shape it has no
  // code to finish.
  const history = classifyMigrationHistory(db);
  db.exec(SCHEMA_DDL);
  ensureAdditiveColumns(db);
  // Names an additive column, so it cannot sit in SCHEMA_DDL above.
  db.exec(MEMORY_LINKS_IDENTITY_INDEX_DDL);
  if (history === "fresh") stampRetiredMigrationHistory(db);
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
    // version between the gate and this build's schema floor.
    db.transaction(() => initializeSchema(db, dbPath)).immediate();
    // `journal_mode` changes persistent database state and SQLite does not
    // permit changing it inside a transaction. Apply it only after the locked
    // compatibility recheck and schema initialization succeed.
    applyJournalMode(db);
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
  resetInstalledStateDbForTesting();
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
 * Bookkeeping tables excluded from {@link truncateAllTables}: the version table
 * keeps the forward-only version check passing after a reset, and the migration
 * ledger keeps the retired-history guard from refusing the reset database.
 */
const BOOKKEEPING_TABLES = new Set(["schema_migrations", "applied_migrations"]);

/**
 * Test helper: empty every application data table, deriving the table set from
 * the live schema (`sqlite_master`) so a newly added table is cleared with no
 * code change. Excludes SQLite internals (`sqlite_%`) and the bookkeeping
 * tables, so the reset database reopens.
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
    if (name.startsWith("sqlite_") || BOOKKEEPING_TABLES.has(name)) {
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
