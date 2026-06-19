import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createMigrator, runMigrations } from "./migrator";
import { _createTestDb } from "./state-db";
import type { StateMigration } from "./migrations/types";

type Db = InstanceType<typeof Database>;

const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function freshDb(): Db {
  const db = _createTestDb({ inMemory: true });
  openDbs.push(db);
  return db;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function ledgerNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM applied_migrations ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("state-store migrator runner", () => {
  it("runs pending migrations in order and records each in the ledger", async () => {
    const db = freshDb();
    const ran: string[] = [];
    const sample: StateMigration[] = [
      { name: "0001-a", up: async () => void ran.push("a") },
      { name: "0002-b", up: async () => void ran.push("b") },
    ];

    const applied = await runMigrations({ db, configDir: null }, sample);

    expect(applied).toEqual(["0001-a", "0002-b"]);
    expect(ran).toEqual(["a", "b"]);
    expect(ledgerNames(db)).toEqual(["0001-a", "0002-b"]);
  });

  it("is idempotent: a second run applies nothing and does not re-execute up", async () => {
    const db = freshDb();
    let runs = 0;
    const sample: StateMigration[] = [
      { name: "0001-a", up: async () => void runs++ },
    ];

    await runMigrations({ db, configDir: null }, sample);
    const secondRun = await runMigrations({ db, configDir: null }, sample);

    expect(secondRun).toEqual([]);
    expect(runs).toBe(1);
    expect(ledgerNames(db)).toEqual(["0001-a"]);
  });

  it("only runs migrations absent from the ledger when new ones are appended", async () => {
    const db = freshDb();
    const ran: string[] = [];
    const first: StateMigration[] = [
      { name: "0001-a", up: async () => void ran.push("a") },
    ];
    const extended: StateMigration[] = [
      ...first,
      { name: "0002-b", up: async () => void ran.push("b") },
    ];

    await runMigrations({ db, configDir: null }, first);
    const applied = await runMigrations({ db, configDir: null }, extended);

    expect(applied).toEqual(["0002-b"]);
    expect(ran).toEqual(["a", "b"]);
    expect(ledgerNames(db)).toEqual(["0001-a", "0002-b"]);
  });

  it("reverting a migration removes it from the ledger and re-runs it later", async () => {
    const db = freshDb();
    const events: string[] = [];
    const sample: StateMigration[] = [
      {
        name: "0001-a",
        up: async () => void events.push("up"),
        down: async () => void events.push("down"),
      },
    ];

    const migrator = createMigrator({ db, configDir: null }, sample);
    await migrator.up();
    await migrator.down();

    expect(ledgerNames(db)).toEqual([]);
    expect(events).toEqual(["up", "down"]);

    const reapplied = await runMigrations({ db, configDir: null }, sample);
    expect(reapplied).toEqual(["0001-a"]);
    expect(ledgerNames(db)).toEqual(["0001-a"]);
  });
});

describe("0001-drop-legacy-roadmap-items (production registry)", () => {
  it("drops the legacy roadmap_items table and index when present", async () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, project_path TEXT);
      CREATE INDEX idx_roadmap_items_project ON roadmap_items(project_path);
    `);
    expect(tableExists(db, "roadmap_items")).toBe(true);

    const applied = await runMigrations({ db, configDir: null });

    expect(applied).toContain("0001-drop-legacy-roadmap-items");
    expect(tableExists(db, "roadmap_items")).toBe(false);
  });

  it("is a no-op on a fresh DB that never had the table, but still records the ledger", async () => {
    const db = freshDb();
    expect(tableExists(db, "roadmap_items")).toBe(false);

    const applied = await runMigrations({ db, configDir: null });

    expect(applied).toContain("0001-drop-legacy-roadmap-items");
    expect(ledgerNames(db)).toContain("0001-drop-legacy-roadmap-items");
    expect(tableExists(db, "roadmap_items")).toBe(false);
  });
});
