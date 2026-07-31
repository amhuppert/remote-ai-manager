import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { freezeSpecExecutionLaunch } from "./0010-freeze-spec-execution-launch";

let db: InstanceType<typeof Database> | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

async function runMigration(): Promise<void> {
  if (db === null) throw new Error("database is unavailable");
  await freezeSpecExecutionLaunch.up({
    name: freezeSpecExecutionLaunch.name,
    context: { db, configDir: null },
  });
}

describe("0010-freeze-spec-execution-launch", () => {
  it.each([
    '{"preset":"exploratory"}',
    '{"preset":"contract-bearing","overrides":{"execution_start":"off"}}',
  ])(
    "adds nullable launch-contract columns without inferring history from live policy",
    async (policy) => {
      db = new Database(":memory:");
      db.exec(`
        CREATE TABLE specs (
          id TEXT PRIMARY KEY,
          gate_policy_json TEXT NOT NULL
        );
        CREATE TABLE spec_executions (
          id TEXT PRIMARY KEY,
          spec_id TEXT NOT NULL,
          workflow_definition_id TEXT NOT NULL
        );
      `);
      db.prepare("INSERT INTO specs (id, gate_policy_json) VALUES (?, ?)").run(
        "spec-1",
        policy,
      );
      db.prepare(
        `INSERT INTO spec_executions (
           id, spec_id, workflow_definition_id
         ) VALUES (?, ?, ?)`,
      ).run("execution-1", "spec-1", "definition-1");

      await runMigration();
      await runMigration();

      expect(
        db
          .prepare(
            `SELECT execution_start_dial, workflow_definition_revision
             FROM spec_executions
             WHERE id = ?`,
          )
          .get("execution-1"),
      ).toEqual({
        execution_start_dial: null,
        workflow_definition_revision: null,
      });
    },
  );
});
