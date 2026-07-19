import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConfigReader, resolveConfigDir } from "./loader";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-config-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("createConfigReader", () => {
  it("merges partial workflowDefaults from disk with seeded defaults", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        workflowDefaults: {
          scriptValidator: { enabled: true },
        },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();
    expect(config.workflowDefaults).toBeDefined();

    expect(config.workflowDefaults?.scriptValidator).toEqual({ enabled: true });
    expect(config.workflowDefaults?.implementer).toBeDefined();
    expect(config.workflowDefaults?.iterationPolicy).toBeDefined();
    expect(config.workflowDefaults?.circuitBreaker).toBeDefined();
    expect(config.workflowDefaults?.mutability).toBeDefined();
  });

  it("returns partial workflowDefaults from readRawConfig without rejecting them", async () => {
    const configDir = await createTempConfigDir();
    const rawConfig = {
      workflowDefaults: {
        scriptValidator: { enabled: true },
      },
    };
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(rawConfig),
      "utf-8",
    );

    const reader = createConfigReader(configDir);

    await expect(reader.readRawConfig()).resolves.toEqual(rawConfig);
  });

  it("reads codex.pricing rate overrides from disk", async () => {
    const configDir = await createTempConfigDir();
    const pricing = {
      "gpt-5.5": {
        inputPerMillion: 6,
        cachedInputPerMillion: 0.6,
        outputPerMillion: 36,
      },
    };
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ codex: { enabled: true, pricing } }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.codex?.pricing).toEqual(pricing);
  });

  it("reads codex.timeoutMs and codex.stallTimeoutMs from disk under the names consumers use", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        codex: { enabled: true, timeoutMs: 300_000, stallTimeoutMs: 60_000 },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.codex?.timeoutMs).toBe(300_000);
    expect(config.codex?.stallTimeoutMs).toBe(60_000);
  });
});

describe("createConfigReader readConfig caching", () => {
  it("serves the same parsed config by reference when the file is unchanged (cache hit)", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ baseDir: "/x" }),
      "utf-8",
    );
    const reader = createConfigReader(configDir);

    const first = await reader.readConfig();
    const second = await reader.readConfig();

    // Reference equality proves the parse was reused, not re-run.
    expect(second).toBe(first);
    expect(second.baseDir).toBe("/x");
  });

  it("reflects a change to the file on disk (mtime/size invalidation)", async () => {
    const configDir = await createTempConfigDir();
    const file = path.join(configDir, "config.json");
    await writeFile(file, JSON.stringify({ baseDir: "/first" }), "utf-8");
    const reader = createConfigReader(configDir);

    const first = await reader.readConfig();
    expect(first.baseDir).toBe("/first");

    // Different-length content so the (mtime, size) token changes regardless of
    // filesystem mtime resolution.
    await writeFile(
      file,
      JSON.stringify({ baseDir: "/second-longer-path" }),
      "utf-8",
    );

    const second = await reader.readConfig();
    expect(second.baseDir).toBe("/second-longer-path");
    expect(second).not.toBe(first);
  });

  it("reflects a writeConfig made through the same reader (own-write invalidation)", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ baseDir: "/orig" }),
      "utf-8",
    );
    const reader = createConfigReader(configDir);

    const first = await reader.readConfig();
    expect(first.baseDir).toBe("/orig");

    await reader.writeConfig({ ...first, baseDir: "/updated" });

    const after = await reader.readConfig();
    expect(after.baseDir).toBe("/updated");
  });

  it("creates and returns the default config when no file exists, then caches it", async () => {
    const configDir = await createTempConfigDir();
    const reader = createConfigReader(configDir);

    const first = await reader.readConfig();
    expect(first.baseDir).toBeDefined();

    const second = await reader.readConfig();
    expect(second).toBe(first);
  });
});

describe("resolveConfigDir", () => {
  const FAKE_HOME = "/home/fake";

  beforeEach(() => {
    vi.stubEnv("CC_CONFIG_DIR", "");
    vi.stubEnv("CC_ENV", "");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns CC_CONFIG_DIR verbatim when set, ignoring CC_ENV and platform", () => {
    vi.stubEnv("CC_CONFIG_DIR", "/explicit/override");
    vi.stubEnv("CC_ENV", "dev");
    vi.spyOn(os, "platform").mockReturnValue("linux");

    expect(resolveConfigDir()).toBe("/explicit/override");
  });

  it("uses cc-dev suffix when CC_ENV=dev on Linux without XDG_CONFIG_HOME", () => {
    vi.stubEnv("CC_ENV", "dev");
    vi.spyOn(os, "platform").mockReturnValue("linux");

    expect(resolveConfigDir()).toBe(path.join(FAKE_HOME, ".config", "cc-dev"));
  });

  it("uses cc suffix when CC_ENV is unset on Linux without XDG_CONFIG_HOME", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");

    expect(resolveConfigDir()).toBe(path.join(FAKE_HOME, ".config", "cc"));
  });

  it("uses cc suffix when CC_ENV=prod even if NODE_ENV=development", () => {
    vi.stubEnv("CC_ENV", "prod");
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(os, "platform").mockReturnValue("linux");

    expect(resolveConfigDir()).toBe(path.join(FAKE_HOME, ".config", "cc"));
  });

  it("ignores NODE_ENV: cc suffix when CC_ENV unset and NODE_ENV=development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(os, "platform").mockReturnValue("linux");

    expect(resolveConfigDir()).toBe(path.join(FAKE_HOME, ".config", "cc"));
  });

  it("prefers XDG_CONFIG_HOME over ~/.config on Linux", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg/conf");
    vi.spyOn(os, "platform").mockReturnValue("linux");

    expect(resolveConfigDir()).toBe(path.join("/xdg/conf", "cc"));
  });

  it("uses Library/Application Support on macOS with cc-dev suffix when CC_ENV=dev", () => {
    vi.stubEnv("CC_ENV", "dev");
    vi.spyOn(os, "platform").mockReturnValue("darwin");

    expect(resolveConfigDir()).toBe(
      path.join(FAKE_HOME, "Library", "Application Support", "cc-dev"),
    );
  });
});
