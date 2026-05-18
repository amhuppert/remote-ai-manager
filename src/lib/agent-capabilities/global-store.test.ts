import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentCapabilityGlobalStateSchema } from "@/lib/schemas";

const { loggerInfo, loggerError, loggerWarn, loggerDebug } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: loggerInfo,
    error: loggerError,
    warn: loggerWarn,
    debug: loggerDebug,
  }),
}));

import {
  createGlobalCapabilityOverrideStore,
  type GlobalCapabilityOverrideStore,
} from "./global-store";

describe("agent-capabilities/global-store", () => {
  let tmp: string;
  let filePath: string;

  beforeEach(async () => {
    loggerInfo.mockClear();
    loggerError.mockClear();
    loggerWarn.mockClear();
    loggerDebug.mockClear();
    tmp = await mkdtemp(path.join(tmpdir(), "agent-cap-global-"));
    filePath = path.join(tmp, "agent-capabilities-global.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function createStore() {
    return createGlobalCapabilityOverrideStore({ filePath });
  }

  describe("read", () => {
    it("returns empty overrides when the file does not exist", async () => {
      const store = createStore();
      const result = await store.read();
      expect(result).toEqual({ cascades: {} });
      expect(existsSync(filePath)).toBe(false);
    });

    it("returns empty overrides when the parent directory does not exist", async () => {
      const store = createGlobalCapabilityOverrideStore({
        filePath: path.join(tmp, "nested", "deep", "agent-capabilities.json"),
      });
      const result = await store.read();
      expect(result).toEqual({ cascades: {} });
    });

    it("reads persisted overrides", async () => {
      const file = {
        version: 1,
        overrides: {
          cascades: {
            "claude-skills": {
              items: { "skill:a": { enabled: false } },
            },
          },
        },
        updatedAt: "2026-05-17T22:51:08Z",
      };
      await writeFile(filePath, JSON.stringify(file), "utf-8");

      const store = createStore();
      const result = await store.read();
      expect(result.cascades["claude-skills"]?.items["skill:a"]).toEqual({
        enabled: false,
      });
    });

    it("throws a sanitized diagnostic on invalid JSON without corrupting state", async () => {
      await writeFile(filePath, "{not json", "utf-8");
      const store = createStore();
      await expect(store.read()).rejects.toThrow(/global override file/i);
      expect(await readFile(filePath, "utf-8")).toBe("{not json");
    });

    it("throws when the persisted file fails schema validation", async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 2,
          overrides: { cascades: {} },
          updatedAt: "x",
        }),
        "utf-8",
      );
      const store = createStore();
      await expect(store.read()).rejects.toThrow();
    });
  });

  describe("patch", () => {
    it("creates the file on first write with version 1 and a fresh updatedAt", async () => {
      const store = createStore();
      const result = await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      });

      expect(result.changedItemIds).toEqual(["skill:a"]);

      expect(existsSync(filePath)).toBe(true);
      const raw = JSON.parse(await readFile(filePath, "utf-8"));
      const parsed = agentCapabilityGlobalStateSchema.parse(raw);
      expect(parsed.version).toBe(1);
      expect(
        parsed.overrides.cascades["claude-skills"]?.items["skill:a"]?.enabled,
      ).toBe(false);
      expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates missing parent directories before writing", async () => {
      const nested = path.join(
        tmp,
        "nested",
        "deep",
        "agent-capabilities.json",
      );
      const store = createGlobalCapabilityOverrideStore({ filePath: nested });
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: true },
        ],
      });
      expect(existsSync(nested)).toBe(true);
    });

    it("writes atomically via temp-then-rename (no leftover .tmp files)", async () => {
      const store = createStore();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: true },
        ],
      });
      const entries = await readdir(path.dirname(filePath));
      expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
    });

    it("validates the just-written state before reporting success", async () => {
      const store = createStore();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      });

      const reread = await store.read();
      expect(reread.cascades["claude-skills"]?.items["skill:a"]).toEqual({
        enabled: false,
      });
    });

    it("restores persisted global overrides when a new store instance reads the file", async () => {
      await createStore().patch({
        cascadeKind: "codex-skills",
        operations: [
          { type: "set-item-enabled", itemId: "codex:a", enabled: false },
        ],
      });

      const restored = await createStore().read();

      expect(restored.cascades["codex-skills"]?.items["codex:a"]).toEqual({
        enabled: false,
      });
    });

    it("does not corrupt the prior state when read fails on a malformed file", async () => {
      await writeFile(filePath, "{not json", "utf-8");
      const store = createStore();
      await expect(
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
        }),
      ).rejects.toThrow();
      expect(await readFile(filePath, "utf-8")).toBe("{not json");
    });

    it("prunes the cascade record after reset of the only item", async () => {
      const store = createStore();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      });

      const reset = await store.patch({
        cascadeKind: "claude-skills",
        operations: [{ type: "reset-item", itemId: "skill:a" }],
      });
      expect(reset.changedItemIds).toEqual(["skill:a"]);

      const raw = JSON.parse(await readFile(filePath, "utf-8"));
      expect(raw.overrides.cascades["claude-skills"]).toBeUndefined();
    });

    it("persists changes from one cascade without touching unrelated cascades", async () => {
      const store = createStore();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      });
      await store.patch({
        cascadeKind: "codex-skills",
        operations: [
          { type: "set-item-enabled", itemId: "codex:a", enabled: true },
        ],
      });

      const read = await store.read();
      expect(read.cascades["claude-skills"]?.items["skill:a"]?.enabled).toBe(
        false,
      );
      expect(read.cascades["codex-skills"]?.items["codex:a"]?.enabled).toBe(
        true,
      );
    });
  });

  describe("write-failure diagnostics", () => {
    it("logs global.write_failure with sanitized fields and throws a sanitized error when atomic write fails", async () => {
      const blocker = path.join(tmp, "blocker");
      await writeFile(blocker, "x");
      const nested = path.join(blocker, "agent-capabilities.json");
      const store = createGlobalCapabilityOverrideStore({ filePath: nested });

      await expect(
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: true },
          ],
        }),
      ).rejects.toThrow(/agent capability global override/i);

      const writeFailureCalls = loggerError.mock.calls.filter(
        ([event]) => event === "global.write_failure",
      );
      expect(writeFailureCalls.length).toBe(1);
      const fields = writeFailureCalls[0]?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(fields).toBeDefined();
      expect(fields?.["filePath"]).toBe(nested);
      expect(typeof fields?.["error"]).toBe("string");
    });

    it("does not corrupt the prior on-disk state when the atomic write fails on a follow-up patch", async () => {
      const store = createStore();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: true },
        ],
      });
      const originalBytes = await readFile(filePath, "utf-8");

      // Re-create store on a path whose parent is a file so the next write fails.
      const blocker = path.join(tmp, "blocker");
      await writeFile(blocker, "x");
      const blockedStore = createGlobalCapabilityOverrideStore({
        filePath: path.join(blocker, "out.json"),
      });
      await expect(
        blockedStore.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:b", enabled: true },
          ],
        }),
      ).rejects.toThrow();

      // Prior file untouched.
      expect(await readFile(filePath, "utf-8")).toBe(originalBytes);
    });
  });

  describe("precondition (atomic guard inside the write boundary)", () => {
    it("invokes the precondition with the current overrides snapshot before applying operations", async () => {
      const store = createStore();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      });

      const precondition = vi.fn();
      await store.patch({
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:b", enabled: true },
        ],
        precondition,
      });

      expect(precondition).toHaveBeenCalledTimes(1);
      const arg = precondition.mock.calls[0]?.[0];
      expect(
        (arg as { cascades: Record<string, unknown> }).cascades[
          "claude-skills"
        ],
      ).toBeDefined();
    });

    it("aborts the patch and does not write when the precondition throws", async () => {
      const store = createStore();
      await expect(
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: true },
          ],
          precondition: () => {
            throw new Error("precondition vetoed");
          },
        }),
      ).rejects.toThrow(/precondition vetoed/);
      expect(existsSync(filePath)).toBe(false);
    });
  });

  describe("concurrent patch serialization", () => {
    it("serializes overlapping patches so no update is lost", async () => {
      const store: GlobalCapabilityOverrideStore = createStore();

      await Promise.all([
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: true },
          ],
        }),
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "b", enabled: false },
          ],
        }),
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "c", enabled: true },
          ],
        }),
      ]);

      const final = await store.read();
      const items = final.cascades["claude-skills"]?.items ?? {};
      expect(items["a"]?.enabled).toBe(true);
      expect(items["b"]?.enabled).toBe(false);
      expect(items["c"]?.enabled).toBe(true);
    });

    it("precondition of a second concurrent patch observes the first patch's persisted state", async () => {
      const store: GlobalCapabilityOverrideStore = createStore();

      const seenByB: Array<Record<string, unknown>> = [];

      await Promise.all([
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "a", enabled: true },
          ],
        }),
        store.patch({
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "b", enabled: false },
          ],
          precondition: (current) => {
            seenByB.push(JSON.parse(JSON.stringify(current.cascades)));
          },
        }),
      ]);

      expect(seenByB).toHaveLength(1);
      const sawA =
        (
          seenByB[0] as { "claude-skills"?: { items: Record<string, unknown> } }
        )["claude-skills"]?.items["a"] !== undefined;
      expect(sawA).toBe(true);
    });
  });
});
