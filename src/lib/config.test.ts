import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "./config";

const TEST_DIR = path.join("/tmp", "cc-config-test-" + Date.now());

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("config", () => {
  it("readConfig creates default config when none exists", async () => {
    const reader = createConfigReader(TEST_DIR);
    const config = await reader.readConfig();

    expect(config.baseDir).toContain("projects");
    expect(config.claudeTimeoutMs).toBe(3_600_000);
    expect(config.ignorePatterns).toContain("node_modules");
    expect(typeof config.stateFilePath).toBe("string");
  });

  it("readConfig returns saved config after writeConfig", async () => {
    const reader = createConfigReader(TEST_DIR);
    const original = await reader.readConfig();

    const modified = {
      ...original,
      baseDir: "/custom/path",
      claudeTimeoutMs: 60_000,
    };
    await reader.writeConfig(modified);

    const reread = await reader.readConfig();
    expect(reread.baseDir).toBe("/custom/path");
    expect(reread.claudeTimeoutMs).toBe(60_000);
  });

  it("readConfig merges defaults for missing fields in older configs", async () => {
    const reader = createConfigReader(TEST_DIR);
    // First create the config dir + default config
    await reader.readConfig();

    const configFile = path.join(TEST_DIR, "config.json");

    // Write a partial config (simulating an older version)
    await writeFile(
      configFile,
      JSON.stringify({ baseDir: "/old/path" }),
      "utf-8",
    );

    // Fresh reader to pick up the modified file
    const freshReader = createConfigReader(TEST_DIR);
    const config = await freshReader.readConfig();

    expect(config.baseDir).toBe("/old/path");
    // claudeTimeoutMs should get the default
    expect(config.claudeTimeoutMs).toBe(3_600_000);
  });

  it("getConfigDirPath returns the configured directory", () => {
    const reader = createConfigReader(TEST_DIR);
    expect(reader.getConfigDirPath()).toBe(TEST_DIR);
  });

  it("stateFilePath defaults to configDir/state.json", async () => {
    const reader = createConfigReader(TEST_DIR);
    const config = await reader.readConfig();
    expect(config.stateFilePath).toBe(path.join(TEST_DIR, "state.json"));
  });

  it("readConfig handles malformed config by merging valid fields with defaults", async () => {
    const reader = createConfigReader(TEST_DIR);
    // Create the config dir first
    await reader.readConfig();

    const configFile = path.join(TEST_DIR, "config.json");

    // Write a config with one valid field and one extra unknown field
    await writeFile(
      configFile,
      JSON.stringify({ baseDir: "/valid/path", unknownField: "ignored" }),
      "utf-8",
    );

    const freshReader = createConfigReader(TEST_DIR);
    const config = await freshReader.readConfig();

    expect(config.baseDir).toBe("/valid/path");
    // Defaults fill in missing fields
    expect(config.claudeTimeoutMs).toBe(3_600_000);
    expect(config.ignorePatterns).toContain("node_modules");
  });

  it("readConfig creates default config with expected ignore patterns", async () => {
    const reader = createConfigReader(TEST_DIR);
    const config = await reader.readConfig();

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
