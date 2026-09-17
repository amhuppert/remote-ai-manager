import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../migrator";
import {
  agentSessionRefShape,
  _setMigration0005AfterScanHookForTesting,
} from "./0005-agent-session-ref-shape";
import {
  KNOWN_SCHEMA_VERSION,
  _createTestDb,
  _createTestDbAtPath,
} from "../state-db";
import { schemaCompatibilityBarrierPath } from "../schema-compatibility";

type Db = InstanceType<typeof BetterSqlite3>;

const PROJECT_PATH = "/repo";
const SESSION_NAME = "s1";
const MIGRATION_NAME = "0005-agent-session-ref-shape";

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  _setMigration0005AfterScanHookForTesting(null);
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function freshDb(): Db {
  const db = _createTestDb({ inMemory: true });
  openDbs.push(db);
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name,
        created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `/wt/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  return db;
}

interface SeedColumns {
  backendRef?: string | null;
  forkedFrom?: string | null;
  machineSnapshot?: string | null;
}

function seedConversation(db: Db, id: string, cols: SeedColumns = {}): void {
  db.prepare(
    `INSERT INTO conversations
       (id, project_path, session_name, status, created_at, last_activity_at,
        backend_ref, forked_from, machine_snapshot)
     VALUES (?, ?, ?, 'new', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
             ?, ?, ?)`,
  ).run(
    id,
    PROJECT_PATH,
    SESSION_NAME,
    cols.backendRef ?? null,
    cols.forkedFrom ?? null,
    cols.machineSnapshot ?? null,
  );
}

function seedProjectConversation(
  db: Db,
  id: string,
  cols: SeedColumns = {},
): void {
  db.prepare(
    `INSERT INTO project_conversations
       (id, project_path, status, created_at, last_activity_at,
        backend_ref, forked_from, machine_snapshot)
     VALUES (?, ?, 'new', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
             ?, ?, ?)`,
  ).run(
    id,
    PROJECT_PATH,
    cols.backendRef ?? null,
    cols.forkedFrom ?? null,
    cols.machineSnapshot ?? null,
  );
}

interface RefColumnsRow {
  backend_ref: string | null;
  forked_from: string | null;
  machine_snapshot: string | null;
}

function readRefColumns(db: Db, table: string, id: string): RefColumnsRow {
  return db
    .prepare(
      `SELECT backend_ref, forked_from, machine_snapshot FROM ${table} WHERE id = ?`,
    )
    .get(id) as RefColumnsRow;
}

function readSchemaMigrationVersions(db: Db): number[] {
  return (
    db
      .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
      .all() as Array<{ version: number }>
  ).map((row) => row.version);
}

describe("0005-agent-session-ref-shape (production registry)", () => {
  it("rewrites legacy and superset refs in the backend_ref and forked_from columns of both tables to canonical", async () => {
    const db = freshDb();
    seedConversation(db, "c-legacy", {
      backendRef: JSON.stringify({ backend: "claude", sessionId: "sess-1" }),
      forkedFrom: JSON.stringify({
        sourceConversationId: "parent",
        messageIndex: 3,
        sourceBackend: "codex",
        // Superset shape (mirror keys present) must also collapse to canonical.
        sourceBackendRef: {
          backend: "codex",
          ref: "thr-src",
          threadId: "thr-src",
        },
        forkLocator: "msg-3",
        forkMode: "synthetic",
      }),
    });
    seedProjectConversation(db, "pc-legacy", {
      backendRef: JSON.stringify({ backend: "codex", threadId: "thr-plc" }),
    });

    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain(MIGRATION_NAME);

    const row = readRefColumns(db, "conversations", "c-legacy");
    expect(JSON.parse(row.backend_ref!)).toEqual({
      backend: "claude",
      ref: "sess-1",
    });
    const forkedFrom = JSON.parse(row.forked_from!) as {
      sourceBackendRef: unknown;
      messageIndex: number;
    };
    expect(forkedFrom.sourceBackendRef).toEqual({
      backend: "codex",
      ref: "thr-src",
    });
    expect(forkedFrom.messageIndex).toBe(3);

    const plcRow = readRefColumns(db, "project_conversations", "pc-legacy");
    expect(JSON.parse(plcRow.backend_ref!)).toEqual({
      backend: "codex",
      ref: "thr-plc",
    });
  });

  // The machine_snapshot column is canonicalized by 0005 and then moved into the
  // conversation_machine_snapshots sidecar (with `children` projected away) by
  // 0007, so the full-chain end state no longer carries a machine_snapshot
  // column. This isolates 0005's snapshot ref canonicalization — including refs
  // inside `children` — by running only its `up` against the seeded column.
  it("canonicalizes legacy/superset refs inside the machine_snapshot column (root context and children)", async () => {
    const db = freshDb();
    seedConversation(db, "c-snap", {
      machineSnapshot: JSON.stringify({
        status: "active",
        context: {
          backendRef: { backend: "claude", sessionId: "sess-snap" },
          forkedFrom: {
            sourceConversationId: "parent",
            sourceBackendRef: { backend: "codex", threadId: "thr-snap" },
          },
          children: [
            {
              nested: {
                backendRef: { backend: "codex", threadId: "thr-deep" },
              },
            },
          ],
        },
      }),
    });

    await agentSessionRefShape.up({
      name: agentSessionRefShape.name,
      context: { db, configDir: null },
    });

    const row = readRefColumns(db, "conversations", "c-snap");
    const snapshot = JSON.parse(row.machine_snapshot!) as {
      context: {
        backendRef: unknown;
        forkedFrom: { sourceBackendRef: unknown };
        children: Array<{ nested: { backendRef: unknown } }>;
      };
    };
    expect(snapshot.context.backendRef).toEqual({
      backend: "claude",
      ref: "sess-snap",
    });
    expect(snapshot.context.forkedFrom.sourceBackendRef).toEqual({
      backend: "codex",
      ref: "thr-snap",
    });
    expect(snapshot.context.children[0]?.nested.backendRef).toEqual({
      backend: "codex",
      ref: "thr-deep",
    });
  });

  it("stamps schema_migrations with version 1 so the forward-only gate trips old builds", async () => {
    const db = freshDb();
    await runMigrations({ db, configDir: null });
    expect(readSchemaMigrationVersions(db)).toContain(1);
  });

  it("re-stamping schema_migrations on replay is idempotent (INSERT OR IGNORE)", async () => {
    const db = freshDb();
    await runMigrations({ db, configDir: null });

    // Manual replay of the up body models a crash-after-up, before-ledger replay.
    await agentSessionRefShape.up({
      name: agentSessionRefShape.name,
      context: { db, configDir: null },
    });

    const versions = readSchemaMigrationVersions(db);
    expect(versions.filter((v) => v === 1)).toEqual([1]);
  });

  it("rolls back the first table when the second table rewrite fails", async () => {
    const db = freshDb();
    const conversationBytes = JSON.stringify({
      backend: "claude",
      sessionId: "sess-conversation",
    });
    const projectConversationBytes = JSON.stringify({
      backend: "codex",
      threadId: "thr-project-conversation",
    });
    seedConversation(db, "c-atomic", { backendRef: conversationBytes });
    seedProjectConversation(db, "pc-atomic", {
      backendRef: projectConversationBytes,
    });
    _setMigration0005AfterScanHookForTesting((table) => {
      if (table === "project_conversations") {
        throw new Error("simulated second-table failure");
      }
    });

    await expect(
      agentSessionRefShape.up({
        name: agentSessionRefShape.name,
        context: { db, configDir: null },
      }),
    ).rejects.toThrow("simulated second-table failure");

    expect(readRefColumns(db, "conversations", "c-atomic").backend_ref).toBe(
      conversationBytes,
    );
    expect(
      readRefColumns(db, "project_conversations", "pc-atomic").backend_ref,
    ).toBe(projectConversationBytes);
    expect(readSchemaMigrationVersions(db)).toEqual([]);
  });

  it("rolls back both table rewrites when the compatibility stamp fails", async () => {
    const db = freshDb();
    const conversationBytes = JSON.stringify({
      backend: "claude",
      sessionId: "sess-conversation",
    });
    const projectConversationBytes = JSON.stringify({
      backend: "codex",
      threadId: "thr-project-conversation",
    });
    seedConversation(db, "c-stamp-atomic", { backendRef: conversationBytes });
    seedProjectConversation(db, "pc-stamp-atomic", {
      backendRef: projectConversationBytes,
    });
    db.exec(`
      CREATE TRIGGER reject_compatibility_stamp
      BEFORE INSERT ON schema_migrations
      BEGIN
        SELECT RAISE(ABORT, 'simulated stamp failure');
      END;
    `);

    await expect(
      agentSessionRefShape.up({
        name: agentSessionRefShape.name,
        context: { db, configDir: null },
      }),
    ).rejects.toThrow("simulated stamp failure");

    expect(
      readRefColumns(db, "conversations", "c-stamp-atomic").backend_ref,
    ).toBe(conversationBytes);
    expect(
      readRefColumns(db, "project_conversations", "pc-stamp-atomic")
        .backend_ref,
    ).toBe(projectConversationBytes);
    expect(readSchemaMigrationVersions(db)).toEqual([]);
  });

  it("publishes the fail-closed compatibility barrier before attempting the cutover transaction", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-migration-0005-"));
    tempDirs.push(dir);
    const db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    openDbs.push(db);
    db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
      PROJECT_PATH,
    );
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      SESSION_NAME,
      `/wt/${SESSION_NAME}`,
      `csm/${SESSION_NAME}`,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    const legacyBytes = JSON.stringify({
      backend: "claude",
      sessionId: "sess-fail-closed",
    });
    seedConversation(db, "c-fail-closed", { backendRef: legacyBytes });
    _setMigration0005AfterScanHookForTesting((table) => {
      if (table === "project_conversations") {
        throw new Error("simulated cutover failure after barrier");
      }
    });

    await expect(
      agentSessionRefShape.up({
        name: agentSessionRefShape.name,
        context: { db, configDir: dir },
      }),
    ).rejects.toThrow("simulated cutover failure after barrier");

    expect(existsSync(schemaCompatibilityBarrierPath(dir, 1))).toBe(true);
    expect(
      readRefColumns(db, "conversations", "c-fail-closed").backend_ref,
    ).toBe(legacyBytes);
    expect(readSchemaMigrationVersions(db)).toEqual([]);
  });

  it("rechecks compatibility under the cutover write lock before rewriting an already-open database", async () => {
    const db = freshDb();
    const legacyBytes = JSON.stringify({
      backend: "codex",
      threadId: "thr-future-race",
    });
    seedConversation(db, "c-future-race", { backendRef: legacyBytes });
    // A version above what THIS build understands models a newer build's
    // cutover landing after this connection opened; versions this build
    // itself stamps (later migrations in its own chain) must not refuse.
    db.prepare(
      "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
    ).run(
      KNOWN_SCHEMA_VERSION + 1,
      "newer build committed after this connection opened",
    );

    await expect(
      agentSessionRefShape.up({
        name: agentSessionRefShape.name,
        context: { db, configDir: null },
      }),
    ).rejects.toThrow(/schema version|refus/i);

    expect(
      readRefColumns(db, "conversations", "c-future-race").backend_ref,
    ).toBe(legacyBytes);
    expect(readSchemaMigrationVersions(db)).toEqual([KNOWN_SCHEMA_VERSION + 1]);
  });

  it("is idempotent: a second run leaves byte-identical rows", async () => {
    const db = freshDb();
    seedConversation(db, "c-1", {
      backendRef: JSON.stringify({ backend: "codex", threadId: "thr-1" }),
      machineSnapshot: JSON.stringify({
        context: { backendRef: { backend: "codex", threadId: "thr-1" } },
      }),
    });

    await runMigrations({ db, configDir: null });
    const first = readRefColumns(db, "conversations", "c-1");

    // Manual replay of the up body models a crash-after-up, before-ledger replay.
    await agentSessionRefShape.up({
      name: agentSessionRefShape.name,
      context: { db, configDir: null },
    });

    expect(readRefColumns(db, "conversations", "c-1")).toEqual(first);
  });

  it("converges and re-stamps the ledger after a crash-replay (ledger row deleted)", async () => {
    const db = freshDb();
    seedConversation(db, "c-replay", {
      backendRef: JSON.stringify({ backend: "claude", sessionId: "sess-r" }),
    });

    await runMigrations({ db, configDir: null });
    db.prepare(`DELETE FROM applied_migrations WHERE name = ?`).run(
      MIGRATION_NAME,
    );

    const reapplied = await runMigrations({ db, configDir: null });
    expect(reapplied).toContain(MIGRATION_NAME);
    expect(
      JSON.parse(readRefColumns(db, "conversations", "c-replay").backend_ref!),
    ).toEqual({
      backend: "claude",
      ref: "sess-r",
    });
    const ledger = db
      .prepare(`SELECT name FROM applied_migrations WHERE name = ?`)
      .get(MIGRATION_NAME);
    expect(ledger).toEqual({ name: MIGRATION_NAME });
  });

  it("stamps as a no-op on a fresh database with empty tables", async () => {
    const db = freshDb();
    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain(MIGRATION_NAME);
  });

  it("collapses a superset row to canonical, leaves canonical and NULL byte-untouched, and skips a malformed row while siblings migrate", async () => {
    const db = freshDb();
    // Canonical is the terminal shape: it must stay byte-identical (idempotent).
    const canonicalBytes = JSON.stringify({
      backend: "codex",
      ref: "thr-done",
    });
    seedConversation(db, "c-canonical", { backendRef: canonicalBytes });
    // A superset row (mirror keys present) must collapse to canonical.
    seedConversation(db, "c-superset", {
      backendRef: JSON.stringify({
        backend: "codex",
        ref: "thr-super",
        threadId: "thr-super",
      }),
    });
    seedConversation(db, "c-null");
    seedConversation(db, "c-malformed", { backendRef: "{not json" });
    seedConversation(db, "c-pending", {
      backendRef: JSON.stringify({ backend: "claude", sessionId: "sess-p" }),
    });

    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain(MIGRATION_NAME);

    expect(readRefColumns(db, "conversations", "c-canonical").backend_ref).toBe(
      canonicalBytes,
    );
    expect(
      JSON.parse(
        readRefColumns(db, "conversations", "c-superset").backend_ref!,
      ),
    ).toEqual({ backend: "codex", ref: "thr-super" });
    expect(
      readRefColumns(db, "conversations", "c-null").backend_ref,
    ).toBeNull();
    expect(readRefColumns(db, "conversations", "c-malformed").backend_ref).toBe(
      "{not json",
    );
    expect(
      JSON.parse(readRefColumns(db, "conversations", "c-pending").backend_ref!),
    ).toEqual({
      backend: "claude",
      ref: "sess-p",
    });
  });

  it("preserves the newest ref when an old build commits between candidate scan and update (two-connection WAL race)", async () => {
    // File-backed WAL DB so a second connection can write concurrently.
    const dbA = _createTestDb();
    openDbs.push(dbA);
    dbA
      .prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`)
      .run(PROJECT_PATH);
    dbA
      .prepare(
        `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PROJECT_PATH,
        SESSION_NAME,
        `/wt/${SESSION_NAME}`,
        `csm/${SESSION_NAME}`,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    seedConversation(dbA, "c-race", {
      backendRef: JSON.stringify({ backend: "codex", threadId: "thr-stale" }),
    });

    const dbB = new BetterSqlite3(dbA.name, { timeout: 100 });
    openDbs.push(dbB);
    const oldBuildWrite = dbB.prepare(
      `UPDATE conversations SET backend_ref = ? WHERE id = ?`,
    );
    const newestLegacyBytes = JSON.stringify({
      backend: "codex",
      threadId: "thr-new",
    });

    // The old build tries to commit a NEWER legacy ref in the scan→update
    // window. A safe migration holds the write lock across that window, so
    // the write must serialize: it either fails busy here (and lands after
    // the migration commits) or lands before the scan. Either way the stale
    // scanned value must never overwrite it.
    let busyDuringWindow = false;
    _setMigration0005AfterScanHookForTesting((table) => {
      if (table !== "conversations") return;
      try {
        oldBuildWrite.run(newestLegacyBytes, "c-race");
      } catch (err) {
        if ((err as { code?: string }).code !== "SQLITE_BUSY") throw err;
        busyDuringWindow = true;
      }
    });

    const applied = await runMigrations({ db: dbA, configDir: null });
    expect(applied).toContain(MIGRATION_NAME);
    _setMigration0005AfterScanHookForTesting(null);

    if (busyDuringWindow) {
      // Serialized after the migration: the old build retries and succeeds.
      oldBuildWrite.run(newestLegacyBytes, "c-race");
    }

    const raw = readRefColumns(dbA, "conversations", "c-race").backend_ref!;
    const parsed = JSON.parse(raw) as {
      backend: string;
      ref?: string;
      threadId?: string;
    };
    // The newest ref wins regardless of which side of the write lock the old
    // build landed on: bytes are either the old build's legacy shape
    // (serialized after the migration commits) or the migration's canonical
    // shape (the old build's write landed before the scan and was rewritten).
    // Either way the handle is `thr-new`.
    expect(parsed.backend).toBe("codex");
    expect(parsed.ref ?? parsed.threadId).toBe("thr-new");
  });
});
