import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mcpGlobalStateSchema } from "@/lib/mcp/schemas";
import { createGlobalOverrideStore } from "./global-store";

describe("mcp/global-store", () => {
  let tmp: string;
  let globalFilePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-global-"));
    globalFilePath = path.join(tmp, "mcp-global.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function createStore() {
    return createGlobalOverrideStore({ filePath: globalFilePath });
  }

  describe("read", () => {
    it("returns empty overrides when the file does not exist", async () => {
      const store = createStore();
      const result = await store.read();
      expect(result).toEqual({ servers: {} });
      expect(existsSync(globalFilePath)).toBe(false);
    });

    it("returns empty overrides when the parent directory does not exist", async () => {
      const store = createGlobalOverrideStore({
        filePath: path.join(tmp, "nested", "deep", "mcp-global.json"),
      });
      const result = await store.read();
      expect(result).toEqual({ servers: {} });
    });

    it("reads persisted overrides", async () => {
      const file = {
        version: 1,
        overrides: {
          servers: {
            playwright: { enabled: false },
          },
        },
        updatedAt: "2026-04-21T00:00:00.000Z",
      };
      await writeFile(globalFilePath, JSON.stringify(file), "utf-8");

      const store = createStore();
      const result = await store.read();
      expect(result.servers.playwright).toEqual({ enabled: false });
    });

    it("throws when the persisted file fails schema validation", async () => {
      await writeFile(
        globalFilePath,
        JSON.stringify({ version: 2, overrides: {}, updatedAt: "x" }),
        "utf-8",
      );
      const store = createStore();
      await expect(store.read()).rejects.toThrow();
    });
  });

  describe("patch", () => {
    it("creates the file on first write with version 1", async () => {
      const store = createStore();
      const result = await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "kagi", enabled: false },
        ],
      });

      expect(result.changedServerKeys).toEqual(["kagi"]);
      expect(result.overrides.servers.kagi).toEqual({ enabled: false });

      expect(existsSync(globalFilePath)).toBe(true);
      const raw = JSON.parse(await readFile(globalFilePath, "utf-8"));
      const parsed = mcpGlobalStateSchema.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.overrides.servers.kagi?.enabled).toBe(false);
      expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates missing parent directories before writing", async () => {
      const nested = path.join(tmp, "nested", "deep", "mcp-global.json");
      const store = createGlobalOverrideStore({ filePath: nested });
      await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "kagi", enabled: true },
        ],
      });
      expect(existsSync(nested)).toBe(true);
    });

    it("writes atomically via temp-then-rename", async () => {
      const store = createStore();
      await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "x", enabled: true },
        ],
      });
      const dirEntries = await readDirectorySync(path.dirname(globalFilePath));
      const tmpFiles = dirEntries.filter((name) => name.includes(".tmp."));
      expect(tmpFiles).toEqual([]);
    });

    it("applies set-tool-enabled under an existing server", async () => {
      const store = createStore();
      await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "kagi", enabled: true },
          {
            type: "set-tool-enabled",
            serverKey: "kagi",
            toolName: "search",
            enabled: false,
          },
        ],
      });

      const read = await store.read();
      expect(read.servers.kagi?.enabled).toBe(true);
      expect(read.servers.kagi?.tools?.search?.enabled).toBe(false);
    });

    it("applies set-tool-enabled for a server without an explicit enabled flag", async () => {
      const store = createStore();
      const result = await store.patch({
        operations: [
          {
            type: "set-tool-enabled",
            serverKey: "playwright",
            toolName: "navigate",
            enabled: false,
          },
        ],
      });

      expect(result.changedServerKeys).toEqual(["playwright"]);
      const read = await store.read();
      expect(read.servers.playwright?.tools?.navigate?.enabled).toBe(false);
    });

    it("reports unique changed server keys even when multiple ops target the same server", async () => {
      const store = createStore();
      const result = await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "a", enabled: false },
          {
            type: "set-tool-enabled",
            serverKey: "a",
            toolName: "x",
            enabled: false,
          },
          {
            type: "set-tool-enabled",
            serverKey: "a",
            toolName: "y",
            enabled: true,
          },
          { type: "set-server-enabled", serverKey: "b", enabled: true },
        ],
      });
      expect([...result.changedServerKeys].sort()).toEqual(["a", "b"]);
    });

    it("removes the server entry entirely after reset-server (empty records stay small)", async () => {
      const store = createStore();
      await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "k", enabled: false },
          {
            type: "set-tool-enabled",
            serverKey: "k",
            toolName: "t",
            enabled: false,
          },
        ],
      });

      const reset = await store.patch({
        operations: [{ type: "reset-server", serverKey: "k" }],
      });
      expect(reset.changedServerKeys).toEqual(["k"]);

      const read = await store.read();
      expect(read.servers.k).toBeUndefined();

      const raw = JSON.parse(await readFile(globalFilePath, "utf-8"));
      expect(raw.overrides.servers.k).toBeUndefined();
    });

    it("removes the server entry after reset-tool drains it of all fields", async () => {
      const store = createStore();
      await store.patch({
        operations: [
          {
            type: "set-tool-enabled",
            serverKey: "a",
            toolName: "t",
            enabled: false,
          },
        ],
      });
      await store.patch({
        operations: [{ type: "reset-tool", serverKey: "a", toolName: "t" }],
      });
      const read = await store.read();
      expect(read.servers.a).toBeUndefined();
    });

    it("removes only the named tool when reset-tool leaves other fields behind", async () => {
      const store = createStore();
      await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "a", enabled: false },
          {
            type: "set-tool-enabled",
            serverKey: "a",
            toolName: "t1",
            enabled: false,
          },
          {
            type: "set-tool-enabled",
            serverKey: "a",
            toolName: "t2",
            enabled: true,
          },
        ],
      });
      const result = await store.patch({
        operations: [{ type: "reset-tool", serverKey: "a", toolName: "t1" }],
      });
      expect(result.changedServerKeys).toEqual(["a"]);

      const read = await store.read();
      expect(read.servers.a?.enabled).toBe(false);
      expect(read.servers.a?.tools?.t1).toBeUndefined();
      expect(read.servers.a?.tools?.t2?.enabled).toBe(true);
    });

    it("reset-server is idempotent when no override exists (no changed keys, no write effect)", async () => {
      const store = createStore();
      const result = await store.patch({
        operations: [{ type: "reset-server", serverKey: "missing" }],
      });
      expect(result.changedServerKeys).toEqual([]);
    });

    it("reset-tool is idempotent when no override exists (no changed keys)", async () => {
      const store = createStore();
      const result = await store.patch({
        operations: [{ type: "reset-tool", serverKey: "nope", toolName: "x" }],
      });
      expect(result.changedServerKeys).toEqual([]);
    });

    it("persists only the explicit diff (never full resolved config)", async () => {
      const store = createStore();
      await store.patch({
        operations: [
          { type: "set-server-enabled", serverKey: "a", enabled: false },
        ],
      });
      const raw = JSON.parse(await readFile(globalFilePath, "utf-8"));
      expect(Object.keys(raw.overrides.servers)).toEqual(["a"]);
      expect(raw.overrides.servers.a).toEqual({ enabled: false });
    });

    it("serializes concurrent patches so neither update is lost", async () => {
      const store = createStore();
      await Promise.all([
        store.patch({
          operations: [
            { type: "set-server-enabled", serverKey: "alpha", enabled: true },
          ],
        }),
        store.patch({
          operations: [
            { type: "set-server-enabled", serverKey: "beta", enabled: false },
          ],
        }),
      ]);

      const read = await store.read();
      expect(read.servers.alpha?.enabled).toBe(true);
      expect(read.servers.beta?.enabled).toBe(false);
    });
  });
});

async function readDirectorySync(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}
