/** Frozen leaf-table definitions for the graph-engine retirement. */
export const CUTOVER_NOTIFICATIONS_DDL = `
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

export const CUTOVER_GATE_ADMISSIONS_DDL = `
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

export const CUTOVER_SUBSCRIPTIONS_DDL = `
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
