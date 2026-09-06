/**
 * The `globalThis` key under which the process-wide state DB connection is
 * installed. Owned here, apart from `state-db.ts`, so that test setup can
 * check for and close an installed connection without loading the schema
 * floor, `better-sqlite3`, the config loader, and logging that `state-db.ts`
 * drags in for every test file.
 */
export const STATE_DB_GLOBAL_KEY = "__cc_state_db" as const;
