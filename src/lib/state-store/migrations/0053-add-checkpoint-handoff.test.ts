import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { _createTestDbAtPath, KNOWN_SCHEMA_VERSION } from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { migrations } from "./index";
import {
  addCheckpointHandoff,
  CHECKPOINT_HANDOFF_SCHEMA_VERSION,
} from "./0053-add-checkpoint-handoff";

const at = "2026-09-18T00:00:00Z";
const project = "/projects/handoff-migration";
const seed = "<checkpoint>Frozen v1 seed 🧭\n</checkpoint>";
const hash = createHash("sha256").update(seed).digest("hex");

function hasHandoff(db: ReturnType<typeof _createTestDbAtPath>): boolean {
  const columns = db
    .prepare("PRAGMA table_info(conversation_checkpoint_operations)")
    .all() as { name: string }[];
  return columns.some((column) => column.name === "handoff_json");
}

async function populatedWorld() {
  const configDir = await mkdtemp(path.join(tmpdir(), "cc-handoff-migration-"));
  const dbPath = path.join(configDir, "command-center.db");
  const fixture = createPersistenceFixture({ db: _createTestDbAtPath(dbPath) });
  fixture.seedProject(project);
  fixture.seedSession(project, "session");
  const db = fixture.db;
  db.prepare(
    `INSERT INTO conversations (id, project_path, session_name, name, status,
    prompt_count, created_at, last_activity_at, pending_queue, profile_snapshot, checkpoint_fork)
    VALUES ('conversation', ?, 'session', 'preserve', 'awaiting', 3, ?, ?, ?, ?, ?)`,
  ).run(
    project,
    at,
    at,
    '[{"id":"queued","text":"preserve request"}]',
    '{"ref":{"tier":"builtin","id":"general-implementer"},"instructions":"preserve profile"}',
    '{"source":{"conversationId":"original"},"sourceOperationId":"original-operation","seedHash":"original-hash"}',
  );
  db.prepare(
    `INSERT INTO conversation_checkpoint_operations
    (id, scope, project_path, session_name, conversation_id, ordinal, phase,
     captured_through_seq, source_hash, payload_id, requested_at, updated_at)
    VALUES ('legacy', 'session', ?, 'session', 'conversation', 1, 'ready', 42, 'source-hash', 'legacy', ?, ?)`,
  ).run(project, at, at);
  db.prepare(
    `INSERT INTO conversation_checkpoints
    (id, schema_version, captured_through_seq, source_hash, generator_version, builder_version,
    normalizer_version, model_selection_json, sections_json, seed_text, seed_sha256,
    section_bytes_json, omissions_json, generation_pass_count, created_at)
    VALUES ('legacy', 1, 42, 'source-hash', 'generator-v1', 'builder-v1', 'normalizer-v1',
      '{"modelId":"source","parameters":{}}', '{}', ?, ?, '{}', '[]', 1, ?)`,
  ).run(seed, hash, at);
  db.prepare(
    `INSERT INTO context_artifacts
    (id, kind, scope, project_path, session_name, conversation_id, covered_start_seq, covered_end_seq,
    source_hash, status, backend, model_selection_json, schema_version, prompt_version,
    normalizer_version, created_by, payload_json, created_at, updated_at)
    VALUES ('artifact', 'conversation_compaction', 'session', ?, 'session', 'conversation',
    1, 42, 'artifact-source', 'complete', 'claude', '{"modelId":"source","parameters":{}}',
    1, 'v1', 'v1', 'user', '{"content":"original artifact"}', ?, ?)`,
  ).run(project, at, at);
  return { configDir, dbPath, fixture, db };
}

function snapshot(db: ReturnType<typeof _createTestDbAtPath>) {
  return Object.fromEntries(
    [
      "projects",
      "sessions",
      "conversations",
      "context_artifacts",
      "conversation_checkpoints",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
  );
}

describe("0053 checkpoint handoff preserving upgrade", () => {
  it("provides the nullable column in fresh databases and registers the new barrier", () => {
    const fixture = createPersistenceFixture();
    try {
      expect(hasHandoff(fixture.db)).toBe(true);
      expect(migrations.map((migration) => migration.name)).toContain(
        addCheckpointHandoff.name,
      );
      expect(KNOWN_SCHEMA_VERSION).toBeGreaterThanOrEqual(
        CHECKPOINT_HANDOFF_SCHEMA_VERSION,
      );
    } finally {
      fixture.close();
    }
  });

  it("preserves legacy seed/hash/source/fork and populated unrelated data through migration replay and reload", async () => {
    const world = await populatedWorld();
    const { db, fixture, dbPath, configDir } = world;
    try {
      if (hasHandoff(db))
        db.exec(
          "ALTER TABLE conversation_checkpoint_operations DROP COLUMN handoff_json",
        );
      const before = snapshot(db);
      const operationBefore = db
        .prepare("SELECT * FROM conversation_checkpoint_operations")
        .get();
      if (typeof operationBefore !== "object" || operationBefore === null) {
        throw new Error("Expected the seeded checkpoint operation");
      }
      const params = {
        name: addCheckpointHandoff.name,
        context: { db, configDir },
      };
      await addCheckpointHandoff.up(params);
      await addCheckpointHandoff.up(params);
      expect(hasHandoff(db)).toBe(true);
      expect(
        db.prepare("SELECT * FROM conversation_checkpoint_operations").get(),
      ).toEqual({ ...operationBefore, handoff_json: null });
      expect(snapshot(db)).toEqual(before);
      const reloaded = _createTestDbAtPath(dbPath);
      try {
        expect(snapshot(reloaded)).toEqual(before);
        expect(
          reloaded
            .prepare(
              "SELECT seed_text, seed_sha256, schema_version FROM conversation_checkpoints",
            )
            .get(),
        ).toEqual({ seed_text: seed, seed_sha256: hash, schema_version: 1 });
      } finally {
        reloaded.close();
      }
      expect(() =>
        db
          .prepare(
            "UPDATE conversation_checkpoints SET seed_text = 'rewritten'",
          )
          .run(),
      ).toThrow(/immutable/);
    } finally {
      fixture.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("adds the column on floor reopen without requiring the asynchronous migration", async () => {
    const { fixture, db, dbPath, configDir } = await populatedWorld();
    try {
      if (hasHandoff(db))
        db.exec(
          "ALTER TABLE conversation_checkpoint_operations DROP COLUMN handoff_json",
        );
      const before = snapshot(db);
      const reopened = _createTestDbAtPath(dbPath);
      try {
        expect(hasHandoff(reopened)).toBe(true);
        expect(snapshot(reopened)).toEqual(before);
      } finally {
        reopened.close();
      }
    } finally {
      fixture.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("publishes the barrier before permitting old incompatible writers", async () => {
    const { fixture, db, dbPath, configDir } = await populatedWorld();
    try {
      await addCheckpointHandoff.up({
        name: addCheckpointHandoff.name,
        context: { db, configDir },
      });
      expect(
        existsSync(
          schemaCompatibilityBarrierPath(
            configDir,
            CHECKPOINT_HANDOFF_SCHEMA_VERSION,
          ),
        ),
      ).toBe(true);
      expect(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version = 20")
          .all(),
      ).toEqual([{ version: 20 }]);
      expect(() => enforceCurrentSchemaCompatibility(db, dbPath, 19)).toThrow(
        /schema version/i,
      );
      expect(() =>
        enforceCurrentSchemaCompatibility(
          db,
          dbPath,
          CHECKPOINT_HANDOFF_SCHEMA_VERSION,
        ),
      ).not.toThrow();
    } finally {
      fixture.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
