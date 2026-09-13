import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  enforceCurrentSchemaCompatibility,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { runMigrations } from "../migrator";
import { _createTestDbAtPath, KNOWN_SCHEMA_VERSION } from "../state-db";
import {
  CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
  addConversationCheckpoints,
} from "./0044-add-conversation-checkpoints";

type Db = InstanceType<typeof Database>;

const CHECKPOINT_OBJECTS = [
  "conversation_checkpoint_operations",
  "conversation_checkpoints",
  "uq_conversation_checkpoint_active",
  "uq_conversation_checkpoint_ordinal",
  "idx_conversation_checkpoint_operations_conversation",
  "conversation_checkpoints_immutable",
  "trg_conversation_checkpoints_session_cleanup",
  "trg_conversation_checkpoints_project_cleanup",
] as const;

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface World {
  configDir: string;
  dbPath: string;
  db: Db;
}

async function world(): Promise<World> {
  const configDir = await mkdtemp(path.join(tmpdir(), "cc-checkpoint-mig-"));
  tempDirs.push(configDir);
  const dbPath = path.join(configDir, "command-center.db");
  const db = _createTestDbAtPath(dbPath);
  openDbs.push(db);
  return { configDir, dbPath, db };
}

async function runMigration(db: Db, configDir: string | null): Promise<void> {
  await addConversationCheckpoints.up({
    name: addConversationCheckpoints.name,
    context: { db, configDir },
  });
}

/**
 * Return the database to its pre-upgrade shape. The synchronous floor creates
 * the checkpoint objects on every open, so an "old database" has to be made by
 * removing them — otherwise the migration would be exercised only as a no-op.
 */
function dropCheckpointObjects(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_conversation_checkpoints_project_cleanup;
    DROP TRIGGER IF EXISTS trg_conversation_checkpoints_session_cleanup;
    DROP TRIGGER IF EXISTS conversation_checkpoints_immutable;
    DROP TABLE IF EXISTS conversation_checkpoints;
    DROP TABLE IF EXISTS conversation_checkpoint_operations;
  `);
}

function existingCheckpointObjects(db: Db): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE name IN (${CHECKPOINT_OBJECTS.map(() => "?").join(", ")})
        ORDER BY name`,
    )
    .pluck()
    .all(...CHECKPOINT_OBJECTS) as string[];
}

const PROJECT = "/projects/preserving";
const SESSION = "csm-preserving";
const CONVERSATION = "conv-session-preserving";
const PROJECT_CONVERSATION = "conv-project-preserving";

const PROFILE_SNAPSHOT = JSON.stringify({
  ref: { tier: "builtin", id: "general-implementer" },
  revision: 1,
  instructions: "keep the diff small",
});
const PENDING_QUEUE = JSON.stringify([
  { id: "queued-1", text: "second thing", enqueuedAt: "2026-09-01T00:00:00Z" },
]);
const ARTIFACT_PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  sections: [{ heading: "Working state", body: "kept" }],
});

