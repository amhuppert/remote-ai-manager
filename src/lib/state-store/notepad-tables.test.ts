import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb, _createTestDbAtPath } from "./state-db";

type Db = InstanceType<typeof Database>;

function tableNames(db: Db): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnNames(db: Db, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.map((c) => c.name);
}

function indexNames(db: Db, table: string): string[] {
  const idx = db.pragma(`index_list(${table})`) as { name: string }[];
  return idx.map((i) => i.name);
}

function insertProject(db: Db, rootPath: string): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(rootPath);
}

function insertNotepad(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "n-1",
    scope: "global",
    project_path: null,
    name: "Scratch",
    content: "# Scratch",
    revision: 1,
    write_mode: "full-edit",
    pinned: 0,
    archived: 0,
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO notepads
       (id, scope, project_path, name, content, revision, write_mode, pinned, archived, created_at, updated_at)
     VALUES
       (@id, @scope, @project_path, @name, @content, @revision, @write_mode, @pinned, @archived, @created_at, @updated_at)`,
  ).run(row);
}

function insertRevision(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "r-1",
    notepad_id: "n-1",
    revision: 1,
    content: "# Scratch",
    author_kind: "user",
    author_conversation_id: null,
    origin: "create",
    base_revision: null,
    restored_from_revision: null,
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO notepad_revisions
       (id, notepad_id, revision, content, author_kind, author_conversation_id,
        origin, base_revision, restored_from_revision, created_at)
     VALUES
       (@id, @notepad_id, @revision, @content, @author_kind, @author_conversation_id,
        @origin, @base_revision, @restored_from_revision, @created_at)`,
  ).run(row);
}

function insertImage(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "img-1",
    notepad_id: "n-1",
    file_name: "screenshot.png",
    media_type: "image/png",
    size_bytes: 1024,
    sha256: "deadbeef",
    snapshot_key: "notepad-content/n-1/img-1/screenshot.png",
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO notepad_images
       (id, notepad_id, file_name, media_type, size_bytes, sha256, snapshot_key, created_at)
     VALUES
       (@id, @notepad_id, @file_name, @media_type, @size_bytes, @sha256, @snapshot_key, @created_at)`,
  ).run(row);
}

function insertComment(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "c-1",
    notepad_id: "n-1",
    section_id: "scratch",
    heading_label: "Scratch",
    line: 1,
    char_start: 0,
    char_end: 7,
    quote: "Scratch",
    prefix: "",
    suffix: "",
    notepad_revision: 1,
    body: "Name the owner.",
    status: "open",
    author_kind: "user",
    author_conversation_id: null,
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO notepad_comments
       (id, notepad_id, section_id, heading_label, line, char_start, char_end,
        quote, prefix, suffix, notepad_revision, body, status, author_kind,
        author_conversation_id, created_at, updated_at, resolved_at)
     VALUES
       (@id, @notepad_id, @section_id, @heading_label, @line, @char_start,
        @char_end, @quote, @prefix, @suffix, @notepad_revision, @body, @status,
        @author_kind, @author_conversation_id, @created_at, @updated_at,
        @resolved_at)`,
  ).run(row);
}

