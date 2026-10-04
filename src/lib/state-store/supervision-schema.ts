/**
 * Tables for the shared supervision core: control permits and pending
 * cross-domain intents. Additive: older builds never read them.
 */
export const SUPERVISION_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS control_permits (
    controller_id TEXT PRIMARY KEY,
    parent_controller_id TEXT REFERENCES control_permits(controller_id),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    state TEXT NOT NULL CHECK (state IN ('open','closed','revoked')),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_control_permits_parent
    ON control_permits (parent_controller_id);

  CREATE TABLE IF NOT EXISTS pending_intents (
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
  CREATE INDEX IF NOT EXISTS idx_pending_intents_requester
    ON pending_intents (requester_kind, requester_id, recorded_at, id);

  CREATE TABLE IF NOT EXISTS execution_contexts (
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
  CREATE INDEX IF NOT EXISTS idx_execution_contexts_run
    ON execution_contexts (run_id, created_at);

  CREATE TABLE IF NOT EXISTS workspace_bindings (
    binding_id TEXT PRIMARY KEY,
    worktree_path TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting','bound','released')),
    baseline TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_bindings_worktree
    ON workspace_bindings (worktree_path, state);

  CREATE TABLE IF NOT EXISTS workspace_operations (
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
  CREATE INDEX IF NOT EXISTS idx_workspace_operations_state
    ON workspace_operations (state, created_at);

  CREATE TABLE IF NOT EXISTS core_seat_bindings (
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

  CREATE TABLE IF NOT EXISTS core_interactive_conversations (
    conversation_id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    session_name TEXT NOT NULL,
    enrolled_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS core_mailbox (
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
  CREATE INDEX IF NOT EXISTS idx_core_mailbox_conversation
    ON core_mailbox (conversation_id, state, created_at);

  CREATE TABLE IF NOT EXISTS core_attempts (
    attempt_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    cause TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','admitted','settled')),
    outcome_json TEXT,
    opened_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_core_attempts_cause
    ON core_attempts (cause, opened_at);
  CREATE INDEX IF NOT EXISTS idx_core_attempts_state
    ON core_attempts (state);

  CREATE TABLE IF NOT EXISTS core_questions (
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
  CREATE INDEX IF NOT EXISTS idx_core_questions_attempt
    ON core_questions (conversation_id, attempt_id);

  CREATE TABLE IF NOT EXISTS core_question_waits (
    cause TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    requester_kind TEXT NOT NULL CHECK (requester_kind IN ('context','run')),
    requester_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_core_question_waits_question
    ON core_question_waits (question_id);

  CREATE TABLE IF NOT EXISTS runs (
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
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_owner
    ON runs (project_path, owner_conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS run_boundaries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    occurrence TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    notified_at TEXT,
    UNIQUE (run_id, occurrence)
  );
`;