/** A database carrying the row families the preserving upgrade must not touch. */
function seedPopulatedState(db: Db): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(PROJECT);
    db.prepare(
      `INSERT INTO sessions (
         project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at, objective
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT,
      SESSION,
      "/worktrees/preserving",
      "csm/preserving",
      "2026-09-01T00:00:00Z",
      "2026-09-01T01:00:00Z",
      "preserve everything",
    );
    db.prepare(
      `INSERT INTO conversations (
         id, project_path, session_name, name, status, prompt_count,
         created_at, last_activity_at, agent_backend, backend_ref,
         pending_queue, profile_snapshot, profile_locked_at, turn_generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CONVERSATION,
      PROJECT,
      SESSION,
      "session conversation",
      "awaiting",
      7,
      "2026-09-01T00:00:00Z",
      "2026-09-01T01:00:00Z",
      "claude",
      JSON.stringify({ backend: "claude", ref: "sdk-session-1" }),
      PENDING_QUEUE,
      PROFILE_SNAPSHOT,
      "2026-09-01T00:30:00Z",
      3,
    );
    db.prepare(
      `INSERT INTO project_conversations (
         id, project_path, name, status, prompt_count,
         created_at, last_activity_at, agent_backend, backend_ref,
         pending_queue, profile_snapshot, turn_generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_CONVERSATION,
      PROJECT,
      "project conversation",
      "awaiting",
      2,
      "2026-09-01T00:00:00Z",
      "2026-09-01T02:00:00Z",
      "codex",
      JSON.stringify({ backend: "codex", ref: "thread-9" }),
      PENDING_QUEUE,
      PROFILE_SNAPSHOT,
      1,
    );
    db.prepare(
      `INSERT INTO context_artifacts (
         id, kind, scope, project_path, session_name, conversation_id,
         covered_start_seq, covered_end_seq, source_hash, status, backend,
         model_selection_json, schema_version, prompt_version,
         normalizer_version, created_by, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "artifact-preserving",
      "conversation_compaction",
      "session",
      PROJECT,
      SESSION,
      CONVERSATION,
      1,
      420,
      "sha256:artifact-source",
      "complete",
      "claude",
      JSON.stringify({ modelId: "sonnet", parameters: { effort: "high" } }),
      1,
      "prompt-v3",
      "normalizer-v2",
      "user",
      ARTIFACT_PAYLOAD,
      "2026-09-01T00:10:00Z",
      "2026-09-01T00:20:00Z",
    );
  }).immediate();
}

function snapshotPopulatedState(db: Db): Record<string, unknown[]> {
  const read = (table: string): unknown[] =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return {
    projects: read("projects"),
    sessions: read("sessions"),
    conversations: read("conversations"),
    project_conversations: read("project_conversations"),
    context_artifacts: read("context_artifacts"),
  };
}

function stampedVersions(db: Db): number[] {
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .pluck()
    .all() as number[];
}