function insertReply(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "cr-1",
    comment_id: "c-1",
    body: "Addressed.",
    author_kind: "agent",
    author_conversation_id: "conv-1",
    created_at: "2026-08-28T00:05:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO notepad_comment_replies
       (id, comment_id, body, author_kind, author_conversation_id, created_at)
     VALUES
       (@id, @comment_id, @body, @author_kind, @author_conversation_id,
        @created_at)`,
  ).run(row);
}

describe("notepad tables DDL", () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates all three notepad tables on a fresh in-memory DB", () => {
    db = _createTestDb({ inMemory: true });
    const tables = tableNames(db);
    expect(tables).toContain("notepads");
    expect(tables).toContain("notepad_revisions");
    expect(tables).toContain("notepad_images");
  });

  it("creates the documented columns", () => {
    db = _createTestDb({ inMemory: true });
    expect(columnNames(db, "notepads")).toEqual([
      "id",
      "scope",
      "project_path",
      "name",
      "content",
      "revision",
      "write_mode",
      "pinned",
      "archived",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(db, "notepad_revisions")).toEqual([
      "id",
      "notepad_id",
      "revision",
      "content",
      "author_kind",
      "author_conversation_id",
      "origin",
      "base_revision",
      "restored_from_revision",
      "created_at",
    ]);
    expect(columnNames(db, "notepad_images")).toEqual([
      "id",
      "notepad_id",
      "file_name",
      "media_type",
      "size_bytes",
      "sha256",
      "snapshot_key",
      "created_at",
    ]);
  });

  it("creates the scoped-name unique index and the listing indexes", () => {
    db = _createTestDb({ inMemory: true });
    const notepadIdx = indexNames(db, "notepads");
    expect(notepadIdx).toContain("uq_notepads_scope_name");
    expect(notepadIdx).toContain("idx_notepads_scope_listing");

    expect(indexNames(db, "notepad_images")).toContain(
      "idx_notepad_images_notepad_created",
    );
  });

  it("defaults write_mode to full-edit so a created notepad is agent-writable", () => {
    db = _createTestDb({ inMemory: true });
    db.prepare(
      `INSERT INTO notepads (id, scope, name, content, revision, created_at, updated_at)
       VALUES ('n-default', 'global', 'Defaulted', '', 1, '2026-08-27', '2026-08-27')`,
    ).run();
    const row = db
      .prepare(`SELECT write_mode FROM notepads WHERE id = 'n-default'`)
      .get() as { write_mode: string };
    expect(row.write_mode).toBe("full-edit");
  });

  describe("CHECK constraints", () => {
    it("rejects an unknown scope and an unknown write mode", () => {
      db = _createTestDb({ inMemory: true });
      expect(() => insertNotepad(db!, { scope: "session" })).toThrow(/CHECK/);
      expect(() => insertNotepad(db!, { write_mode: "read-write" })).toThrow(
        /CHECK/,
      );
    });

    it("ties project_path presence to project scope in both directions", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      // Global scope may not carry a project path.
      expect(() =>
        insertNotepad(db!, { scope: "global", project_path: "/repo" }),
      ).toThrow(/CHECK/);
      // Project scope requires one.
      expect(() =>
        insertNotepad(db!, { scope: "project", project_path: null }),
      ).toThrow(/CHECK/);
      insertNotepad(db, { scope: "project", project_path: "/repo" });
    });

    it("rejects an unknown revision author kind and origin", () => {
      db = _createTestDb({ inMemory: true });
      insertNotepad(db);
      expect(() => insertRevision(db!, { author_kind: "system" })).toThrow(
        /CHECK/,
      );
      expect(() => insertRevision(db!, { origin: "compact" })).toThrow(/CHECK/);
    });
  });

  describe("scoped name uniqueness", () => {
    it("rejects a duplicate name within the global scope", () => {
      db = _createTestDb({ inMemory: true });
      insertNotepad(db);
      expect(() => insertNotepad(db!, { id: "n-2" })).toThrow(/UNIQUE/);
    });

    it("rejects a duplicate name within one project scope", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertNotepad(db, { scope: "project", project_path: "/repo" });
      expect(() =>
        insertNotepad(db!, {
          id: "n-2",
          scope: "project",
          project_path: "/repo",
        }),
      ).toThrow(/UNIQUE/);
    });

    it("allows the same name across scopes and across projects", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertProject(db, "/other");
      insertNotepad(db);
      insertNotepad(db, {
        id: "n-2",
        scope: "project",
        project_path: "/repo",
      });
      insertNotepad(db, {
        id: "n-3",
        scope: "project",
        project_path: "/other",
      });
      const count = db.prepare(`SELECT COUNT(*) AS n FROM notepads`).get() as {
        n: number;
      };
      expect(count.n).toBe(3);
    });
  });

  describe("revision uniqueness", () => {
    it("rejects a duplicate revision number for one notepad but allows it across notepads", () => {
      db = _createTestDb({ inMemory: true });
      insertNotepad(db);
      insertNotepad(db, { id: "n-2", name: "Other" });
      insertRevision(db);
      expect(() => insertRevision(db!, { id: "r-2" })).toThrow(/UNIQUE/);
      insertRevision(db, { id: "r-2", notepad_id: "n-2" });
    });
  });

  describe("foreign keys", () => {
    it("cascades a project delete to its project-scoped notepads and their children", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertNotepad(db, { scope: "project", project_path: "/repo" });
      insertRevision(db);
      insertImage(db);

      db.prepare(`DELETE FROM projects WHERE root_path = '/repo'`).run();

      for (const table of ["notepads", "notepad_revisions", "notepad_images"]) {
        const count = db
          .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
          .get() as { n: number };
        expect(count.n).toBe(0);
      }
    });

    it("cascades a notepad delete to its revisions and images", () => {
      db = _createTestDb({ inMemory: true });
      insertNotepad(db);
      insertRevision(db);
      insertImage(db);

      db.prepare(`DELETE FROM notepads WHERE id = 'n-1'`).run();

      for (const table of ["notepad_revisions", "notepad_images"]) {
        const count = db
          .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
          .get() as { n: number };
        expect(count.n).toBe(0);
      }
    });

    it("keeps author_conversation_id free of any foreign key so deleting a conversation cannot erase history", () => {
      db = _createTestDb({ inMemory: true });
      insertNotepad(db);
      insertRevision(db, {
        author_kind: "agent",
        author_conversation_id: "conversation-that-never-existed",
        origin: "edit",
        base_revision: 1,
      });
      const row = db
        .prepare(
          `SELECT author_conversation_id FROM notepad_revisions WHERE id = 'r-1'`,
        )
        .get() as { author_conversation_id: string };
      expect(row.author_conversation_id).toBe(
        "conversation-that-never-existed",
      );
    });
  });

  it("is idempotent — reopening an already-initialized DB preserves the tables", () => {
    const fileDb = _createTestDb();
    const dbPath = fileDb.name;
    fileDb.close();

    db = _createTestDbAtPath(dbPath);
    const tables = tableNames(db);
    expect(tables).toContain("notepads");
    expect(tables).toContain("notepad_revisions");
    expect(tables).toContain("notepad_images");
  });
});

describe("notepad comment tables DDL", () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates both comment tables with the documented columns and indexes", () => {
    db = _createTestDb({ inMemory: true });
    const tables = tableNames(db);
    expect(tables).toContain("notepad_comments");
    expect(tables).toContain("notepad_comment_replies");

    expect(columnNames(db, "notepad_comments")).toEqual([
      "id",
      "notepad_id",
      "section_id",
      "heading_label",
      "line",
      "end_line",
      "end_section_id",
      "char_start",
      "char_end",
      "quote",
      "prefix",
      "suffix",
      "notepad_revision",
      "body",
      "status",
      "author_kind",
      "author_conversation_id",
      "created_at",
      "updated_at",
      "resolved_at",
    ]);
    expect(columnNames(db, "notepad_comment_replies")).toEqual([
      "id",
      "comment_id",
      "body",
      "author_kind",
      "author_conversation_id",
      "created_at",
    ]);

    expect(indexNames(db, "notepad_comments")).toContain(
      "idx_notepad_comments_notepad_status",
    );
    expect(indexNames(db, "notepad_comment_replies")).toContain(
      "idx_notepad_comment_replies_comment",
    );
  });

  it("rejects an unknown comment status and an unknown author kind", () => {
    db = _createTestDb({ inMemory: true });
    insertNotepad(db);
    expect(() => insertComment(db!, { status: "dismissed" })).toThrow(/CHECK/);
    expect(() => insertComment(db!, { author_kind: "system" })).toThrow(
      /CHECK/,
    );
    insertComment(db);
    expect(() => insertReply(db!, { author_kind: "system" })).toThrow(/CHECK/);
  });

  it("cascades a notepad delete to its comments and their replies", () => {
    db = _createTestDb({ inMemory: true });
    insertNotepad(db);
    insertComment(db);
    insertReply(db);

    db.prepare(`DELETE FROM notepads WHERE id = 'n-1'`).run();

    for (const table of ["notepad_comments", "notepad_comment_replies"]) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    }
  });

  it("cascades a project delete through its notepads to their comments", () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repo");
    insertNotepad(db, { scope: "project", project_path: "/repo" });
    insertComment(db);
    insertReply(db);

    db.prepare(`DELETE FROM projects WHERE root_path = '/repo'`).run();

    for (const table of ["notepad_comments", "notepad_comment_replies"]) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    }
  });

  it("keeps comment attribution free of any foreign key so deleting a conversation cannot erase a review", () => {
    db = _createTestDb({ inMemory: true });
    insertNotepad(db);
    insertComment(db, {
      author_kind: "agent",
      author_conversation_id: "conversation-that-never-existed",
    });
    insertReply(db, {
      author_conversation_id: "conversation-that-never-existed",
    });

    const comment = db
      .prepare(
        `SELECT author_conversation_id FROM notepad_comments WHERE id = 'c-1'`,
      )
      .get() as { author_conversation_id: string };
    const reply = db
      .prepare(
        `SELECT author_conversation_id FROM notepad_comment_replies WHERE id = 'cr-1'`,
      )
      .get() as { author_conversation_id: string };

    expect(comment.author_conversation_id).toBe(
      "conversation-that-never-existed",
    );
    expect(reply.author_conversation_id).toBe(
      "conversation-that-never-existed",
    );
  });

  it("refuses a comment on a notepad that does not exist", () => {
    db = _createTestDb({ inMemory: true });
    expect(() => insertComment(db!)).toThrow(/FOREIGN KEY/);
  });
});
