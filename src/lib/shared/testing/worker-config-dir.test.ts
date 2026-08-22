import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkerConfigDir } from "./worker-config-dir";

const created: string[] = [];

function tempRoot(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `worker-config-${label}-`));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});

describe("createWorkerConfigDir", () => {
  /**
   * The regression this exists for: registered validation exports one scratch
   * CC_CONFIG_DIR for the whole run, so a worker that adopted an inherited
   * directory shared `command-center.db` with every sibling fork. That surfaced
   * as `SqliteError: database is locked` from the `journal_mode = WAL` pragma
   * during open — intermittently, whenever two workers opened at once.
   */
  it("gives each worker its own directory under an inherited parent", () => {
    const inherited = tempRoot("inherited");

    const first = createWorkerConfigDir(inherited, os.tmpdir());
    const second = createWorkerConfigDir(inherited, os.tmpdir());

    expect(first).not.toBe(inherited);
    expect(second).not.toBe(inherited);
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(inherited);
    expect(path.dirname(second)).toBe(inherited);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it("falls back to the supplied root when nothing is inherited", () => {
    const fallback = tempRoot("fallback");

    const dir = createWorkerConfigDir(undefined, fallback);

    expect(path.dirname(dir)).toBe(fallback);
    expect(existsSync(dir)).toBe(true);
  });
});
