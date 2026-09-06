import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalValue } from "@/lib/shared/global-singleton";
import { resetInstalledStateDbForTesting } from "./reset-installed-state-db";
import { STATE_DB_GLOBAL_KEY } from "./state-db-global-key";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
  getDb,
} from "./state-db";

const repoRoot = process.cwd();

describe("resetInstalledStateDbForTesting", () => {
  afterEach(() => {
    _resetForTesting();
  });

  it("reports nothing to reset when no connection is installed", () => {
    _resetForTesting();
    expect(resetInstalledStateDbForTesting()).toBe(false);
    expect(getGlobalValue(STATE_DB_GLOBAL_KEY)).toBeUndefined();
  });

  it("closes and uninstalls an installed test connection", () => {
    const db = _createTestDb({ inMemory: true });
    _installTestDb(db);

    expect(resetInstalledStateDbForTesting()).toBe(true);

    expect(db.open).toBe(false);
    expect(getGlobalValue(STATE_DB_GLOBAL_KEY)).toBeUndefined();
  });

  it("shares the singleton key with state-db, so a getDb() connection is reset", () => {
    const db = getDb();
    expect(getGlobalValue(STATE_DB_GLOBAL_KEY)).toBe(db);

    expect(resetInstalledStateDbForTesting()).toBe(true);

    expect(db.open).toBe(false);
    expect(getGlobalValue(STATE_DB_GLOBAL_KEY)).toBeUndefined();
    expect(getDb()).not.toBe(db);
  });
});

describe("lightweight reset import boundary", () => {
  it("does not load state-db or better-sqlite3 from the reset module", () => {
    const source = readFileSync(
      path.resolve(repoRoot, "src/lib/state-store/reset-installed-state-db.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from "\.\/state-db"/);
    expect(source).not.toMatch(/from "better-sqlite3"/);
  });

  it("is what the shared Vitest setup resets through, without importing state-db", () => {
    const setup = readFileSync(
      path.resolve(repoRoot, "vitest.setup.ts"),
      "utf8",
    );
    expect(setup).toContain("reset-installed-state-db");
    expect(setup).not.toContain("state-store/state-db");
  });
});
