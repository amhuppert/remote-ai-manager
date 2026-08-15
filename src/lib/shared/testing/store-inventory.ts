import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";

/** Every persisted row, serialized and sorted, keyed by table name. */
export type StoreInventory = Record<string, string[]>;

/**
 * Snapshot EVERY row of EVERY table, for proving a refused launch persisted
 * nothing at all (D7 R5.2).
 *
 * The table list is read from `sqlite_master` rather than written out by hand
 * on purpose. R5.2 is a claim about every store there is — execution, archive,
 * event, result-delivery, definition, and whatever is added next — so a helper
 * that named its tables would keep passing while a launch quietly wrote to the
 * one table nobody remembered to add. That is precisely the partial record the
 * invariant exists to forbid, so the inventory discovers its own scope and any
 * new table joins it for free.
 *
 * Rows are serialized and sorted so a comparison is order-insensitive: the
 * claim is that a refusal ADDS nothing, and SQLite may return surviving rows in
 * any order.
 */
export function captureStoreInventory(
  db: PersistenceFixture["db"],
): StoreInventory {
  const inventory: StoreInventory = {};
  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  for (const row of tableRows) {
    if (typeof row !== "object" || row === null || !("name" in row)) continue;
    const name = (row as { name: unknown }).name;
    if (typeof name !== "string" || name.startsWith("sqlite_")) continue;
    // The name came from sqlite_master, never from caller input, so quoting it
    // is sufficient — there is no untrusted string to interpolate here.
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    inventory[name] = rows.map((persisted) => JSON.stringify(persisted)).sort();
  }
  return inventory;
}