describe("0044-add-conversation-checkpoints", () => {
  it("owns the schema version this build knows", () => {
    expect(CONVERSATION_CHECKPOINTS_SCHEMA_VERSION).toBeLessThanOrEqual(
      KNOWN_SCHEMA_VERSION,
    );
  });

  it("creates the checkpoint tables, indexes and triggers on a pre-floor database", async () => {
    const { configDir, db } = await world();
    dropCheckpointObjects(db);
    expect(existingCheckpointObjects(db)).toEqual([]);

    await runMigration(db, configDir);

    expect(existingCheckpointObjects(db)).toEqual(
      [...CHECKPOINT_OBJECTS].sort(),
    );
  });

  it("publishes the compatibility barrier and stamps its version", async () => {
    const { configDir, db } = await world();

    await runMigration(db, configDir);

    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          configDir,
          CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
        ),
      ),
    ).toBe(true);
    expect(stampedVersions(db)).toContain(
      CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
    );
  });

  it("stamps an in-memory database that has no config directory", async () => {
    const { db } = await world();

    await runMigration(db, null);

    expect(stampedVersions(db)).toContain(
      CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
    );
  });

  it("preserves populated conversation, profile, queue and artifact data across the upgrade", async () => {
    const { configDir, db } = await world();
    seedPopulatedState(db);
    dropCheckpointObjects(db);
    const before = snapshotPopulatedState(db);

    await runMigration(db, configDir);

    expect(snapshotPopulatedState(db)).toEqual(before);
    expect(existingCheckpointObjects(db)).toEqual(
      [...CHECKPOINT_OBJECTS].sort(),
    );
  });

  it("replays safely after an interruption between up and the ledger write", async () => {
    const { configDir, db } = await world();
    seedPopulatedState(db);
    dropCheckpointObjects(db);
    const before = snapshotPopulatedState(db);

    await runMigration(db, configDir);
    // The runner ledgers a migration only after `up` returns, so a crash in
    // between replays it against an already-migrated database.
    await runMigration(db, configDir);

    expect(snapshotPopulatedState(db)).toEqual(before);
    expect(
      stampedVersions(db).filter(
        (version) => version === CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
      ),
    ).toEqual([CONVERSATION_CHECKPOINTS_SCHEMA_VERSION]);
  });

  it("preserves checkpoint rows written before a replay", async () => {
    const { configDir, db } = await world();
    seedPopulatedState(db);
    await runMigration(db, configDir);
    db.prepare(
      `INSERT INTO conversation_checkpoint_operations (
         id, scope, project_path, session_name, conversation_id, ordinal, phase,
         captured_through_seq, source_hash, requested_at, updated_at
       ) VALUES (?, 'session', ?, ?, ?, 1, 'ready', 500, ?, ?, ?)`,
    ).run(
      "operation-survives-replay",
      PROJECT,
      SESSION,
      CONVERSATION,
      "sha256:survives",
      "2026-09-01T03:00:00Z",
      "2026-09-01T03:00:00Z",
    );

    await runMigration(db, configDir);

    expect(
      db
        .prepare(
          "SELECT phase FROM conversation_checkpoint_operations WHERE id = ?",
        )
        .pluck()
        .get("operation-survives-replay"),
    ).toBe("ready");
  });

  it("is registered in the ordered runner, so a fresh open reaches the schema and barrier", async () => {
    const { configDir, db } = await world();
    dropCheckpointObjects(db);

    const applied = await runMigrations({ db, configDir });

    expect(applied).toContain(addConversationCheckpoints.name);
    expect(existingCheckpointObjects(db)).toEqual(
      [...CHECKPOINT_OBJECTS].sort(),
    );
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          configDir,
          CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
        ),
      ),
    ).toBe(true);
  });

  it("carries a populated database through the ordered runner without disturbing it", async () => {
    const { configDir, db } = await world();
    seedPopulatedState(db);
    dropCheckpointObjects(db);
    const before = snapshotPopulatedState(db);

    await runMigrations({ db, configDir });

    expect(snapshotPopulatedState(db)).toEqual(before);
    expect(existingCheckpointObjects(db)).toEqual(
      [...CHECKPOINT_OBJECTS].sort(),
    );
  });

  it("refuses a writer from the build before this cutover", async () => {
    const { configDir, dbPath, db } = await world();

    await runMigration(db, configDir);

    expect(() =>
      enforceCurrentSchemaCompatibility(
        db,
        dbPath,
        CONVERSATION_CHECKPOINTS_SCHEMA_VERSION - 1,
      ),
    ).toThrow(
      new RegExp(
        `recorded schema version ${CONVERSATION_CHECKPOINTS_SCHEMA_VERSION}.*known build version ${CONVERSATION_CHECKPOINTS_SCHEMA_VERSION - 1}`,
        "i",
      ),
    );
  });

  it("refuses an older writer from the published barrier even when the ledger is unreachable", async () => {
    const { configDir, dbPath, db } = await world();

    await runMigration(db, configDir);
    db.close();
    openDbs.length = 0;

    const oldBinaryConnection = new Database(dbPath);
    openDbs.push(oldBinaryConnection);
    oldBinaryConnection.exec("DROP TABLE schema_migrations");

    expect(() =>
      enforceCurrentSchemaCompatibility(
        oldBinaryConnection,
        dbPath,
        CONVERSATION_CHECKPOINTS_SCHEMA_VERSION - 1,
      ),
    ).toThrow(/schema version/i);
  });

  it("admits this build's own writer", async () => {
    const { configDir, dbPath, db } = await world();

    await runMigration(db, configDir);

    expect(() =>
      enforceCurrentSchemaCompatibility(
        db,
        dbPath,
        CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
      ),
    ).not.toThrow();
  });
});
