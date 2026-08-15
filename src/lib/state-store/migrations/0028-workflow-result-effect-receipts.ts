import { addColumnToleratingRace } from "../state-db";
import type { StateMigration } from "./types";

const EFFECTS_DELIVERED_AT_COLUMN = {
  name: "effects_delivered_at",
  type: "TEXT",
} as const;

/**
 * Add the durable receipt used to reconcile post-commit result effects without
 * changing the independent pending/delivering/delivered turn-attachment state.
 */
export const workflowResultEffectReceipts: StateMigration = {
  name: "0028-workflow-result-effect-receipts",
  up: async ({ context }) => {
    const columns = new Set(
      (
        context.db.pragma(
          "table_info(graph_workflow_result_deliveries)",
        ) as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (columns.size === 0 || columns.has(EFFECTS_DELIVERED_AT_COLUMN.name)) {
      return;
    }
    addColumnToleratingRace(
      context.db,
      "graph_workflow_result_deliveries",
      EFFECTS_DELIVERED_AT_COLUMN.name,
      EFFECTS_DELIVERED_AT_COLUMN.type,
    );
  },
};
