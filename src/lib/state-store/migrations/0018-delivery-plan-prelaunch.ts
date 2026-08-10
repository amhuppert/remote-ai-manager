import { addColumnToleratingRace } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Add `spec_delivery_plan_attempts.prelaunch_json` — the durable spec-side
 * prelaunch review record `cctl spec start --park` writes (design §5).
 *
 * Purely additive and nullable, so no `KNOWN_SCHEMA_VERSION` bump: an older
 * build reads the row through a non-strict schema that drops the column, and
 * an attempt it writes simply carries no prelaunch record — which is the
 * meaningful legacy value, since it was never parked. The synchronous schema
 * floor adds the same column on every open, so on a floor-initialized database
 * this is a no-op; the migration records the change in the ordered ledger and
 * covers a database opened between the floor's own passes.
 */
export const deliveryPlanPrelaunch: StateMigration = {
  name: "0018-delivery-plan-prelaunch",
  up: async ({ context }) => {
    const { db } = context;
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_attempts'",
      )
      .get();
    // Migration 0015 creates the table; a database that predates it has
    // nothing to alter and picks the column up with the table itself.
    if (table === undefined) return;
    const columns = db.pragma(
      "table_info(spec_delivery_plan_attempts)",
    ) as Array<{ name: string }>;
    if (columns.some((column) => column.name === "prelaunch_json")) return;
    addColumnToleratingRace(
      db,
      "spec_delivery_plan_attempts",
      "prelaunch_json",
      "TEXT",
    );
  },
};
