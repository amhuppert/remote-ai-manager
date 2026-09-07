import {
  deleteGlobalValue,
  getGlobalValue,
} from "@/lib/shared/global-singleton";
import { STATE_DB_GLOBAL_KEY } from "./state-db-global-key";

interface ClosableConnection {
  close(): void;
}

/**
 * Close and uninstall the process-wide state DB connection if one is
 * installed. Returns whether there was one.
 *
 * This is the reset shared test setup runs before every test. It deliberately
 * imports nothing from `state-db.ts`: most test files never open a database,
 * and loading that module (and `better-sqlite3`) into each of them was a
 * measurable share of the suite's collection time.
 */
export function resetInstalledStateDbForTesting(): boolean {
  const installed = getGlobalValue<ClosableConnection>(STATE_DB_GLOBAL_KEY);
  if (!installed) return false;
  installed.close();
  deleteGlobalValue(STATE_DB_GLOBAL_KEY);
  return true;
}
