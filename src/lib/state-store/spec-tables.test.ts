import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _createTestDb, _createTestDbAtPath } from "./state-db";

type Db = InstanceType<typeof Database>;

const SPEC_TABLES = [
  "specs",
  "spec_aliases",
  "spec_counters",
  "spec_elements",
  "spec_revisions",
  "spec_element_versions",
  "spec_approvals",
  "spec_gate_admissions",
  "spec_questions",
  "spec_assumptions",
  "spec_comments",
  "spec_evidence",
  "spec_proof_verdicts",
  "spec_waivers",
  "spec_criterion_dispositions",
  "spec_task_claims",
  "spec_executions",
  "spec_links",
  "spec_events",
] as const;

function tableNames(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function primaryKeyColumns(db: Db, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as {
    name: string;
    pk: number;
  }[];
  return rows
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

function uniqueIndexColumnSets(db: Db, table: string): string[][] {
  const indexes = db.pragma(`index_list(${table})`) as {
    name: string;
    unique: number;
  }[];
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) => {
      const columns = db.pragma(`index_info(${index.name})`) as {
        name: string;
        seqno: number;
      }[];
      return columns
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name);
    });
}

describe("native SDD schema floor", () => {
  const openDbs: Db[] = [];
  let tempDir: string | undefined;

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates all 19 spec tables on a fresh in-memory database", () => {
    const db = _createTestDb({ inMemory: true });
    openDbs.push(db);

    const names = tableNames(db);
    for (const table of SPEC_TABLES) expect(names.has(table)).toBe(true);
  });

  it("enforces the designed uniqueness and composite primary keys", () => {
    const db = _createTestDb({ inMemory: true });
    openDbs.push(db);

    expect(uniqueIndexColumnSets(db, "specs")).toContainEqual([
      "project_path",
      "slug",
    ]);
    expect(uniqueIndexColumnSets(db, "spec_revisions")).toContainEqual([
      "spec_id",
      "number",
    ]);
    expect(primaryKeyColumns(db, "spec_aliases")).toEqual([
      "project_path",
      "slug",
    ]);
    expect(primaryKeyColumns(db, "spec_counters")).toEqual([
      "spec_id",
      "scope_key",
    ]);
    expect(primaryKeyColumns(db, "spec_element_versions")).toEqual([
      "revision_id",
      "element_id",
    ]);
    expect(primaryKeyColumns(db, "spec_criterion_dispositions")).toEqual([
      "execution_id",
      "criterion_element_id",
    ]);
  });

  it("is a no-op across concurrent and repeated opens of an existing database", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-spec-floor-test-"));
    const dbPath = path.join(tempDir, "command-center.db");

    const first = _createTestDbAtPath(dbPath);
    openDbs.push(first);
    const concurrent = _createTestDbAtPath(dbPath);
    openDbs.push(concurrent);

    const concurrentTableNames = tableNames(concurrent);
    for (const table of SPEC_TABLES) {
      expect(concurrentTableNames.has(table)).toBe(true);
    }

    concurrent.close();
    openDbs.splice(openDbs.indexOf(concurrent), 1);
    const repeated = _createTestDbAtPath(dbPath);
    openDbs.push(repeated);
    const repeatedTableNames = tableNames(repeated);
    for (const table of SPEC_TABLES) {
      expect(repeatedTableNames.has(table)).toBe(true);
    }
  });
});
