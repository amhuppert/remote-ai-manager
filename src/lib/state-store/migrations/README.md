# State-store migrations

Ordered, ledgered schema and data migrations for `command-center.db`, run by the
Umzug-based runner in [`../migrator.ts`](../migrator.ts).

## How schema management is split

| Concern | Where | Runs |
|---|---|---|
| Whether this build may open the database at all | [`../migration-history.ts`](../migration-history.ts) | on every DB open, before any write |
| Current table/column/index shape | `state-db.ts` `SCHEMA_DDL` (`CREATE … IF NOT EXISTS`) | synchronously on **every** DB open |
| Idempotent column back-fill for old DBs | `state-db.ts` `ADDITIVE_COLUMNS` | synchronously on every DB open |
| Forward-only compatibility version gate | `state-db.ts` `schema_migrations` / `KNOWN_SCHEMA_VERSION` | on open |
| **Everything else — data migrations, structural rebuilds, one-time cleanups** | **this directory** | **once, at server startup** |

The runner is async, so it runs from the startup instrumentation hook
(`instrumentation.node.ts`), not from the synchronous `getDb()` open path. The
floor guarantees a structurally valid schema before any migration runs, so a
fresh database records every migration as a no-op and is stamped. `next build`
opens the database too, and runs only the floor: a floor change must leave an
existing database alone.

## Retired history

Every migration registered at build `overhaul-deploy-1.5` (`f441c64c3`) is
retired. Their code is gone; their names are a literal list in
[`../migration-history.ts`](../migration-history.ts), and the tag holds their
sources and tests. Before the floor writes anything, the open path classifies
the database:

- **fresh** (no table at all): the floor builds the schema and stamps every
  retired name into `applied_migrations`, in the same transaction;
- **eligible** (the ledger holds every retired name): the floor runs, and must
  change nothing on a database that build left;
- **anything else** is refused with the database unchanged. The message names
  the first missing migrations and the build to start once so its startup
  migrations finish. A disposable dev instance can delete its `.config`
  directory instead.

A directory whose floor ran but whose migrations never did is refused too. Only
an interrupted disposable instance leaves one.

`truncateAllTables` keeps `applied_migrations` (and `schema_migrations`), so a
reset test database still opens.

## Testing against an upgraded database

[`testing/deploy-1-5-database.ts`](./testing/deploy-1-5-database.ts) writes the
data directory a stopped `overhaul-deploy-1.5` server leaves: the frozen schema
from [`testing/deploy-1-5-schema.ts`](./testing/deploy-1-5-schema.ts), the full
ledger, schema version 29, its compatibility barriers and a few seeded rows,
all through raw SQLite. Use it for anything a live host's database must survive,
and a fresh floor (`_createTestDb`) for new installs. Never edit the frozen
schema to follow the floor; it stands for databases that already exist.

To reload through the repositories, open the fixture's path with
`_createTestDbAtPath` and pass it as `createPersistenceFixture({ db })`.

## Adding a migration

1. Create `NNNN-short-description.ts` (next zero-padded number). The `name`
   field is both the ledger key and the lexicographic sort key, so keep the
   prefix in sync with the filename.
2. Make `up` **idempotent** — completion is recorded in a separate step from
   running `up`, so a crash in between replays it on the next start. Guard with
   `IF [NOT] EXISTS`, `INSERT OR IGNORE`, or a pre-check.
3. Append it to the array in [`index.ts`](./index.ts) (order matters).
4. If the change is **breaking** (an older build can no longer read the data),
   also bump `KNOWN_SCHEMA_VERSION`, publish the compatibility barrier before the
   first write, and insert a `schema_migrations` row so the forward-only gate
   stops older builds from opening the upgraded database.
5. Add a focused test beside the migration: on the frozen deploy 1.5 fixture for
   the upgrade, and on a fresh floor for a new install.

## When a shape change needs a version bump

Ask whether an older build sharing the database could still read it. A column
every row must satisfy, or a JSON blob a list query parses eagerly, fails a
whole result set in an older build: bump the version. A field an older build
meets only when it parses one record fails that one act with a typed
persistence error, and the bump would lock the older build out of the whole
database over it: state that exposure instead of bumping.

## Rehearsing on a copy

`bun run migrations:rehearse -- --from <stopped data directory> --to <empty scratch directory>`
(both absolute) copies the database, its write-ahead log and the top-level JSON
files, then runs this build's startup on the copy: the history guard, the floor
and the pending migrations. It prints the history verdict, the migrations
applied, the schema versions, the schema entries startup added, removed or
changed, and the integrity and foreign-key checks before and after. The source
is never opened.

## Ledger tables (three, distinct purposes)

- `applied_migrations` — this runner's ledger (by name), including the stamped
  retired history.
- `schema_migrations` — forward-only compatibility **version** gate for breaking changes.
- `applied_data_migrations` — legacy one-off purge marker; predates this runner.

## Offline graph-engine cutover

Schema 30 retires graph workflow storage, the conversation actor sidecar and native spec delivery. `0069-graph-engine-cutover` moves role memory policies to `memory.roles`, withdraws open legacy plan drafts, clears historical non-seat role input and questions, retires workflow subscriptions and delivery metadata, and removes saved `workflows/`. `0070-retire-graph-engine-storage` drops retired tables/columns and rebuilds the surviving leaves with frozen definitions. Both tolerate replay. Existing lane worktrees, transcripts and workflow log/document directories are retained.

Stop Command Center and back up the complete config directory before applying these migrations. The backup owns rollback: restore it before reopening with a pre-cutover build. The cutover deliberately omits live drain, staged deployments and archive preflight; it is intended for an offline operator cutover.
