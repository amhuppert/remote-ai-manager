import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import { addSpecDeliveryVerdicts } from "./0029-add-spec-delivery-verdicts";

type Db = InstanceType<typeof Database>;

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

async function runMigration(target: Db): Promise<void> {
  await addSpecDeliveryVerdicts.up({
    name: addSpecDeliveryVerdicts.name,
    context: { db: target, configDir: null },
  });
}

describe("0029-add-spec-delivery-verdicts", () => {
  it("creates the attempt-scoped verdict table and preserves rows on replay", async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE spec_executions (id TEXT PRIMARY KEY);
      CREATE TABLE spec_elements (id TEXT PRIMARY KEY);
      INSERT INTO spec_executions (id) VALUES ('spec-execution-1');
      INSERT INTO spec_elements (id) VALUES ('criterion-1');
    `);

    await runMigration(db);
    db.prepare(
      `INSERT INTO spec_delivery_verdicts (
         id, spec_execution_id, workflow_execution_id, candidate_id,
         candidate_hash, criterion_element_id, satisfying_context_id, verdict_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "verdict-1",
      "spec-execution-1",
      "workflow-execution-1",
      "candidate-1",
      `sha256:${"a".repeat(64)}`,
      "criterion-1",
      "authored-context-1",
      "2026-08-15T12:00:00.000Z",
    );

    await runMigration(db);

    expect(db.prepare("SELECT * FROM spec_delivery_verdicts").all()).toEqual([
      expect.objectContaining({
        id: "verdict-1",
        spec_execution_id: "spec-execution-1",
        workflow_execution_id: "workflow-execution-1",
        candidate_id: "candidate-1",
        criterion_element_id: "criterion-1",
        satisfying_context_id: "authored-context-1",
      }),
    ]);
  });
});
