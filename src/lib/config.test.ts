import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader, resolveBranchPrefix } from "./config";
import { globalConfigSchema, perRepoConfigSchema } from "./schemas";

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

  it("readConfig preserves branchPrefix when set", async () => {
    const reader = createConfigReader(TEST_DIR);
    const original = await reader.readConfig();

    const modified = { ...original, branchPrefix: "dev" };
    await reader.writeConfig(modified);

    const reread = await reader.readConfig();
    expect(reread.branchPrefix).toBe("dev");
  });
});

describe("schema: branchPrefix field", () => {
  it("globalConfigSchema accepts branchPrefix", () => {
    const result = globalConfigSchema
      .partial()
      .safeParse({ branchPrefix: "dev" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branchPrefix).toBe("dev");
    }
  });

  it("globalConfigSchema allows omitted branchPrefix", () => {
    const result = globalConfigSchema.partial().safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branchPrefix).toBeUndefined();
    }
  });

  it("perRepoConfigSchema accepts branchPrefix", () => {
    const result = perRepoConfigSchema.safeParse({
      initScriptPath: null,
      branchPrefix: "feature",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branchPrefix).toBe("feature");
    }
  });

  it("perRepoConfigSchema allows omitted branchPrefix", () => {
    const result = perRepoConfigSchema.safeParse({ initScriptPath: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branchPrefix).toBeUndefined();
    }
  });
});

describe("schema: codex config block", () => {
  it("globalConfigSchema accepts valid codex block", () => {
    const result = globalConfigSchema.partial().safeParse({
      codex: {
        enabled: true,
        model: "o3",
        reasoningEffort: "medium",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.codex?.enabled).toBe(true);
      expect(result.data.codex?.model).toBe("o3");
      expect(result.data.codex?.reasoningEffort).toBe("medium");
    }
  });

  it("globalConfigSchema rejects invalid reasoningEffort", () => {
    const result = globalConfigSchema.partial().safeParse({
      codex: {
        enabled: true,
        reasoningEffort: "turbo",
      },
    });
    expect(result.success).toBe(false);
  });

  it("globalConfigSchema allows omitted codex block", () => {
    const result = globalConfigSchema.partial().safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.codex).toBeUndefined();
    }
  });

  it("enabled defaults to false when omitted inside the block", () => {
    const result = globalConfigSchema.partial().safeParse({
      codex: { model: "o3" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.codex?.enabled).toBe(false);
    }
  });

  it("readConfig preserves codex block on round-trip", async () => {
    const reader = createConfigReader(TEST_DIR);
    const original = await reader.readConfig();

    const modified = {
      ...original,
      codex: {
        enabled: true,
        model: "gpt-5-codex",
        reasoningEffort: "high" as const,
      },
    };
    await reader.writeConfig(modified);

    const reread = await reader.readConfig();
    expect(reread.codex?.enabled).toBe(true);
    expect(reread.codex?.model).toBe("gpt-5-codex");
    expect(reread.codex?.reasoningEffort).toBe("high");
  });
});

describe("resolveBranchPrefix", () => {
  it("returns 'csm' when neither config has branchPrefix", () => {
    expect(resolveBranchPrefix({}, null)).toBe("csm");
  });

  it("returns global value when only global has branchPrefix", () => {
    expect(resolveBranchPrefix({ branchPrefix: "dev" }, null)).toBe("dev");
  });

  it("returns per-project value when only per-project has it", () => {
    expect(resolveBranchPrefix({}, { branchPrefix: "feature" })).toBe(
      "feature",
    );
  });

  it("per-project overrides global", () => {
    expect(
      resolveBranchPrefix({ branchPrefix: "dev" }, { branchPrefix: "feature" }),
    ).toBe("feature");
  });

  it("returns 'csm' when repoConfig is null", () => {
    expect(resolveBranchPrefix({}, null)).toBe("csm");
  });

  it("returns 'csm' when repoConfig is undefined", () => {
    expect(resolveBranchPrefix({})).toBe("csm");
  });
});
