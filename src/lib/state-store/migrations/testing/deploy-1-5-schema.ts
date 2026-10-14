/**
 * The schema of a fresh overhaul-deploy-1.5 database (`f441c64c3`): every
 * `sqlite_master` statement its schema floor and startup migrations create, in
 * creation order, without SQLite internals or FTS shadow tables. Frozen: it
 * stands for the databases that build left behind and never follows the live
 * floor. It is a module rather than a `.sql` file so the tests that build on
 * it read it through their import graph.
 */
export const DEPLOY_1_5_SCHEMA_SQL = `
CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE applied_data_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE applied_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE projects (
    root_path                  TEXT PRIMARY KEY,
    archived                   INTEGER NOT NULL DEFAULT 0,
    pinned                     INTEGER NOT NULL DEFAULT 0,
    pin_order                  INTEGER,
    mcp_overrides              TEXT,
    agent_capability_overrides TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE INDEX idx_projects_archived ON projects(archived);

CREATE INDEX idx_projects_pinned ON projects(pinned, pin_order);

CREATE TABLE sessions (
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

CREATE INDEX idx_sessions_project ON sessions(project_path);

CREATE INDEX idx_sessions_archived ON sessions(archived);

CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);

CREATE TABLE conversations (
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
    turn_generation       INTEGER NOT NULL DEFAULT 0, last_seen_alignment_version INTEGER, pending_agent_notices TEXT, profile_snapshot TEXT, profile_locked_at TEXT,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

CREATE INDEX idx_conversations_session
    ON conversations(project_path, session_name);

CREATE INDEX idx_conversations_last_activity
    ON conversations(last_activity_at);

CREATE TABLE project_conversations (
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
    turn_generation       INTEGER NOT NULL DEFAULT 0, profile_snapshot TEXT, profile_locked_at TEXT,
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

CREATE INDEX idx_project_conversations_project
    ON project_conversations(project_path);

CREATE INDEX idx_project_conversations_last_activity
    ON project_conversations(last_activity_at);

CREATE TABLE conversation_machine_snapshots (
    owner           TEXT NOT NULL CHECK (owner IN ('session', 'project')),
    conversation_id TEXT NOT NULL,
    snapshot_json   TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (owner, conversation_id)
  );

CREATE TRIGGER trg_conversation_machine_snapshots_session_cleanup
    AFTER DELETE ON conversations
  BEGIN
    DELETE FROM conversation_machine_snapshots
      WHERE owner = 'session' AND conversation_id = OLD.id;
  END;

CREATE TRIGGER trg_conversation_machine_snapshots_project_cleanup
    AFTER DELETE ON project_conversations
  BEGIN
    DELETE FROM conversation_machine_snapshots
      WHERE owner = 'project' AND conversation_id = OLD.id;
  END;

CREATE TABLE reference_documents (
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

CREATE TABLE session_markdown_documents (
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

CREATE INDEX idx_session_markdown_documents_recent
    ON session_markdown_documents (
      project_path,
      session_name,
      last_seen_at DESC,
      doc_path ASC
    );

CREATE TABLE document_comments (
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

CREATE INDEX idx_document_comments_doc
    ON document_comments (project_path, session_name, doc_path);

CREATE TABLE notifications (
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

CREATE TABLE job_records (
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
    spec_execution_id TEXT,
    final_publish  INTEGER NOT NULL DEFAULT 0,
    candidate_validation TEXT,
    parked_ref     TEXT,
    prepared_sha   TEXT,
    expected_target_sha TEXT,
    finalize_session_on_publish INTEGER,
    resolution_context TEXT,
    skip_mark_merged INTEGER
  );

CREATE INDEX idx_job_records_status ON job_records(status);

CREATE TABLE agent_run_records (
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

CREATE INDEX idx_agent_run_records_session
    ON agent_run_records(project_name, session_name);

CREATE TABLE graph_workflow_events (
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

CREATE INDEX idx_graph_workflow_events_scope_execution
    ON graph_workflow_events(project_path, session_name, execution_id, id);

CREATE INDEX idx_graph_workflow_events_scope_context
    ON graph_workflow_events(
      project_path, session_name, execution_id, context_id, event_type, id
    );

CREATE TABLE graph_workflow_archived_executions (
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

CREATE INDEX idx_graph_workflow_archived_executions_session
    ON graph_workflow_archived_executions(project_path, session_name, archived_at);

CREATE TABLE session_alignment_versions (
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

CREATE INDEX idx_session_alignment_versions_status
    ON session_alignment_versions(project_path, session_name, status);

CREATE TABLE session_alignment_decisions (
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

CREATE INDEX idx_session_alignment_decisions_approved_at
    ON session_alignment_decisions(project_path, session_name, approved_at);

CREATE TABLE session_alignment_decision_proposals (
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

CREATE INDEX idx_session_alignment_decision_proposals_batch
    ON session_alignment_decision_proposals(project_path, session_name, batch_id);

CREATE TABLE merge_intents (
    project_path TEXT NOT NULL,
    commit_sha   TEXT NOT NULL,
    intent       TEXT NOT NULL,
    source       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (project_path, commit_sha)
  );

CREATE TABLE context_artifacts (
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

CREATE INDEX idx_context_artifacts_conversation
    ON context_artifacts (conversation_id, kind);

CREATE INDEX idx_context_artifacts_scope
    ON context_artifacts (project_path, session_name);

CREATE UNIQUE INDEX uq_context_artifacts_conversation_kind
    ON context_artifacts (conversation_id) WHERE kind = 'conversation_compaction';

CREATE UNIQUE INDEX uq_context_artifacts_message
    ON context_artifacts (conversation_id, message_index) WHERE kind = 'message_compaction';

CREATE TABLE ticket_counters (
    project_path TEXT PRIMARY KEY,
    last_number  INTEGER NOT NULL CHECK (last_number >= 0)
  );

CREATE TABLE tickets (
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

CREATE INDEX idx_tickets_project_updated
    ON tickets (project_path, updated_at DESC);

CREATE INDEX idx_tickets_status_updated
    ON tickets (status, updated_at DESC);

CREATE INDEX idx_tickets_project_status_type_updated
    ON tickets (project_path, status, work_type, updated_at DESC);

CREATE TABLE ticket_bundle_imports (
    ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    source_ticket_id TEXT NOT NULL
  );

CREATE INDEX idx_ticket_bundle_imports_source
    ON ticket_bundle_imports(source_ticket_id);

CREATE TABLE ticket_attachments (
    id           TEXT PRIMARY KEY,
    ticket_id    TEXT NOT NULL,
    description  TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

CREATE INDEX idx_ticket_attachments_ticket_created
    ON ticket_attachments (ticket_id, created_at);

CREATE TABLE ticket_sessions (
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

CREATE UNIQUE INDEX uq_ticket_sessions_active_ticket
    ON ticket_sessions (ticket_id) WHERE ended_at IS NULL;

CREATE UNIQUE INDEX uq_ticket_sessions_active_session
    ON ticket_sessions (project_path, session_name) WHERE ended_at IS NULL;

CREATE INDEX idx_ticket_sessions_ticket_linked
    ON ticket_sessions (ticket_id, linked_at);

CREATE INDEX idx_ticket_sessions_project_session
    ON ticket_sessions (project_path, session_name);

CREATE TABLE ticket_relationships (
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

CREATE INDEX idx_ticket_relationships_source_updated
    ON ticket_relationships (source_ticket_id, updated_at DESC, id DESC);

CREATE INDEX idx_ticket_relationships_target_updated
    ON ticket_relationships (target_ticket_id, updated_at DESC, id DESC);

CREATE UNIQUE INDEX uq_ticket_relationships_parent_child_target
    ON ticket_relationships (target_ticket_id)
    WHERE relation_type = 'parent_child';

CREATE TABLE ticket_status_updates (
    id            TEXT PRIMARY KEY,
    ticket_id     TEXT NOT NULL,
    body_markdown TEXT NOT NULL CHECK (length(trim(body_markdown)) > 0),
    author_json   TEXT NOT NULL CHECK (json_valid(author_json)),
    created_at    TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

CREATE INDEX idx_ticket_status_updates_ticket_created
    ON ticket_status_updates (ticket_id, created_at DESC, id DESC);

CREATE TABLE ticket_relationship_legacy_aliases (
    legacy_attachment_id TEXT PRIMARY KEY,
    relationship_id      TEXT NOT NULL,
    anchor_ticket_id     TEXT NOT NULL,
    FOREIGN KEY (relationship_id)
      REFERENCES ticket_relationships(id) ON DELETE CASCADE,
    FOREIGN KEY (anchor_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

CREATE INDEX idx_ticket_relationship_legacy_aliases_anchor_relationship
    ON ticket_relationship_legacy_aliases (anchor_ticket_id, relationship_id);

CREATE TABLE validation_runs (
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

CREATE INDEX idx_validation_runs_status_queue
    ON validation_runs (status, queue_order);

CREATE INDEX idx_validation_runs_project_command
    ON validation_runs (project_path, command_name);

CREATE TABLE specs (
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

CREATE INDEX idx_specs_project_updated
    ON specs (project_path, updated_at DESC);

CREATE TABLE spec_aliases (
    project_path  TEXT NOT NULL,
    slug          TEXT NOT NULL,
    spec_id       TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_path, slug),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

CREATE INDEX idx_spec_aliases_spec
    ON spec_aliases (spec_id);

CREATE TABLE spec_counters (
    spec_id      TEXT NOT NULL,
    scope_key    TEXT NOT NULL CHECK (
      scope_key IN ('R', 'D', 'T', 'Q', 'A') OR scope_key GLOB 'C:?*'
    ),
    last_number  INTEGER NOT NULL CHECK (last_number >= 0),
    PRIMARY KEY (spec_id, scope_key),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

CREATE TABLE spec_elements (
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

CREATE INDEX idx_spec_elements_spec_kind_number
    ON spec_elements (spec_id, kind, number);

CREATE INDEX idx_spec_elements_parent
    ON spec_elements (parent_element_id);

CREATE TABLE spec_revisions (
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
    external_delivery_json TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (id, spec_id),
    UNIQUE (spec_id, number),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (based_on_revision_id) REFERENCES spec_revisions(id)
  );

CREATE INDEX idx_spec_revisions_spec_state
    ON spec_revisions (spec_id, state, number DESC);

CREATE TABLE spec_element_versions (
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

CREATE INDEX idx_spec_element_versions_element
    ON spec_element_versions (element_id, revision_id);

CREATE INDEX idx_spec_element_versions_order
    ON spec_element_versions (revision_id, position);

CREATE TABLE spec_executions (
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
    delivery_basis_json TEXT,
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

CREATE INDEX idx_spec_executions_spec_state
    ON spec_executions (spec_id, state, created_at DESC);

CREATE UNIQUE INDEX uq_spec_executions_workflow_execution
    ON spec_executions (workflow_execution_id)
    WHERE workflow_execution_id IS NOT NULL;

CREATE TABLE spec_execution_bindings (
    spec_execution_id      TEXT PRIMARY KEY,
    workflow_execution_id  TEXT NOT NULL UNIQUE,
    binding_json           TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (spec_execution_id) REFERENCES spec_executions(id)
      ON DELETE CASCADE
  );

CREATE TRIGGER spec_execution_bindings_immutable
  BEFORE UPDATE ON spec_execution_bindings
  BEGIN
    SELECT RAISE(ABORT, 'spec execution bindings are immutable');
  END;

CREATE TABLE spec_approvals (
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

CREATE INDEX idx_spec_approvals_revision_validity
    ON spec_approvals (spec_id, revision_id, validity);

CREATE INDEX idx_spec_approvals_subject
    ON spec_approvals (spec_id, subject_kind, element_id);

CREATE TABLE spec_gate_admissions (
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

CREATE INDEX idx_spec_gate_admissions_spec_gate
    ON spec_gate_admissions (spec_id, gate, created_at DESC);

CREATE TABLE spec_questions (
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

CREATE INDEX idx_spec_questions_spec_status
    ON spec_questions (spec_id, status, number);

CREATE TABLE spec_assumptions (
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

CREATE INDEX idx_spec_assumptions_spec_disposition
    ON spec_assumptions (spec_id, disposition, number);

CREATE UNIQUE INDEX uq_spec_assumptions_predecessor
    ON spec_assumptions (spec_id, supersedes_assumption_id)
    WHERE supersedes_assumption_id IS NOT NULL;

CREATE UNIQUE INDEX uq_spec_assumptions_operation
    ON spec_assumptions (spec_id, supersession_operation_id)
    WHERE supersession_operation_id IS NOT NULL;

CREATE TABLE spec_revision_assumption_citations (
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

CREATE INDEX idx_spec_revision_citations_revision_assumption
    ON spec_revision_assumption_citations (revision_id, assumption_id);

CREATE INDEX idx_spec_revision_citations_assumption_revision
    ON spec_revision_assumption_citations (assumption_id, revision_id);

CREATE TRIGGER spec_revision_citations_same_spec_insert
  BEFORE INSERT ON spec_revision_assumption_citations
  WHEN NOT EXISTS (
    SELECT 1 FROM spec_elements
    WHERE id = NEW.element_id AND spec_id = NEW.spec_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'citation element must belong to the same spec');
  END;

CREATE TRIGGER spec_revision_citations_same_spec_update
  BEFORE UPDATE ON spec_revision_assumption_citations
  WHEN NOT EXISTS (
    SELECT 1 FROM spec_elements
    WHERE id = NEW.element_id AND spec_id = NEW.spec_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'citation element must belong to the same spec');
  END;

CREATE TRIGGER spec_revision_citations_frozen_insert
  BEFORE INSERT ON spec_revision_assumption_citations
  WHEN COALESCE((
    SELECT state FROM spec_revisions WHERE id = NEW.revision_id
  ), '') <> 'draft'
  BEGIN
    SELECT RAISE(ABORT, 'frozen revision citations require a draft');
  END;

CREATE TRIGGER spec_revision_citations_frozen_update
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

CREATE TRIGGER spec_revision_citations_frozen_delete
  BEFORE DELETE ON spec_revision_assumption_citations
  WHEN COALESCE((
    SELECT state FROM spec_revisions WHERE id = OLD.revision_id
  ), '') <> 'draft'
  BEGIN
    SELECT RAISE(ABORT, 'frozen revision citations require a draft');
  END;

CREATE TRIGGER spec_revision_citation_metadata_frozen_update
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

CREATE TABLE spec_comments (
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

CREATE INDEX idx_spec_comments_element_resolution
    ON spec_comments (spec_id, element_id, resolution);

CREATE INDEX idx_spec_comments_thread
    ON spec_comments (thread_id, created_at);

CREATE TABLE spec_evidence (
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

CREATE INDEX idx_spec_evidence_criterion_revision
    ON spec_evidence (criterion_element_id, revision_id, created_at);

CREATE INDEX idx_spec_evidence_execution
    ON spec_evidence (execution_id, created_at);

CREATE INDEX idx_spec_evidence_source_event
    ON spec_evidence (source_event_id)
    WHERE source_event_id IS NOT NULL;

CREATE TABLE spec_proof_verdicts (
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

CREATE INDEX idx_spec_proof_verdicts_criterion_revision
    ON spec_proof_verdicts (criterion_element_id, revision_id, verdict_at);

CREATE INDEX idx_spec_proof_verdicts_execution
    ON spec_proof_verdicts (execution_id, verdict_at);

CREATE TABLE spec_delivery_verdicts (
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

CREATE INDEX idx_spec_delivery_verdicts_execution
    ON spec_delivery_verdicts (workflow_execution_id, verdict_at);

CREATE INDEX idx_spec_delivery_verdicts_spec_execution
    ON spec_delivery_verdicts (spec_execution_id, verdict_at);

CREATE INDEX idx_spec_delivery_verdicts_criterion
    ON spec_delivery_verdicts (criterion_element_id, verdict_at);

CREATE TABLE spec_acceptance_reviews (
    id           TEXT PRIMARY KEY,
    spec_id      TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
    revision_id  TEXT NOT NULL REFERENCES spec_revisions(id),
    review_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

CREATE INDEX idx_spec_acceptance_reviews_spec
    ON spec_acceptance_reviews (spec_id, created_at);

CREATE TABLE spec_waivers (
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

CREATE UNIQUE INDEX uq_spec_waivers_criterion_revision
    ON spec_waivers (criterion_element_id, revision_id);

CREATE TABLE spec_criterion_dispositions (
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

CREATE INDEX idx_spec_criterion_dispositions_criterion
    ON spec_criterion_dispositions (criterion_element_id, disposition);

CREATE TABLE spec_task_claims (
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

CREATE INDEX idx_spec_task_claims_task_execution
    ON spec_task_claims (task_element_id, execution_id, claimed_at DESC);

CREATE TABLE spec_links (
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

CREATE INDEX idx_spec_links_spec_category
    ON spec_links (spec_id, category, created_at);

CREATE INDEX idx_spec_links_object
    ON spec_links (object_kind, object_ref_json);

CREATE UNIQUE INDEX uq_spec_links_entry_identity
    ON spec_links (object_kind, object_ref_json, category)
    WHERE (object_kind = 'conversation' AND category = 'source')
       OR (object_kind = 'ticket' AND category = 'graduated_from');

CREATE TABLE spec_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id       TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    actor_json    TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE
  );

CREATE INDEX idx_spec_events_spec_order
    ON spec_events (spec_id, id);

CREATE INDEX idx_spec_events_type_order
    ON spec_events (event_type, id);

CREATE TABLE spec_delivery_plan_attempts (
    id                        TEXT PRIMARY KEY,
    spec_id                   TEXT NOT NULL,
    pinned_revision_id        TEXT NOT NULL,
    delta_basis_execution_id  TEXT,
    status                    TEXT NOT NULL CHECK (status IN (
      'draft', 'approved', 'parked', 'launched', 'abandoned'
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

CREATE INDEX idx_spec_delivery_plan_attempts_spec
    ON spec_delivery_plan_attempts (spec_id, updated_at DESC);

CREATE INDEX idx_spec_delivery_plan_attempts_revision
    ON spec_delivery_plan_attempts (pinned_revision_id);

CREATE UNIQUE INDEX idx_spec_delivery_plan_attempts_definition
    ON spec_delivery_plan_attempts (workflow_definition_id)
    WHERE workflow_definition_id IS NOT NULL;

CREATE TABLE spec_delivery_plan_snapshots (
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

CREATE INDEX idx_spec_delivery_plan_snapshots_attempt
    ON spec_delivery_plan_snapshots (attempt_id, draft_revision DESC);

CREATE UNIQUE INDEX idx_spec_delivery_plan_snapshots_definition
    ON spec_delivery_plan_snapshots (workflow_definition_id)
    WHERE workflow_definition_id IS NOT NULL;

CREATE TABLE spec_delivery_plan_candidate_approvals (
    snapshot_id       TEXT PRIMARY KEY,
    candidate_id      TEXT NOT NULL,
    candidate_hash    TEXT NOT NULL,
    approved_at       TEXT NOT NULL,
    approved_by_json  TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES spec_delivery_plan_snapshots(id)
      ON DELETE CASCADE
  );

CREATE TABLE spec_delivery_plan_comments (
    id           TEXT PRIMARY KEY,
    attempt_id   TEXT NOT NULL,
    context_id   TEXT NOT NULL,
    body         TEXT NOT NULL,
    author_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
      ON DELETE CASCADE
  );

CREATE INDEX idx_spec_delivery_plan_comments_attempt
    ON spec_delivery_plan_comments (attempt_id, created_at ASC);

CREATE TABLE spec_delivery_discoveries (
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

CREATE INDEX idx_spec_delivery_discoveries_spec
    ON spec_delivery_discoveries (spec_id, captured_at ASC, id ASC);

CREATE INDEX idx_spec_delivery_discoveries_execution
    ON spec_delivery_discoveries (execution_id);

CREATE TABLE graph_workflow_result_deliveries (
    execution_id           TEXT NOT NULL,
    boundary_seq           INTEGER NOT NULL,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    origin_conversation_id TEXT,
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

CREATE INDEX idx_graph_workflow_result_deliveries_pending
    ON graph_workflow_result_deliveries (
      origin_conversation_id, delivery_state, boundary_seq
    );

CREATE INDEX idx_graph_workflow_result_deliveries_session
    ON graph_workflow_result_deliveries (
      project_path, session_name, execution_id
    );

CREATE TABLE graph_workflow_runtime_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL,
    token TEXT NOT NULL
  );

CREATE TABLE graph_workflow_pending_artifacts (
    execution_id   TEXT PRIMARY KEY,
    project_path   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    documents_json TEXT NOT NULL,
    recorded_at    TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

CREATE INDEX idx_graph_workflow_pending_artifacts_session
    ON graph_workflow_pending_artifacts (
      project_path, session_name, execution_id
    );

CREATE TABLE graph_plan_reviews (
    id                       TEXT PRIMARY KEY,
    definition_hash          TEXT NOT NULL,
    reviewer_conversation_id TEXT NOT NULL,
    verdict                  TEXT NOT NULL CHECK (
      verdict IN ('approved', 'changes_requested')
    ),
    findings                 TEXT,
    reviewed_at              TEXT NOT NULL
  );

CREATE INDEX idx_graph_plan_reviews_definition_hash
    ON graph_plan_reviews (definition_hash, reviewed_at);

CREATE TABLE control_permits (
    controller_id TEXT PRIMARY KEY,
    parent_controller_id TEXT REFERENCES control_permits(controller_id),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    state TEXT NOT NULL CHECK (state IN ('open','closed','revoked')),
    updated_at TEXT NOT NULL
  );

CREATE INDEX idx_control_permits_parent
    ON control_permits (parent_controller_id);

CREATE TABLE pending_intents (
    id TEXT PRIMARY KEY,
    requester_kind TEXT NOT NULL CHECK (requester_kind IN ('context','run')),
    requester_id TEXT NOT NULL,
    executor TEXT NOT NULL CHECK (executor IN ('conversation','requests','context','workspace')),
    cause TEXT NOT NULL,
    permit_controller_id TEXT,
    permit_generation INTEGER,
    request_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (executor, cause),
    CHECK ((permit_controller_id IS NULL) = (permit_generation IS NULL))
  );

CREATE INDEX idx_pending_intents_requester
    ON pending_intents (requester_kind, requester_id, recorded_at, id);

CREATE TABLE execution_contexts (
    context_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    session_name TEXT NOT NULL,
    owner_conversation_id TEXT NOT NULL,
    start_cause TEXT NOT NULL UNIQUE,
    workspace_json TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    progress_json TEXT NOT NULL,
    progress_occurrence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX idx_execution_contexts_run
    ON execution_contexts (run_id, created_at);

CREATE TABLE workspace_bindings (
    binding_id TEXT PRIMARY KEY,
    worktree_path TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting','bound','released')),
    baseline TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX idx_workspace_bindings_worktree
    ON workspace_bindings (worktree_path, state);

CREATE TABLE workspace_operations (
    cause TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    requester_kind TEXT NOT NULL CHECK (requester_kind IN ('context','run')),
    requester_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    permit_controller_id TEXT,
    permit_generation INTEGER,
    state TEXT NOT NULL CHECK (state IN ('queued','running','settled','uncertain')),
    outcome_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX idx_workspace_operations_state
    ON workspace_operations (state, created_at);

CREATE TABLE core_seat_bindings (
    conversation_id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    replacement INTEGER NOT NULL CHECK (replacement >= 0),
    role TEXT NOT NULL CHECK (role IN ('implementer','reviewer')),
    project_path TEXT NOT NULL,
    session_name TEXT NOT NULL,
    backend TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (context_id, assignment_id, replacement)
  );

CREATE TABLE core_interactive_conversations (
    conversation_id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    session_name TEXT NOT NULL,
    enrolled_at TEXT NOT NULL
  );

CREATE TABLE core_mailbox (
    cause TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    requester_kind TEXT CHECK (requester_kind IN ('context','run')),
    requester_id TEXT,
    request_json TEXT NOT NULL,
    permit_controller_id TEXT,
    permit_generation INTEGER,
    state TEXT NOT NULL CHECK (state IN ('queued','consumed')),
    attempt_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX idx_core_mailbox_conversation
    ON core_mailbox (conversation_id, state, created_at);

CREATE TABLE core_attempts (
    attempt_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    cause TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','admitted','settled')),
    outcome_json TEXT,
    opened_at TEXT NOT NULL,
    settled_at TEXT
  );

CREATE INDEX idx_core_attempts_cause
    ON core_attempts (cause, opened_at);

CREATE INDEX idx_core_attempts_state
    ON core_attempts (state);

CREATE TABLE core_questions (
    question_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','answered','withdrawn')),
    answer TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );

CREATE INDEX idx_core_questions_attempt
    ON core_questions (conversation_id, attempt_id);

CREATE TABLE core_question_waits (
    cause TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    requester_kind TEXT NOT NULL CHECK (requester_kind IN ('context','run')),
    requester_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

CREATE INDEX idx_core_question_waits_question
    ON core_question_waits (question_id);

CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    session_name TEXT NOT NULL,
    owner_conversation_id TEXT NOT NULL,
    owner_session_name TEXT,
    launch_cause TEXT NOT NULL UNIQUE,
    facts_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    progress_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Added after the table shipped, so it also appears in ADDITIVE_COLUMNS.
    origin_json TEXT
  );

CREATE INDEX idx_runs_owner
    ON runs (project_path, owner_conversation_id, created_at);

CREATE TABLE run_boundaries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    occurrence TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (run_id, occurrence)
  );

CREATE TABLE notepads (
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

CREATE UNIQUE INDEX uq_notepads_scope_name
    ON notepads (scope, IFNULL(project_path, ''), name);

CREATE INDEX idx_notepads_scope_listing
    ON notepads (scope, project_path, archived, pinned DESC, updated_at DESC);

CREATE TABLE notepad_revisions (
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

CREATE TABLE notepad_images (
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

CREATE INDEX idx_notepad_images_notepad_created
    ON notepad_images (notepad_id, created_at);

CREATE TABLE notepad_comments (
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

CREATE INDEX idx_notepad_comments_notepad_status
    ON notepad_comments (notepad_id, status, created_at);

CREATE TABLE notepad_comment_replies (
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

CREATE INDEX idx_notepad_comment_replies_comment
    ON notepad_comment_replies (comment_id, created_at);

CREATE TABLE notepad_delivery_watermarks (
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

CREATE TABLE conversation_subscriptions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('notepad','ticket','spec','workflow','validation','git_job','conversation','run')),
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('passive','active')),
    -- Added by the ordered 0068 rebuild, not at open, so an older schema keeps its shape until migration.
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

CREATE TABLE conversation_subscription_deliveries (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('notepad','ticket','spec','workflow','validation','git_job','conversation','run')),
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

CREATE INDEX idx_subscription_deliveries_inbox
    ON conversation_subscription_deliveries (project_path, conversation_id, state, recorded_at, id);

CREATE TABLE ticket_status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_conversation_id TEXT,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

CREATE INDEX idx_ticket_status_changes_ticket
    ON ticket_status_changes (ticket_id, id);

CREATE TABLE conversation_subscription_preferences (
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    hints_enabled INTEGER NOT NULL CHECK (hints_enabled IN (0,1)),
    PRIMARY KEY (project_path,conversation_id)
  );

CREATE TABLE conversation_subscription_read_state (
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (project_path,conversation_id,delivery_id)
  );

CREATE TABLE conversation_subscription_waits (
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

CREATE UNIQUE INDEX idx_subscription_waits_one_live
    ON conversation_subscription_waits(subscription_id) WHERE state IN ('waiting','ready');

CREATE INDEX idx_subscription_waits_recipient
    ON conversation_subscription_waits (project_path,conversation_id,state);

CREATE TABLE conversation_subscription_wake_batches (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('planned','queued','accepted','failed','uncertain','cancelled')),
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

CREATE UNIQUE INDEX idx_subscription_wake_one_pending
    ON conversation_subscription_wake_batches (project_path,conversation_id)
    WHERE state IN ('planned','queued','failed','uncertain');

CREATE INDEX idx_subscription_wake_rate
    ON conversation_subscription_wake_batches (project_path,conversation_id,created_at);

CREATE TABLE memory_notes (
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

CREATE UNIQUE INDEX uq_memory_notes_scope_slug
    ON memory_notes (
      scope, IFNULL(project_path, ''), IFNULL(session_name, ''),
      IFNULL(session_created_at, ''), slug
    )
    WHERE lifecycle <> 'archived';

CREATE INDEX idx_memory_notes_scope_listing
    ON memory_notes (scope, project_path, lifecycle, updated_at DESC);

CREATE TABLE memory_note_aliases (
    memory_id TEXT NOT NULL,
    alias     TEXT NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (memory_id, alias),
    FOREIGN KEY (memory_id) REFERENCES memory_notes(id) ON DELETE CASCADE
  );

CREATE INDEX idx_memory_note_aliases_alias
    ON memory_note_aliases (alias);

CREATE TABLE memory_note_revisions (
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

CREATE TABLE memory_links (
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

CREATE INDEX idx_memory_links_memory_kind
    ON memory_links (memory_id, kind);

CREATE INDEX idx_memory_links_artifact
    ON memory_links (artifact_kind, artifact_id);

CREATE VIRTUAL TABLE memory_notes_fts USING fts5(
    slug,
    hook,
    aliases,
    body,
    content='',
    contentless_delete=1,
    tokenize='porter unicode61'
  );

CREATE TABLE memory_delivery_watermarks (
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

CREATE TABLE memory_index_delivery_state (
    conversation_id  TEXT PRIMARY KEY,
    last_full_at     TEXT NOT NULL,
    last_delivery_at TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

CREATE TABLE memory_observation_counters (
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

CREATE INDEX idx_memory_observation_counters_memory
    ON memory_observation_counters (memory_id);

CREATE TABLE conversation_checkpoint_operations (
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

CREATE UNIQUE INDEX uq_conversation_checkpoint_active
    ON conversation_checkpoint_operations (scope, conversation_id)
    WHERE phase IN ('building', 'retiring', 'ready', 'delivering', 'needs_reconciliation')
      AND superseded_by_operation_id IS NULL;

CREATE UNIQUE INDEX uq_conversation_checkpoint_ordinal
    ON conversation_checkpoint_operations (scope, conversation_id, ordinal);

CREATE INDEX idx_conversation_checkpoint_operations_conversation
    ON conversation_checkpoint_operations (scope, conversation_id, ordinal DESC);

CREATE TABLE conversation_checkpoints (
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

CREATE TRIGGER conversation_checkpoints_immutable
  BEFORE UPDATE ON conversation_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'conversation checkpoints are immutable');
  END;

CREATE TRIGGER trg_conversation_checkpoints_session_cleanup
    AFTER DELETE ON conversations
  BEGIN
    DELETE FROM conversation_checkpoint_operations
      WHERE scope = 'session' AND conversation_id = OLD.id;
  END;

CREATE TRIGGER trg_conversation_checkpoints_project_cleanup
    AFTER DELETE ON project_conversations
  BEGIN
    DELETE FROM conversation_checkpoint_operations
      WHERE scope = 'project' AND conversation_id = OLD.id;
  END;

CREATE INDEX idx_notifications_read ON notifications(read);

CREATE INDEX idx_notifications_created_at ON notifications(created_at);

CREATE INDEX idx_notifications_project_session
    ON notifications(project_name, session_name);

CREATE INDEX idx_notifications_project_conversation
    ON notifications(project_name, conversation_id)
    WHERE source = 'project-conversation';

CREATE UNIQUE INDEX idx_notifications_dedupe
    ON notifications(dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_notifications_spec_request
    ON notifications(spec_id, spec_gate_request_id, created_at DESC)
    WHERE source = 'spec';

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
      updated_at                TEXT NOT NULL, lease_held INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (project_path, session_name),
      FOREIGN KEY (project_path, session_name)
        REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
    );

CREATE INDEX idx_graph_workflow_executions_status
      ON graph_workflow_executions(project_path, session_name, status);

CREATE UNIQUE INDEX uq_memory_links_identity_v2
    ON memory_links (
      memory_id, kind, artifact_kind, IFNULL(artifact_id, ''),
      IFNULL(artifact_context_id, ''), IFNULL(artifact_project_path, ''),
      IFNULL(artifact_session_name, ''), IFNULL(artifact_session_created_at, '')
    );

CREATE TABLE graph_workflow_coverage_cutover_backups (
      execution_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      session_name TEXT NOT NULL,
      runtime_json TEXT NOT NULL
    );
`;
