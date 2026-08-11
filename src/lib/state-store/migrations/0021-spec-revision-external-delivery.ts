import { addColumnToleratingRace } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Add `spec_revisions.external_delivery_json` — the claim an imported spec
 * carries that its work already shipped outside this system.
 *
 * Purely additive and nullable, so no `KNOWN_SCHEMA_VERSION` bump: an older
 * build reads the row through a schema that has no such key and simply sees a
 * revision with no external-delivery record, which is the truth for every
 * revision authored here. The synchronous schema floor adds the same column on
 * every open, so on a floor-initialized database this is a no-op; the migration
 * records the change in the ordered ledger and covers a database opened between
 * the floor's own passes.
 *
 * The existence check and the `ALTER` are not atomic across connections, so the
 * add goes through `addColumnToleratingRace` — parallel openers (a `next build`
 * fan-out, most notably) otherwise race the same `ALTER` and the losers fail.
 */
export const specRevisionExternalDelivery: StateMigration = {
  name: "0021-spec-revision-external-delivery",
  up: async ({ context }) => {
    const { db } = context;
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_revisions'",
      )
      .get();
    // A database that predates the spec tables has nothing to alter and picks
    // the column up with the table itself.
    if (table === undefined) return;
    const columns = db.pragma("table_info(spec_revisions)") as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "external_delivery_json")) {
      return;
    }
    addColumnToleratingRace(
      db,
      "spec_revisions",
      "external_delivery_json",
      "TEXT",
    );
  },
};
