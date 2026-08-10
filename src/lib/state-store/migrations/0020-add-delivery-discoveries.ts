import { SPEC_DELIVERY_DISCOVERY_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `spec_delivery_discoveries` — the durable record a post-launch
 * non-blocking `cctl spec capture` writes, and the one the next seeded attempt
 * consumes (design §11). The synchronous schema floor already creates it on
 * every open, so on a floor-initialized database this is a no-op; the
 * migration records the change in the ordered ledger and applies the identical
 * DDL (shared constant, no hand-synced copy) to any database that predates the
 * floor entry. Purely additive — older builds ignore the table, so no
 * KNOWN_SCHEMA_VERSION bump.
 */
export const addDeliveryDiscoveries: StateMigration = {
  name: "0020-add-delivery-discoveries",
  up: async ({ context }) => {
    context.db.exec(SPEC_DELIVERY_DISCOVERY_SCHEMA_DDL);
  },
};
