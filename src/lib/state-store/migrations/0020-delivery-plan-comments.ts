import { SPEC_DELIVERY_PLAN_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `spec_delivery_plan_comments` — the durable context-anchored review
 * notes on a `DeliveryPlanAttempt`. The synchronous schema floor already
 * creates it on every open, so on a floor-initialized database this is a
 * no-op; the migration records the change in the ordered ledger and applies
 * the identical DDL (shared constant, no hand-synced copy) to a database
 * created between migration 0016 and this one.
 *
 * Purely additive — the `CREATE TABLE IF NOT EXISTS` statements for the older
 * tables are unchanged and an older build simply never reads the new one, so
 * no `KNOWN_SCHEMA_VERSION` bump.
 */
export const deliveryPlanComments: StateMigration = {
  name: "0020-delivery-plan-comments",
  up: async ({ context }) => {
    context.db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
  },
};
