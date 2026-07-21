import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createConversationsRepo } from "./conversations-repo";
import { createSessionsRepo } from "./sessions-repo";
import { readAllForStartup, readAllForStartupFromDb } from "./startup-reader";

type Db = InstanceType<typeof Database>;

/**
 * `readAllForStartup` is the ONE honest whole-state read left after the
 * focused-first migration: server startup rehydration flattens every persisted
 * conversation to decide which resume. Design 1 moved the machine snapshot into
 * the `conversation_machine_snapshots` sidecar, so this enumeration must NOT
 * drag the snapshot bytes — rehydration reads each conversation's sidecar row
 * on demand. These tests prove (a) the enumeration selects no snapshot column,
 * and (b) it still assembles the session/conversation tree rehydration walks.
 */

const PROJECT_PATH = "/repo";
const SESSION_NAME = "feat";

let db: Db;
const openDbs: Db[] = [];

function freshDb(): Db {
  const created = _createTestDb({ inMemory: true });
  openDbs.push(created);
  return created;
}

beforeEach(() => {
  db = freshDb();
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO sessions (
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
  // A conversation row that still carries a legacy snapshot blob on the parent
  // row (migration nulls these lazily; the read boundary is the durable guard).
  db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, status, prompt_count,
       created_at, last_activity_at, source, archived, agent_backend,
       unread, machine_snapshot
     ) VALUES (?, ?, ?, 'awaiting', 1, ?, ?, 'cc', 0, 'claude', 0, ?)`,
  ).run(
    "conv-1",
    PROJECT_PATH,
    SESSION_NAME,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    JSON.stringify({ value: "idle", context: { big: "x".repeat(2000) } }),
  );
});

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe("readAllForStartup", () => {
  it("assembles the project/session/conversation tree rehydration walks", () => {
    const state = readAllForStartup({
      sessions: createSessionsRepo(db),
      conversations: createConversationsRepo(db),
    });

    const session = state.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session).toBeDefined();
    expect(session?.worktreePath).toBe(
      `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    );
    expect(session?.conversations.map((c) => c.id)).toEqual(["conv-1"]);
  });

  it("readAllForStartupFromDb builds its own cold repos over the db and assembles the same tree", () => {
    // The startup-owned composition (the only production entry point) constructs
    // its repos from the passed db — no StateStore instance involved — and reads
    // the committed rows.
    const state = readAllForStartupFromDb(db);
    const session = state.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.conversations.map((c) => c.id)).toEqual(["conv-1"]);
    expect(session?.conversations[0]).not.toHaveProperty("machineSnapshot");
  });

  it("never surfaces the machine snapshot on an enumerated conversation", () => {
    const state = readAllForStartup({
      sessions: createSessionsRepo(db),
      conversations: createConversationsRepo(db),
    });
    const conversation =
      state.projects[PROJECT_PATH]?.sessions[SESSION_NAME]?.conversations[0];
    expect(conversation).not.toHaveProperty("machineSnapshot");
  });

  it("selects no snapshot column and no SELECT * across the startup enumeration", () => {
    const captured: string[] = [];
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (
      sql: string,
    ) => {
      captured.push(sql);
      return original(sql);
    };
    try {
      // Repos compile their read statements at construction, so build them
      // inside the capture, then run the enumeration the reader relies on.
      const reader = {
        sessions: createSessionsRepo(db),
        conversations: createConversationsRepo(db),
      };
      readAllForStartup(reader);
    } finally {
      (db as unknown as { prepare: typeof original }).prepare = original;
    }

    const selects = captured.filter((sql) => /^\s*SELECT/i.test(sql));
    // `\b` after the table name excludes `conversation_machine_snapshots`.
    const enumerationSelects = selects.filter((sql) =>
      /FROM (conversations|sessions)\b/.test(sql),
    );
    // The guard is not vacuous — the enumeration really compiled its reads.
    expect(enumerationSelects.length).toBeGreaterThanOrEqual(2);

    // The snapshot lived on the conversation rows: no startup enumeration read
    // may name that column.
    for (const sql of enumerationSelects) {
      expect(
        sql,
        `startup read leaks the snapshot column:\n${sql}`,
      ).not.toMatch(/machine_snapshot/);
    }

    // A `SELECT *` on the snapshot-bearing `conversations` table would drag the
    // (still-present) blob column, so the conversation reads must project
    // explicit columns. (Sessions carry no snapshot column; a wildcard there is
    // harmless and out of scope.)
    const conversationSelects = enumerationSelects.filter((sql) =>
      /FROM conversations\b/.test(sql),
    );
    expect(conversationSelects.length).toBeGreaterThanOrEqual(1);
    for (const sql of conversationSelects) {
      expect(
        sql,
        `startup conversation read uses SELECT *:\n${sql}`,
      ).not.toMatch(/SELECT\s+\*/i);
    }
  });
});
