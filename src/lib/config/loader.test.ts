import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createConfigReader,
  materializeGlobalConfig,
  resolveConfigDir,
} from "./loader";
import { resolveMemoryConfig } from "./schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";

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
  it("seeds the global validation budget defaults", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(path.join(configDir, "config.json"), "{}", "utf-8");

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.validation).toEqual({
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    });
  });

  it("keeps an explicit validation limit while defaulting the timeout", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ validation: { concurrencyLimit: 4 } }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.validation).toEqual({
      concurrencyLimit: 4,
      defaultTimeoutMs: 600_000,
    });
  });

  /**
   * The global fallback and `SEEDED_WORKFLOW_DEFAULTS` must be the SAME
   * defaults, not two literals that happen to agree today. A second copy is how
   * a newly-seeded workflow default (`mutability.allowAgentContextAdd`, the
   * D4 expansion authority flag) silently means one thing to the cascade
   * resolver and another to a config file that never mentions it.
   */
  it("falls back to the canonical seeded workflow defaults, not a second copy", async () => {
    const configDir = await createTempConfigDir();
    const reader = createConfigReader(configDir);

    const config = await reader.readConfig();

    expect(config.workflowDefaults).toEqual(SEEDED_WORKFLOW_DEFAULTS);
  });

  it("merges partial workflowDefaults from disk with seeded defaults", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        workflowDefaults: {
          scriptValidator: { commands: ["pre-merge"] },
        },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();
    expect(config.workflowDefaults).toBeDefined();

    expect(config.workflowDefaults?.scriptValidator).toEqual({
      commands: ["pre-merge"],
    });
    expect(config.workflowDefaults?.implementer).toBeDefined();
    expect(config.workflowDefaults?.iterationPolicy).toBeDefined();
    expect(config.workflowDefaults?.circuitBreaker).toBeDefined();
    expect(config.workflowDefaults?.mutability).toBeDefined();
  });

  it("returns partial workflowDefaults from readRawConfig without rejecting them", async () => {
    const configDir = await createTempConfigDir();
    const rawConfig = {
      workflowDefaults: {
        scriptValidator: { commands: ["pre-merge"] },
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

  it("materializes independent Claude and Codex defaults", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({}),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.defaultAgentBackend).toBe("claude");
    expect(config.agentBackends).toEqual({
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: 3_600_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
        timeoutMs: null,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    });
  });

  it("reads a complete Codex model selection from disk", async () => {
    const configDir = await createTempConfigDir();
    const modelSelection = {
      modelId: "gpt-5.4",
      parameters: { fast: "true", reasoning: "high" },
    };
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ agentBackends: { codex: { modelSelection } } }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);

    await expect(reader.readConfig()).resolves.toMatchObject({
      agentBackends: { codex: { modelSelection } },
    });
    await expect(reader.readRawConfig()).resolves.toMatchObject({
      agentBackends: { codex: { modelSelection } },
    });
  });

  it("admits a custom Codex model only when it is the configured Codex profile", () => {
    const configuredSelection = {
      modelId: "company-codex-model",
      parameters: { reasoning: "high", fast: "false" },
    };

    expect(() =>
      materializeGlobalConfig({
        agentBackends: { codex: { modelSelection: configuredSelection } },
        conversationNaming: {
          enabled: true,
          backend: "codex",
          modelSelection: {
            modelId: "request-supplied-model",
            parameters: { reasoning: "high", fast: "false" },
          },
          timeoutMs: null,
        },
      }),
    ).toThrow(/request-supplied-model.*not present/i);

    expect(
      materializeGlobalConfig({
        agentBackends: { codex: { modelSelection: configuredSelection } },
        conversationNaming: {
          enabled: true,
          backend: "codex",
          modelSelection: configuredSelection,
          timeoutMs: null,
        },
      }).conversationNaming?.modelSelection,
    ).toEqual(configuredSelection);
  });

  it("canonicalizes model aliases throughout the materialized config", () => {
    const aliasSelection = {
      modelId: "composer-latest",
      parameters: { fast: "true" },
    };

    const config = materializeGlobalConfig({
      agentBackends: { cursor: { modelSelection: aliasSelection } },
      conversationNaming: {
        enabled: true,
        backend: "cursor",
        modelSelection: aliasSelection,
        timeoutMs: null,
      },
    });

    expect(config.agentBackends.cursor.modelSelection.modelId).toBe(
      "composer-2.5",
    );
    expect(config.conversationNaming?.modelSelection.modelId).toBe(
      "composer-2.5",
    );
  });

  it("canonicalizes aliases at both config persistence boundaries", async () => {
    const configDir = await createTempConfigDir();
    const reader = createConfigReader(configDir);
    const aliasSelection = {
      modelId: "composer-latest",
      parameters: { fast: "true" },
    };

    await reader.writeRawConfig({
      agentBackends: { cursor: { modelSelection: aliasSelection } },
    });
    expect(
      JSON.parse(await readFile(path.join(configDir, "config.json"), "utf-8"))
        .agentBackends.cursor.modelSelection.modelId,
    ).toBe("composer-2.5");

    const config = await reader.readConfig();
    config.agentBackends.cursor.modelSelection = aliasSelection;
    await reader.writeConfig(config);
    expect(
      JSON.parse(await readFile(path.join(configDir, "config.json"), "utf-8"))
        .agentBackends.cursor.modelSelection.modelId,
    ).toBe("composer-2.5");
  });

  it("reads agentBackends.codex.pricing rate overrides from disk", async () => {
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
      JSON.stringify({ agentBackends: { codex: { pricing } } }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.agentBackends.codex.pricing).toEqual(pricing);
  });

  it("round-trips the file-only Command Center project override", async () => {
    const configDir = await createTempConfigDir();
    const rawConfig = {
      baseDir: "/projects",
      commandCenterProjectName: "command-center",
    };
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(rawConfig),
      "utf-8",
    );

    const reader = createConfigReader(configDir);

    await expect(reader.readRawConfig()).resolves.toEqual(rawConfig);
    await expect(reader.readConfig()).resolves.toMatchObject(rawConfig);
  });

  it("reads Codex timeout fields from its backend profile", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        agentBackends: {
          codex: { timeoutMs: 300_000, stallTimeoutMs: 60_000 },
        },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.agentBackends.codex.timeoutMs).toBe(300_000);
    expect(config.agentBackends.codex.stallTimeoutMs).toBe(60_000);
  });

  it("round-trips a sparse Claude stall override without materializing profile defaults", async () => {
    const configDir = await createTempConfigDir();
    const rawConfig = {
      agentBackends: {
        claude: { stallTimeoutMs: 900_000 },
      },
    };
    const reader = createConfigReader(configDir);

    await reader.writeRawConfig(rawConfig);

    await expect(reader.readRawConfig()).resolves.toEqual(rawConfig);
    const config = await reader.readConfig();
    expect(config.agentBackends.claude.stallTimeoutMs).toBe(900_000);
  });

  it("does not merge default parameters into an explicit model selection", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        agentBackends: {
          claude: {
            modelSelection: { modelId: "haiku", parameters: {} },
          },
        },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();

    expect(config.agentBackends.claude).toEqual({
      modelSelection: { modelId: "haiku", parameters: {} },
      timeoutMs: 3_600_000,
    });
  });

  it("refuses a structurally valid backend selection that is not a complete catalog variant", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        agentBackends: {
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: {},
            },
          },
        },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);

    await expect(reader.readConfig()).rejects.toThrow(
      /Parameter "fast" is required/,
    );
  });

  it.each([
    [
      "compaction",
      {
        compaction: {
          backend: "cursor",
          conversationModelSelection: {
            modelId: "composer-2.5",
            parameters: {},
          },
          messageModelSelection: {
            modelId: "composer-2.5",
            parameters: {},
          },
        },
      },
    ],
    [
      "conversation naming",
      {
        conversationNaming: {
          backend: "claude",
          modelSelection: { modelId: "opus", parameters: {} },
        },
      },
    ],
    [
      "workflow defaults",
      {
        workflowDefaults: {
          implementer: {
            ...SEEDED_WORKFLOW_DEFAULTS.implementer,
            agent: {
              backend: "claude",
              modelSelection: { modelId: "opus", parameters: {} },
            },
          },
        },
      },
    ],
  ])("refuses an invalid %s model selection", async (_label, rawConfig) => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(rawConfig),
      "utf-8",
    );

    await expect(createConfigReader(configDir).readConfig()).rejects.toThrow(
      /Parameter ("fast"|"effort") is required/,
    );
  });

  it("preserves sparse backend fields when reading raw config", async () => {
    const configDir = await createTempConfigDir();
    const rawConfig = {
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
        codex: { timeoutMs: null },
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

  it("round-trips sparse Codex extras without materializing profile defaults", async () => {
    const configDir = await createTempConfigDir();
    const pricing = {
      "custom-codex-model": {
        inputPerMillion: 1,
        cachedInputPerMillion: 0.1,
        outputPerMillion: 5,
      },
    };
    const rawConfig = {
      agentBackends: {
        codex: { stallTimeoutMs: null, pricing },
      },
    };
    const reader = createConfigReader(configDir);

    await reader.writeRawConfig(rawConfig);

    await expect(reader.readRawConfig()).resolves.toEqual(rawConfig);
  });

  it("rejects legacy config paths instead of silently stripping them", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ defaultModel: "sonnet" }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);

    await expect(reader.readConfig()).rejects.toThrow(
      /agentBackends\.claude\.model/,
    );
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

describe("memory index budget default (spec memory R10.3)", () => {
  it("parses to 20480 bytes and 120 hooks when memory.indexBudget is absent", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(path.join(configDir, "config.json"), "{}", "utf-8");

    const config = await createConfigReader(configDir).readConfig();

    expect(resolveMemoryConfig(config).indexBudget).toEqual({
      bytes: 20480,
      hooks: 120,
    });
  });

  it("keeps the same default when a memory section states only its policy", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ memory: { conversations: { read: "off" } } }),
      "utf-8",
    );

    const config = await createConfigReader(configDir).readConfig();

    expect(resolveMemoryConfig(config).indexBudget).toEqual({
      bytes: 20480,
      hooks: 120,
    });
  });
});
