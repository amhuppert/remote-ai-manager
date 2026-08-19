import { GRAPH_PLAN_REVIEWS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `graph_plan_reviews` — the terminal plan-review verdict bound to the
 * revision it judged by `workingDefinitionHash` (#69 change 5). The synchronous
 * schema floor already creates it on every open, so on a floor-initialized
 * database this is a no-op; the migration records the change in the ordered
 * ledger and applies the identical DDL (shared constant, no hand-synced copy)
 * to any database that predates the floor entry.
 *
 * Purely additive — no existing row moves and no existing read path learns a
 * new vocabulary, so an older build sharing `command-center.db` simply ignores
 * a table it has no reader for. No KNOWN_SCHEMA_VERSION bump: fencing older
 * builds out of the whole database would cost them every feature to protect a
 * table none of them touch.
 */
export const addGraphPlanReviews: StateMigration = {
  name: "0032-add-graph-plan-reviews",
  up: async ({ context }) => {
    context.db.exec(GRAPH_PLAN_REVIEWS_SCHEMA_DDL);
  },
};
