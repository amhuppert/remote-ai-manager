import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createMigrator, runMigrations } from "./migrator";
import { RETIRED_MIGRATION_NAMES } from "./migration-history";
import { _createTestDb, _createTestDbAtPath } from "./state-db";
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

const RETIRED = new Set<string>(RETIRED_MIGRATION_NAMES);

/** The ledger rows this file's own migrations wrote, without the stamped history. */
function ledgerNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM applied_migrations ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name).filter((name) => !RETIRED.has(name));
}

describe("state-store migrator runner", () => {
  it("ignores the retired ledger when the current registry is empty", async () => {
    const db = freshDb();

    await expect(runMigrations({ db, configDir: null }, [])).resolves.toEqual(
      [],
    );
  });

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

describe("state-store migrator failure and replay", () => {
  it("propagates a failing migration, keeps it out of the ledger, and retries it on the next run", async () => {
    const db = freshDb();
    let attempts = 0;
    const flaky: StateMigration[] = [
      { name: "0001-ok", up: async () => {} },
      {
        name: "0002-flaky",
        up: async () => {
          attempts++;
          if (attempts === 1) throw new Error("simulated migration crash");
        },
      },
    ];

    await expect(runMigrations({ db, configDir: null }, flaky)).rejects.toThrow(
      /simulated migration crash/,
    );
    // Migrations before the failure are ledgered; the failed one is not, so
    // the next startup retries exactly the failed migration.
    expect(ledgerNames(db)).toEqual(["0001-ok"]);

    const retried = await runMigrations({ db, configDir: null }, flaky);
    expect(retried).toEqual(["0002-flaky"]);
    expect(attempts).toBe(2);
    expect(ledgerNames(db)).toEqual(["0001-ok", "0002-flaky"]);
  });

  it("replays a migration that crashed after up but before the ledger write, converging idempotently", async () => {
    const db = freshDb();
    db.exec("CREATE TABLE IF NOT EXISTS replay_probe (id TEXT PRIMARY KEY)");
    const migration: StateMigration = {
      name: "0001-replay",
      up: async ({ context }) => {
        context.db
          .prepare("INSERT OR IGNORE INTO replay_probe (id) VALUES ('row')")
          .run();
      },
    };

    // Crash simulation: up completed but the process died before Umzug's
    // separate logMigration step recorded it in the ledger.
    await migration.up({
      name: migration.name,
      context: { db, configDir: null },
    });
    expect(ledgerNames(db)).toEqual([]);

    const applied = await runMigrations({ db, configDir: null }, [migration]);

    expect(applied).toEqual(["0001-replay"]);
    expect(ledgerNames(db)).toEqual(["0001-replay"]);
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM replay_probe")
      .get() as { n: number };
    expect(n).toBe(1);
  });
});

describe("state-store migrator racing workers", () => {
  // Two server workers can open the same file-backed DB and run migrations
  // concurrently. There is deliberately no cross-process mutex: safety comes
  // from (1) every migration being idempotent — an overlapping worker replays
  // the up body exactly like a crash-replay does — and (2) the ledger insert
  // being `INSERT OR IGNORE` on the `name` primary key, so the migration is
  // recorded exactly once and later runs see it as applied. This test pins
  // that contract with two real connections to one file-backed DB, forcing
  // the worst-case interleaving where both workers compute `pending` before
  // either applies.
  it("two concurrent runs converge: one ledger row, no duplicate data, both runs resolve", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-migrator-race-"));
    const dbPath = path.join(dir, "command-center.db");
    const dbA = _createTestDbAtPath(dbPath);
    openDbs.push(dbA);
    const dbB = _createTestDbAtPath(dbPath);
    openDbs.push(dbB);
    dbA.exec("CREATE TABLE IF NOT EXISTS race_probe (id TEXT PRIMARY KEY)");

    let upStarts = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const migrationFor = (workerDb: Db): StateMigration => ({
      name: "0001-race",
      up: async () => {
        upStarts++;
        if (upStarts === 2) openGate();
        // Hold both workers here until each has passed its pending() check,
        // so neither ledger read can see the other's completed run.
        await gate;
        workerDb
          .prepare("INSERT OR IGNORE INTO race_probe (id) VALUES ('row')")
          .run();
      },
    });

    const [appliedA, appliedB] = await Promise.all([
      runMigrations({ db: dbA, configDir: null }, [migrationFor(dbA)]),
      runMigrations({ db: dbB, configDir: null }, [migrationFor(dbB)]),
    ]);

    // Both workers executed the up body — the idempotence contract absorbs
    // the overlap, exactly like a crash-replay.
    expect(upStarts).toBe(2);
    expect(appliedA).toEqual(["0001-race"]);
    expect(appliedB).toEqual(["0001-race"]);
    expect(ledgerNames(dbA)).toEqual(["0001-race"]);
    const { n } = dbA.prepare("SELECT COUNT(*) AS n FROM race_probe").get() as {
      n: number;
    };
    expect(n).toBe(1);

    // A worker starting after the race sees the migration as applied.
    await expect(
      runMigrations({ db: dbB, configDir: null }, [migrationFor(dbB)]),
    ).resolves.toEqual([]);
  });
});
