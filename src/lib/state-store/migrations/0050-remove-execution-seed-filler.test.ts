import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  publishSchemaCompatibilityBarrier,
  readSchemaCompatibilityBarrierVersion,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { removeExecutionSeedFiller } from "./0050-remove-execution-seed-filler";

function seedLegacyExecution(db: InstanceType<typeof Database>): string {
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT);
    CREATE TABLE graph_workflow_executions (execution_id TEXT, seed_definition_id TEXT, seed_definition_revision INTEGER, definition_json TEXT);
  `);
  const body = JSON.stringify({
    origin: { kind: "one_off" },
    seedDefinitionId: "one-off:legacy",
    seedDefinitionRevision: 1,
  });
  db.prepare("INSERT INTO graph_workflow_executions VALUES (?, ?, 1, ?)").run(
    "legacy",
    "one-off:legacy",
    body,
  );
  return body;
}

describe("0050-remove-execution-seed-filler", () => {
  it("publishes barrier 18 before writing incompatible seed bytes", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "cc-seed-barrier-"));
    const db = new Database(path.join(configDir, "command-center.db"));
    try {
      seedLegacyExecution(db);
      const barriersAtWrite: number[] = [];
      db.function("observe_barrier", () => {
        barriersAtWrite.push(readSchemaCompatibilityBarrierVersion(configDir));
        return 1;
      });
      db.exec(`CREATE TRIGGER observe_seed_write BEFORE UPDATE ON graph_workflow_executions
        BEGIN SELECT observe_barrier(); END;`);
      await removeExecutionSeedFiller.up({
        name: removeExecutionSeedFiller.name,
        context: { db, configDir },
      });
      expect(barriersAtWrite).toEqual([18]);
      expect(readSchemaCompatibilityBarrierVersion(configDir)).toBe(18);
    } finally {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it.each(["ledger", "barrier"] as const)(
    "refuses a future %s on an already-open connection before rewriting",
    async (witness) => {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "cc-seed-future-"));
      const db = new Database(path.join(configDir, "command-center.db"));
      try {
        const original = seedLegacyExecution(db);
        const futureVersion = KNOWN_SCHEMA_VERSION + 1;
        if (witness === "ledger") {
          db.prepare("INSERT INTO schema_migrations VALUES (?, 'future')").run(
            futureVersion,
          );
        } else {
          await publishSchemaCompatibilityBarrier(configDir, futureVersion);
        }
        await expect(
          removeExecutionSeedFiller.up({
            name: removeExecutionSeedFiller.name,
            context: { db, configDir },
          }),
        ).rejects.toThrow(
          /recorded schema version .* is greater than known build version/,
        );
        expect(
          db
            .prepare("SELECT definition_json FROM graph_workflow_executions")
            .get(),
        ).toEqual({ definition_json: original });
        expect(
          db
            .prepare("SELECT version FROM schema_migrations WHERE version = 18")
            .all(),
        ).toEqual([]);
      } finally {
        db.close();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  it("clears only invented identities in active and archived rows and survives replay", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT);
        CREATE TABLE graph_workflow_executions (execution_id TEXT, seed_definition_id TEXT, seed_definition_revision INTEGER, definition_json TEXT);
        CREATE TABLE graph_workflow_archived_executions (execution_id TEXT, execution_json TEXT);
      `);
      const examples = [
        {
          id: "inline",
          kind: "one_off",
          seed: "one-off:inline",
          expected: null,
        },
        {
          id: "spec-old",
          kind: "spec_delivery",
          seed: "spec-delivery:spec-old",
          expected: null,
        },
        {
          id: "spec",
          kind: "spec_delivery",
          seed: "real-definition",
          expected: "real-definition",
        },
        {
          id: "template",
          kind: "template",
          seed: "real-template",
          expected: "real-template",
        },
      ];
      for (const example of examples) {
        const body = JSON.stringify({
          origin: { kind: example.kind },
          seedDefinitionId: example.seed,
          seedDefinitionRevision: 2,
          retained: "unchanged",
        });
        db.prepare(
          "INSERT INTO graph_workflow_executions VALUES (?, ?, 2, ?)",
        ).run(example.id, example.seed, body);
        db.prepare(
          "INSERT INTO graph_workflow_archived_executions VALUES (?, ?)",
        ).run(example.id, body);
      }
      const input = {
        name: removeExecutionSeedFiller.name,
        context: { db, configDir: null },
      };
      await removeExecutionSeedFiller.up(input);
      await removeExecutionSeedFiller.up(input);
      for (const example of examples) {
        expect(
          db
            .prepare(
              "SELECT seed_definition_id AS id, seed_definition_revision AS revision FROM graph_workflow_executions WHERE execution_id = ?",
            )
            .get(example.id),
        ).toEqual({
          id: example.expected,
          revision: example.expected === null ? null : 2,
        });
        for (const [table, column] of [
          ["graph_workflow_executions", "definition_json"],
          ["graph_workflow_archived_executions", "execution_json"],
        ]) {
          const row = db
            .prepare(
              `SELECT ${column} AS body FROM ${table} WHERE execution_id = ?`,
            )
            .get(example.id) as { body: string };
          expect(JSON.parse(row.body)).toMatchObject({
            seedDefinitionId: example.expected,
            seedDefinitionRevision: example.expected === null ? null : 2,
            retained: "unchanged",
          });
        }
      }
      expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual(
        [{ version: 18 }],
      );
    } finally {
      db.close();
    }
  });
});
