import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { runMigrations } from "../migrator";
import { _createTestDb } from "../state-db";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo";
const SESSION_NAME = "feature-a";

let db: Db;
const openDbs: Db[] = [];

function freshDb(): Db {
  const created = _createTestDb({ inMemory: true });
  openDbs.push(created);
  return created;
}

/** A snapshot carrying the two production offenders the projection drops. */
function fatSnapshot(conversationId: string): object {
  const bigBlocks = Array.from({ length: 200 }, (_, i) => ({
    type: "text",
    text: "x".repeat(500) + i,
  }));
  return {
    status: "active",
    value: { waitingForInput: {} },
    context: {
      _schemaVersion: 1,
      conversationId,
      backendRef: { backend: "claude", ref: "sess-abc" },
      pendingQuestion: { questionId: "q1", questions: [] },
      lastResult: {
        costUsd: 0.5,
        error: null,
        contentBlocks: bigBlocks,
        transcript: bigBlocks,
      },
    },
    children: { "0.conversation.executing": { snapshot: { blob: bigBlocks } } },
  };
}

function seedSessionConversation(
  conversationId: string,
  machineSnapshot: object | string | null,
): void {
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT OR IGNORE INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, status, created_at, last_activity_at,
       machine_snapshot
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId,
    PROJECT_PATH,
    SESSION_NAME,
    "awaiting",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    machineSnapshot === null
      ? null
      : typeof machineSnapshot === "string"
        ? machineSnapshot
        : JSON.stringify(machineSnapshot),
  );
}

function seedProjectConversation(
  conversationId: string,
  machineSnapshot: object | null,
): void {
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO project_conversations (
       id, project_path, status, created_at, last_activity_at, machine_snapshot
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId,
    PROJECT_PATH,
    "awaiting",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    machineSnapshot === null ? null : JSON.stringify(machineSnapshot),
  );
}

function readSidecar(
  owner: "session" | "project",
  conversationId: string,
): { snapshot_json: string } | undefined {
  return db
    .prepare(
      `SELECT snapshot_json FROM conversation_machine_snapshots
        WHERE owner = ? AND conversation_id = ?`,
    )
    .get(owner, conversationId) as { snapshot_json: string } | undefined;
}

function readSourceColumn(
  table: "conversations" | "project_conversations",
  conversationId: string,
): string | null {
  const row = db
    .prepare(`SELECT machine_snapshot AS blob FROM ${table} WHERE id = ?`)
    .get(conversationId) as { blob: string | null };
  return row.blob;
}

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe("0007-move-machine-snapshots-to-sidecar", () => {
  it("moves session + project snapshots into the sidecar under the right owner, applying the projection", async () => {
    seedSessionConversation("conv-s", fatSnapshot("conv-s"));
    seedProjectConversation("conv-p", fatSnapshot("conv-p"));

    await runMigrations({ db, configDir: null });

    for (const [owner, id] of [
      ["session", "conv-s"],
      ["project", "conv-p"],
    ] as const) {
      const sidecar = readSidecar(owner, id);
      expect(sidecar, `${owner}:${id} sidecar row`).toBeDefined();
      const projected = JSON.parse(sidecar!.snapshot_json) as {
        children?: unknown;
        context: { lastResult: Record<string, unknown> };
      };
      // The projection dropped the two large carriers ...
      expect(projected.children).toBeUndefined();
      expect(projected.context.lastResult).not.toHaveProperty("contentBlocks");
      expect(projected.context.lastResult).not.toHaveProperty("transcript");
      // ... while keeping the resume-relevant scalars.
      expect(projected.context.lastResult.costUsd).toBe(0.5);
    }
  });

  it("nulls the source machine_snapshot column on both parents after moving", async () => {
    seedSessionConversation("conv-s", fatSnapshot("conv-s"));
    seedProjectConversation("conv-p", fatSnapshot("conv-p"));

    await runMigrations({ db, configDir: null });

    expect(readSourceColumn("conversations", "conv-s")).toBeNull();
    expect(readSourceColumn("project_conversations", "conv-p")).toBeNull();
  });

  it("leaves conversations without a snapshot untouched and creates no sidecar row", async () => {
    seedSessionConversation("conv-empty", null);

    await runMigrations({ db, configDir: null });

    expect(readSidecar("session", "conv-empty")).toBeUndefined();
    expect(readSourceColumn("conversations", "conv-empty")).toBeNull();
  });

  it("clears an unparseable blob so the migration converges (no snapshot payload remains)", async () => {
    seedSessionConversation("conv-bad", "not json");

    await runMigrations({ db, configDir: null });

    // An unparseable blob has no resumable shape, so no sidecar row is created —
    // but the source column must still be cleared, or the migration never
    // converges: the parent row would carry a snapshot payload forever and the
    // idempotency guard (`WHERE machine_snapshot IS NOT NULL`) would re-scan it
    // on every startup.
    expect(readSidecar("session", "conv-bad")).toBeUndefined();
    expect(readSourceColumn("conversations", "conv-bad")).toBeNull();
  });

  it("clears a non-object (JSON array / scalar) blob on both parents", async () => {
    seedSessionConversation("conv-arr", "[1,2,3]");
    seedProjectConversation("conv-scalar", null);
    // Seed a raw scalar directly (seedProjectConversation JSON-encodes objects).
    db.prepare(
      `UPDATE project_conversations SET machine_snapshot = '42' WHERE id = ?`,
    ).run("conv-scalar");

    await runMigrations({ db, configDir: null });

    expect(readSidecar("session", "conv-arr")).toBeUndefined();
    expect(readSidecar("project", "conv-scalar")).toBeUndefined();
    expect(readSourceColumn("conversations", "conv-arr")).toBeNull();
    expect(readSourceColumn("project_conversations", "conv-scalar")).toBeNull();
  });

  it("is idempotent: a second run processes nothing and does not duplicate", async () => {
    seedSessionConversation("conv-s", fatSnapshot("conv-s"));

    await runMigrations({ db, configDir: null });
    const firstJson = readSidecar("session", "conv-s")?.snapshot_json;

    await runMigrations({ db, configDir: null });
    const secondJson = readSidecar("session", "conv-s")?.snapshot_json;

    expect(secondJson).toBe(firstJson);
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_machine_snapshots
          WHERE owner = 'session' AND conversation_id = 'conv-s'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
