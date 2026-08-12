# State-store migrations

Ordered, ledgered schema/data migrations for `command-center.db`, run by the
Umzug-based runner in [`../migrator.ts`](../migrator.ts).

## How schema management is split

| Concern | Where | Runs |
|---|---|---|
| Current table/column/index shape | `state-db.ts` `SCHEMA_DDL` (`CREATE … IF NOT EXISTS`) | synchronously on **every** DB open |
| Idempotent column back-fill for old DBs | `state-db.ts` `ADDITIVE_COLUMNS` | synchronously on every DB open |
| Structural rebuilds that must hold at open time | `state-db.ts` (e.g. `migrateNotificationsTable`) | synchronously on every DB open |
| Forward-only compatibility version gate | `state-db.ts` `schema_migrations` / `KNOWN_SCHEMA_VERSION` | on open |
| **Everything else — data migrations, one-time cleanups, future ordered changes** | **this directory** | **once, at server startup** |

The runner is async, so it runs from the startup instrumentation hook
(`instrumentation.node.ts`), not from the synchronous `getDb()` open path. The
floor guarantees a structurally-valid schema before any migration runs; a fresh
database therefore records every migration as a no-op and is stamped.

## Adding a migration

1. Create `NNNN-short-description.ts` (next zero-padded number). The `name`
   field is both the ledger key and the lexicographic sort key, so keep the
   prefix in sync with the filename.
2. Make `up` **idempotent** — completion is recorded in a separate step from
   running `up`, so a crash in between replays it on the next start. Guard with
   `IF [NOT] EXISTS`, `INSERT OR IGNORE`, or a pre-check.
3. Append it to the array in [`index.ts`](./index.ts) (order matters).
4. If the change is **breaking** (an older build can no longer read the data),
   also bump `KNOWN_SCHEMA_VERSION` and insert a `schema_migrations` row so the
   forward-only gate stops older builds from opening the upgraded DB.
5. Add a focused test alongside `../migrator.test.ts`.

## Blob-column shape changes and the version gate

Step 4 above asks whether an older build "can no longer read the data". For a
field added inside a JSON blob column the honest answer is usually *some* of it,
and the exposure is worth stating rather than inferring.

**Delivery-plan context placement.** The optional `placement` field on a context
in the strict `deliveryPlanDocumentSchema` is stored inside
`spec_delivery_plan_attempts.content_json` (and the snapshot table's copy of the
same bytes). Deliberately **no `KNOWN_SCHEMA_VERSION` bump**, because the
blast radius is one attempt, not the database:

- **Unaffected: listing and status reads.** `content_json` is an opaque JSON
  string at the row layer (`specDeliveryPlanAttemptRowSchema`), so
  `findAttemptsBySpecId` parses a placement-bearing attempt like any other. A
  spec's plan list, attempt statuses, and hashes all still read. Two regression
  tests pin this so it survives future edits to the row schema: the schema-level
  pin in [`../../specs/delivery-plan.test.ts`](../../specs/delivery-plan.test.ts),
  and a real-SQLite listing pin in
  [`../spec-delivery-plan-repo.contract.test.ts`](../spec-delivery-plan-repo.contract.test.ts)
  that reloads a placement-bearing row through the repository. Teach the row
  schema anything about the document and the second one fails with exactly the
  set-wide `PersistenceError(validation)` from `readMany` that this section
  says does not happen.
- **Affected: per-attempt document-parsing acts.** An older build sharing the
  database fails only when it parses *that* attempt's document — project/lint,
  propose, preview/materialize, reaffirm — with a typed persistence/parse error
  (`PersistenceError` `kind: "validation"` from the repo helpers, or the
  equivalent `ZodError` at a direct document parse). Other attempts and other
  specs are untouched.

The whole-result-set failure mode that justifies the forward-only gate does not
exist here, and the gate's cost is real: bumping the version locks an older
build out of the entire database over a field it would only meet on one
attempt. Reach for a bump when a shape change breaks a *set* read — a column
every row must satisfy, or a blob a list query parses eagerly.

## Ledger tables (three, distinct purposes)

- `applied_migrations` — this runner's ledger (by name). New migrations record here.
- `schema_migrations` — forward-only compatibility **version** gate for breaking changes.
- `applied_data_migrations` — legacy one-off purge marker; predates this runner.
