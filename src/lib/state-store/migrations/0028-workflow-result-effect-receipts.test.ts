import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { workflowResultEffectReceipts } from "./0028-workflow-result-effect-receipts";

type Db = InstanceType<typeof Database>;

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("0028-workflow-result-effect-receipts", () => {
  it("adds the nullable receipt without rewriting rows and replays idempotently", async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE graph_workflow_result_deliveries (
        execution_id TEXT NOT NULL,
        boundary_seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, boundary_seq)
      );
      INSERT INTO graph_workflow_result_deliveries (
        execution_id, boundary_seq, payload_json
      ) VALUES ('execution-1', 17, '{}');
    `);

    const input = {
      name: workflowResultEffectReceipts.name,
      context: { db, configDir: null },
    };
    await workflowResultEffectReceipts.up(input);
    await workflowResultEffectReceipts.up(input);

    expect(
      (
        db.pragma("table_info(graph_workflow_result_deliveries)") as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toContain("effects_delivered_at");
    expect(
      db
        .prepare(
          "SELECT execution_id, boundary_seq, effects_delivered_at FROM graph_workflow_result_deliveries",
        )
        .all(),
    ).toEqual([
      {
        execution_id: "execution-1",
        boundary_seq: 17,
        effects_delivered_at: null,
      },
    ]);
  });
});
