import { SPEC_DELIVERY_PLAN_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `spec_delivery_plan_candidates` (design §5). The synchronous schema
 * floor already creates it on every open, so on any floor-initialized database
 * this is a no-op; the migration records the change in the ordered ledger and
 * applies the identical DDL (shared constant, no hand-synced copy) to a
 * database created between migration 0015 and this one. Purely additive — the
 * `CREATE TABLE IF NOT EXISTS` statements for the two older tables are
 * unchanged, and older builds ignore the new one, so no KNOWN_SCHEMA_VERSION
 * bump.
 */
export const addDeliveryPlanCandidates: StateMigration = {
  name: "0016-add-delivery-plan-candidates",
  up: async ({ context }) => {
    context.db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
  },
};
