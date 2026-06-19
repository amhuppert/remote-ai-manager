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

## Ledger tables (three, distinct purposes)

- `applied_migrations` — this runner's ledger (by name). New migrations record here.
- `schema_migrations` — forward-only compatibility **version** gate for breaking changes.
- `applied_data_migrations` — legacy one-off purge marker; predates this runner.
