import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { jobRecordParkedMerge } from "./0029-job-record-parked-merge";

type Db = InstanceType<typeof Database>;

let rawDb: Db | null = null;
let fixture: PersistenceFixture | null = null;

afterEach(() => {
  rawDb?.close();
  rawDb = null;
  fixture?.close();
  fixture = null;
});

async function runMigration(db: Db): Promise<void> {
  await jobRecordParkedMerge.up({
    name: jobRecordParkedMerge.name,
    context: { db, configDir: null },
  });
}

/**
 * A database from before the parked-merge columns, carrying a job that parked a
 * commit while the bookkeeping still lived only in the in-memory registry.
 */
const LEGACY_DDL = `
  CREATE TABLE job_records (
    job_id         TEXT PRIMARY KEY,
    job_type       TEXT NOT NULL,
    status         TEXT NOT NULL,
    project_name   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    branch_name    TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    completed_at   TEXT,
    merge_hash     TEXT,
    commit_hash    TEXT,
    conflict_count INTEGER,
    conflict_files TEXT,
    error_message  TEXT,
    owner_pid      INTEGER,
    execution_id   TEXT,
    final_publish  INTEGER NOT NULL DEFAULT 0,
    candidate_validation TEXT
  );
  INSERT INTO job_records (
    job_id, job_type, status, project_name, session_name, branch_name,
    started_at, completed_at, final_publish
  ) VALUES (
    'job-parked', 'merge', 'ready-to-land', 'proj', 's1', 'csm/s1',
    '2026-08-15 09:00:00', '2026-08-15 09:04:00', 0
  );
`;

const PARKED_COLUMNS = [
  "parked_ref",
  "prepared_sha",
  "expected_target_sha",
  "finalize_session_on_publish",
  "resolution_context",
];

function columnNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function parkedBookkeepingOf(db: Db, jobId: string): unknown {
  return db
    .prepare(
      `SELECT parked_ref, prepared_sha, expected_target_sha,
              finalize_session_on_publish, resolution_context
         FROM job_records WHERE job_id = ?`,
    )
    .get(jobId);
}

describe("0029-job-record-parked-merge", () => {
  it("adds the parked-merge columns to a legacy table and accepts a land re-entry's bookkeeping", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    for (const column of PARKED_COLUMNS) {
      expect(columnNames(rawDb, "job_records")).not.toContain(column);
    }

    await runMigration(rawDb);

    rawDb
      .prepare(
        `UPDATE job_records SET
           parked_ref = 'refs/cc-merges/job-parked',
           prepared_sha = 'prepared-sha',
           expected_target_sha = 'target-sha',
           finalize_session_on_publish = 0,
           resolution_context = 'kept the rename'
         WHERE job_id = 'job-parked'`,
      )
      .run();
    expect(parkedBookkeepingOf(rawDb, "job-parked")).toEqual({
      parked_ref: "refs/cc-merges/job-parked",
      prepared_sha: "prepared-sha",
      expected_target_sha: "target-sha",
      finalize_session_on_publish: 0,
      resolution_context: "kept the rename",
    });
  });

  it("leaves jobs that predate the columns with no parked-merge bookkeeping", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);

    await runMigration(rawDb);

    // The registry held these facts and died with the process; inventing a
    // parked ref here would point a land re-entry at a commit nobody parked.
    expect(parkedBookkeepingOf(rawDb, "job-parked")).toEqual({
      parked_ref: null,
      prepared_sha: null,
      expected_target_sha: null,
      finalize_session_on_publish: null,
      resolution_context: null,
    });
    expect(
      rawDb
        .prepare(
          "SELECT status, completed_at FROM job_records WHERE job_id = 'job-parked'",
        )
        .get(),
    ).toEqual({ status: "ready-to-land", completed_at: "2026-08-15 09:04:00" });
  });

  it("is idempotent on replay and preserves recorded bookkeeping", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    await runMigration(rawDb);
    rawDb
      .prepare(
        "UPDATE job_records SET parked_ref = ?, prepared_sha = ? WHERE job_id = 'job-parked'",
      )
      .run("refs/cc-merges/job-parked", "prepared-sha");

    await runMigration(rawDb);

    expect(parkedBookkeepingOf(rawDb, "job-parked")).toMatchObject({
      parked_ref: "refs/cc-merges/job-parked",
      prepared_sha: "prepared-sha",
    });
  });

  it("is a no-op on a floor-created database that already carries the columns", async () => {
    fixture = createPersistenceFixture();
    for (const column of PARKED_COLUMNS) {
      expect(columnNames(fixture.db, "job_records")).toContain(column);
    }

    await runMigration(fixture.db);

    for (const column of PARKED_COLUMNS) {
      expect(columnNames(fixture.db, "job_records")).toContain(column);
    }
  });

  it("skips a database that predates the job_records table entirely", async () => {
    rawDb = new Database(":memory:");

    await expect(runMigration(rawDb)).resolves.toBeUndefined();
  });
});
