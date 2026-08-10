import { SPEC_DELIVERY_PLAN_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create the `DeliveryPlanAttempt` tables (design §4). The synchronous schema
 * floor already creates them on every open, so on any floor-initialized
 * database this is a no-op; the migration records the change in the ordered
 * ledger and applies the identical DDL (shared constant, no hand-synced copy)
 * to any database that predates the floor entry. Purely additive — older
 * builds ignore the tables, so no KNOWN_SCHEMA_VERSION bump.
 */
export const addDeliveryPlanAttempts: StateMigration = {
  name: "0015-add-delivery-plan-attempts",
  up: async ({ context }) => {
    context.db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
  },
};
