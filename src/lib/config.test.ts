import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const TEST_DIR = path.join("/tmp", "csm-config-test-" + Date.now());

// Mock the config dir to use our test directory
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      platform: () => "linux",
      homedir: () => TEST_DIR,
    },
    platform: () => "linux",
    homedir: () => TEST_DIR,
  };
});

// Clear module cache before each test so config dir re-initializes
beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("config", () => {
  it("readConfig creates default config when none exists", async () => {
    const { readConfig } = await import("./config");
    const config = await readConfig();

    expect(config.baseDir).toContain("projects");
    expect(config.claudeTimeoutMs).toBe(3_600_000);
    expect(config.ignorePatterns).toContain("node_modules");
    expect(typeof config.stateFilePath).toBe("string");
  });

  it("readConfig returns saved config after writeConfig", async () => {
    const { readConfig, writeConfig } = await import("./config");
    const original = await readConfig();

    const modified = {
      ...original,
      baseDir: "/custom/path",
      claudeTimeoutMs: 60_000,
    };
    await writeConfig(modified);

    const reread = await readConfig();
    expect(reread.baseDir).toBe("/custom/path");
    expect(reread.claudeTimeoutMs).toBe(60_000);
  });

  it("readConfig merges defaults for missing fields in older configs", async () => {
    const { readConfig, getConfigDirPath } = await import("./config");
    // First create the config dir
    await readConfig();

    const configDir = getConfigDirPath();
    const configFile = path.join(configDir, "config.json");

    // Write a partial config (simulating an older version)
    await writeFile(
      configFile,
      JSON.stringify({ baseDir: "/old/path" }),
      "utf-8",
    );

    vi.resetModules();
    const { readConfig: readAgain } = await import("./config");
    const config = await readAgain();

    expect(config.baseDir).toBe("/old/path");
    // claudeTimeoutMs should get the default
    expect(config.claudeTimeoutMs).toBe(3_600_000);
  });

  it("getConfigDirPath returns a path under home", async () => {
    const { getConfigDirPath } = await import("./config");
    const dir = getConfigDirPath();
    expect(dir).toContain(TEST_DIR);
  });

  it("getConfigDirPath follows Linux XDG convention when platform is linux", async () => {
    // OS mock is set to linux, no XDG_CONFIG_HOME set
    const { getConfigDirPath } = await import("./config");
    const dir = getConfigDirPath();
    expect(dir).toBe(path.join(TEST_DIR, ".config", "csm"));
  });

  it("readConfig handles malformed config by merging valid fields with defaults", async () => {
    const { readConfig, getConfigDirPath } = await import("./config");
    // Create the config dir first
    await readConfig();

    const configDir = getConfigDirPath();
    const configFile = path.join(configDir, "config.json");

    // Write a config with one valid field and one extra unknown field
    await writeFile(
      configFile,
      JSON.stringify({ baseDir: "/valid/path", unknownField: "ignored" }),
      "utf-8",
    );

    vi.resetModules();
    const { readConfig: readAgain } = await import("./config");
    const config = await readAgain();

    expect(config.baseDir).toBe("/valid/path");
    // Defaults fill in missing fields
    expect(config.claudeTimeoutMs).toBe(3_600_000);
    expect(config.ignorePatterns).toContain("node_modules");
  });

  it("readConfig creates default config with expected ignore patterns", async () => {
    const { readConfig } = await import("./config");
    const config = await readConfig();

    const expectedPatterns = [
      "node_modules",
      ".next",
      "dist",
      "build",
      "target",
      ".cache",
      ".turbo",
      ".venv",
    ];
    expect(config.ignorePatterns).toEqual(expectedPatterns);
  });
});
