import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createScopedConfigFileStore,
  type ScopedConfigFileStore,
} from "./scoped-config-store";

interface TestOverrides {
  entries: Record<string, string>;
}

const testStateSchema = z.object({
  version: z.literal(1),
  overrides: z.object({ entries: z.record(z.string(), z.string()) }),
  updatedAt: z.string(),
});

const loggerDouble = {
  info: vi.fn(),
  error: vi.fn(),
};

let tmp: string;
let filePath: string;

function createStore(): ScopedConfigFileStore<TestOverrides> {
  return createScopedConfigFileStore<TestOverrides>({
    filePath,
    entityLabel: "test scoped config",
    logEventPrefix: "global",
    logger: loggerDouble,
    emptyOverrides: () => ({ entries: {} }),
    decodeState: (parsed) => {
      const result = testStateSchema.safeParse(parsed);
      if (!result.success) {
        return { ok: false, error: "invalid test state" };
      }
      return { ok: true, overrides: result.data.overrides };
    },
    encodeState: (overrides) => ({
      version: 1 as const,
      overrides,
      updatedAt: new Date().toISOString(),
    }),
    sanitizeError: (message) => message.replaceAll("SECRET", "[redacted]"),
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "scoped-config-store-"));
  filePath = path.join(tmp, "nested", "test-config.json");
  loggerDouble.info.mockClear();
  loggerDouble.error.mockClear();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("scoped-config-store", () => {
  it("read returns the empty overrides before the file exists, without creating it", async () => {
    const store = createStore();
    expect(await store.read()).toEqual({ entries: {} });
    expect(existsSync(filePath)).toBe(false);
  });

  it("patch persists the applied overrides, creating parent directories, and read restores them", async () => {
    const store = createStore();
    const result = await store.patch({
      apply: (current) => ({
        overrides: { entries: { ...current.entries, a: "1" } },
        changed: ["a"],
      }),
    });
    expect(result.changed).toEqual(["a"]);
    expect(await createStore().read()).toEqual({ entries: { a: "1" } });
  });

  it("read rejects a file that fails domain decoding", async () => {
    await createStore().patch({
      apply: () => ({ overrides: { entries: { a: "1" } } }),
    });
    await writeFile(filePath, JSON.stringify({ version: 99 }), "utf-8");
    await expect(createStore().read()).rejects.toThrow(
      /failed schema validation: invalid test state/,
    );
  });

  it("a throwing precondition aborts the patch without persisting", async () => {
    const store = createStore();
    await store.patch({
      apply: () => ({ overrides: { entries: { keep: "me" } } }),
    });

    await expect(
      store.patch({
        apply: () => ({ overrides: { entries: { clobbered: "yes" } } }),
        precondition: () => {
          throw new Error("precondition vetoed");
        },
      }),
    ).rejects.toThrow(/precondition vetoed/);

    expect(await store.read()).toEqual({ entries: { keep: "me" } });
  });

  it("the precondition observes the state written by an earlier in-flight patch (serialized read)", async () => {
    const store = createStore();
    const seen: TestOverrides[] = [];

    await Promise.all([
      store.patch({
        apply: (current) => ({
          overrides: { entries: { ...current.entries, first: "1" } },
        }),
      }),
      store.patch({
        apply: (current) => ({
          overrides: { entries: { ...current.entries, second: "2" } },
        }),
        precondition: (current) => {
          seen.push(current);
        },
      }),
    ]);

    expect(seen).toEqual([{ entries: { first: "1" } }]);
    expect(await store.read()).toEqual({
      entries: { first: "1", second: "2" },
    });
  });

  it("a failed patch does not block subsequent writes on the same store", async () => {
    const store = createStore();
    await expect(
      store.patch({
        apply: () => ({ overrides: { entries: {} } }),
        precondition: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/boom/);

    await store.patch({
      apply: () => ({ overrides: { entries: { after: "ok" } } }),
    });
    expect(await store.read()).toEqual({ entries: { after: "ok" } });
  });

  it("refuses to persist a payload the domain codec would not decode back", async () => {
    const store = createScopedConfigFileStore<TestOverrides>({
      filePath,
      entityLabel: "test scoped config",
      logEventPrefix: "global",
      logger: loggerDouble,
      emptyOverrides: () => ({ entries: {} }),
      decodeState: () => ({ ok: false, error: "always invalid" }),
      encodeState: (overrides) => ({ overrides }),
    });

    await expect(
      store.patch({ apply: () => ({ overrides: { entries: {} } }) }),
    ).rejects.toThrow(/Refusing to persist test scoped config state/);
    expect(existsSync(filePath)).toBe(false);
  });

  it("sanitizes error text through the domain redactor", async () => {
    await createStore().patch({
      apply: () => ({ overrides: { entries: { a: "1" } } }),
    });
    await writeFile(filePath, "not json SECRET", "utf-8");

    await expect(createStore().read()).rejects.toThrow(/invalid JSON/);
    const errorCalls = loggerDouble.error.mock.calls.map(
      ([, data]) => (data as { error: string }).error,
    );
    expect(errorCalls.join(" ")).not.toContain("SECRET");
  });

  it("replace is serialized with patch and leaves no temp files", async () => {
    const store = createStore();
    await Promise.all([
      store.patch({
        apply: (current) => ({
          overrides: { entries: { ...current.entries, p: "1" } },
        }),
      }),
      store.replace({ entries: { replaced: "yes" } }),
    ]);

    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.overrides).toEqual({ entries: { replaced: "yes" } });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.dirname(filePath));
    expect(entries.filter((name) => name.includes(".tmp."))).toEqual([]);
  });
});
