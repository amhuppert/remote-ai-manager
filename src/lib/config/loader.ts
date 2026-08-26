import { readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveConfigDirFrom } from "./config-dir";
import {
  globalConfigSchema,
  rawGlobalConfigSchema,
  type RawGlobalConfig,
} from "./schemas";
import { intersectKeys, mergeConfigWithDefaults } from "./cascade";
import type { GlobalConfig } from "@/lib/config/schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import { CURSOR_DEFAULT_MODEL } from "@/lib/agent-backends/cursor/model-policy";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import {
  ModelSelectionPolicyError,
  validateModelSelection,
} from "@/lib/agent-backends/model-selection";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";

/**
 * Resolve the config directory for Command Center.
 *
 * Priority:
 * 1. CC_CONFIG_DIR env var (explicit override)
 * 2. OS-appropriate default, with "cc-dev" suffix when CC_ENV=dev
 *    to isolate dev server state from production.
 *
 * CC_ENV is intentionally separate from NODE_ENV: NODE_ENV is held at
 * "development" project-wide for tooling reasons (test/build resolution),
 * so it is not a reliable signal for dev-vs-prod runtime state. CC_ENV is
 * set explicitly by the `dev` script and nowhere else.
 */
export function resolveConfigDir(): string {
  return resolveConfigDirFrom(process.env, {
    platform: os.platform(),
    homedir: os.homedir(),
  });
}

const CONFIG_DIR = resolveConfigDir();

/** Default global config values */
function defaultConfig(): GlobalConfig {
  return {
    baseDir: path.join(os.homedir(), "projects"),
    ignorePatterns: [
      ".git",
      ".worktrees",
      "node_modules",
      ".next",
      ".turbo",
      ".nuxt",
      ".output",
      ".svelte-kit",
      ".parcel-cache",
      "dist",
      "build",
      "out",
      "bin",
      "obj",
      "coverage",
      ".nyc_output",
      "storybook-static",
      ".cache",
      ".eslintcache",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".tox",
      "target",
      "__pycache__",
      ".venv",
      "venv",
      "vendor",
      ".gradle",
      "Pods",
      ".terraform",
      ".serverless",
      ".vscode",
      ".idea",
      ".cursor",
      "**/.DS_Store",
      "**/Thumbs.db",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
      "bun.lockb",
      "**/*.png",
      "**/*.jpg",
      "**/*.jpeg",
      "**/*.gif",
      "**/*.ico",
      "**/*.svg",
      "**/*.webp",
      "**/*.bmp",
      "**/*.tiff",
      "**/*.heic",
      "**/*.mp4",
      "**/*.mov",
      "**/*.avi",
      "**/*.mkv",
      "**/*.mp3",
      "**/*.wav",
      "**/*.flac",
      "**/*.ogg",
      "**/*.woff",
      "**/*.woff2",
      "**/*.ttf",
      "**/*.eot",
      "**/*.zip",
      "**/*.tar",
      "**/*.gz",
      "**/*.7z",
      "**/*.rar",
      "**/*.pdf",
      "**/*.exe",
      "**/*.dll",
      "**/*.so",
      "**/*.dylib",
      "**/*.class",
      "**/*.jar",
      "**/*.pyc",
      "**/*.o",
      "**/*.a",
      "**/*.wasm",
    ],
    agentBackends: {
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
      // The evidence-backed Cursor default (spec D10). Stated explicitly rather
      // than left to provider auto-selection, so what a run uses is what
      // Command Center chose.
      cursor: {
        modelSelection: {
          modelId: CURSOR_DEFAULT_MODEL,
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
    defaultAgentBackend: "claude",
    preMergeTimeoutMs: 300_000,
    maxConcurrentQueries: 3,
    tailscaleEnabled: true,
    // The cascade resolver's global-layer fallback IS the disk-absent default —
    // one literal, so a newly-seeded workflow default cannot mean one thing to
    // the resolver and another to a config file that never mentions it. Cloned
    // because callers merge disk config into the returned object.
    workflowDefaults: structuredClone(SEEDED_WORKFLOW_DEFAULTS),
    compaction: {
      backend: "claude",
      conversationModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      messageModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      timeoutMs: 180_000,
    },
    validation: {
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    },
    conversationNaming: {
      enabled: true,
      backend: "claude",
      modelSelection: { modelId: "haiku", parameters: {} },
      timeoutMs: null,
    },
  };
}

export function materializeGlobalConfig(
  rawConfig: RawGlobalConfig,
): GlobalConfig {
  const merged = mergeConfigWithDefaults(defaultConfig(), rawConfig);
  for (const backend of ["claude", "codex", "cursor"] as const) {
    const explicit = rawConfig.agentBackends?.[backend]?.modelSelection;
    if (explicit !== undefined) {
      merged.agentBackends[backend].modelSelection = structuredClone(explicit);
    }
  }
  const rawCompaction = rawConfig.compaction;
  if (rawCompaction?.conversationModelSelection !== undefined) {
    merged.compaction!.conversationModelSelection = structuredClone(
      rawCompaction.conversationModelSelection,
    );
  }
  if (rawCompaction?.messageModelSelection !== undefined) {
    merged.compaction!.messageModelSelection = structuredClone(
      rawCompaction.messageModelSelection,
    );
  }
  if (rawConfig.conversationNaming?.modelSelection !== undefined) {
    merged.conversationNaming!.modelSelection = structuredClone(
      rawConfig.conversationNaming.modelSelection,
    );
  }
  const rawWorkflowDefaults = rawConfig.workflowDefaults;
  if (rawWorkflowDefaults?.implementer?.agent.modelSelection !== undefined) {
    merged.workflowDefaults!.implementer.agent.modelSelection = structuredClone(
      rawWorkflowDefaults.implementer.agent.modelSelection,
    );
  }
  if (rawWorkflowDefaults?.contextValidator?.assignments !== undefined) {
    for (const [
      index,
      assignment,
    ] of rawWorkflowDefaults.contextValidator.assignments.entries()) {
      merged.workflowDefaults!.contextValidator.assignments[
        index
      ]!.agent.modelSelection = structuredClone(
        assignment.agent.modelSelection,
      );
    }
  }
  if (rawWorkflowDefaults?.collaboration?.secondAgent !== undefined) {
    merged.workflowDefaults!.collaboration.secondAgent.modelSelection =
      structuredClone(
        rawWorkflowDefaults.collaboration.secondAgent.modelSelection,
      );
  }
  if (rawWorkflowDefaults?.planRepair?.agent !== undefined) {
    merged.workflowDefaults!.planRepair.agent!.modelSelection = structuredClone(
      rawWorkflowDefaults.planRepair.agent.modelSelection,
    );
  }

  const config = globalConfigSchema.parse(merged);
  canonicalizeGlobalModelSelections(config);
  return config;
}

function canonicalSelection(
  catalog: BackendModelCatalog,
  selection: BackendModelSelection,
): BackendModelSelection {
  const validation = validateModelSelection(catalog, selection);
  if (!validation.valid) {
    throw new ModelSelectionPolicyError(validation.issues);
  }
  return validation.selection;
}

function canonicalizeGlobalModelSelections(config: GlobalConfig): void {
  const catalogs = Object.fromEntries(
    (["claude", "codex", "cursor"] as const).map((backend) => [
      backend,
      getConfiguredBackendModelCatalog(
        backend,
        config.agentBackends[backend].modelSelection,
      ),
    ]),
  ) as Record<"claude" | "codex" | "cursor", BackendModelCatalog>;

  for (const backend of ["claude", "codex", "cursor"] as const) {
    config.agentBackends[backend].modelSelection = canonicalSelection(
      catalogs[backend],
      config.agentBackends[backend].modelSelection,
    );
  }

  if (config.compaction !== undefined) {
    const catalog = catalogs[config.compaction.backend];
    config.compaction.conversationModelSelection = canonicalSelection(
      catalog,
      config.compaction.conversationModelSelection,
    );
    config.compaction.messageModelSelection = canonicalSelection(
      catalog,
      config.compaction.messageModelSelection,
    );
  }

  if (config.conversationNaming !== undefined) {
    config.conversationNaming.modelSelection = canonicalSelection(
      catalogs[config.conversationNaming.backend],
      config.conversationNaming.modelSelection,
    );
  }

  const workflowDefaults = config.workflowDefaults;
  if (workflowDefaults === undefined) return;
  const workflowAgents = [
    workflowDefaults.implementer.agent,
    ...workflowDefaults.contextValidator.assignments.map(
      (assignment) => assignment.agent,
    ),
    workflowDefaults.collaboration.secondAgent,
    ...(workflowDefaults.planRepair.agent === undefined
      ? []
      : [workflowDefaults.planRepair.agent]),
  ];
  for (const agent of workflowAgents) {
    agent.modelSelection = canonicalSelection(
      catalogs[agent.backend],
      agent.modelSelection,
    );
  }
}

/**
 * Canonicalize every explicitly persisted selection while preserving the raw
 * config's explicit-only shape.
 */
export function canonicalizeRawGlobalConfig(
  rawConfig: RawGlobalConfig,
): RawGlobalConfig {
  const config = materializeGlobalConfig(rawConfig);
  const canonical = structuredClone(rawConfig);

  for (const backend of ["claude", "codex", "cursor"] as const) {
    if (canonical.agentBackends?.[backend]?.modelSelection === undefined) {
      continue;
    }
    canonical.agentBackends[backend]!.modelSelection = structuredClone(
      config.agentBackends[backend].modelSelection,
    );
  }

  if (canonical.compaction?.conversationModelSelection !== undefined) {
    canonical.compaction.conversationModelSelection = structuredClone(
      config.compaction!.conversationModelSelection,
    );
  }
  if (canonical.compaction?.messageModelSelection !== undefined) {
    canonical.compaction.messageModelSelection = structuredClone(
      config.compaction!.messageModelSelection,
    );
  }
  if (canonical.conversationNaming?.modelSelection !== undefined) {
    canonical.conversationNaming.modelSelection = structuredClone(
      config.conversationNaming!.modelSelection,
    );
  }

  const rawWorkflowDefaults = canonical.workflowDefaults;
  const workflowDefaults = config.workflowDefaults;
  if (
    rawWorkflowDefaults?.implementer?.agent.modelSelection !== undefined &&
    workflowDefaults !== undefined
  ) {
    rawWorkflowDefaults.implementer.agent.modelSelection = structuredClone(
      workflowDefaults.implementer.agent.modelSelection,
    );
  }
  if (
    rawWorkflowDefaults?.contextValidator?.assignments !== undefined &&
    workflowDefaults !== undefined
  ) {
    for (const [
      index,
      assignment,
    ] of rawWorkflowDefaults.contextValidator.assignments.entries()) {
      assignment.agent.modelSelection = structuredClone(
        workflowDefaults.contextValidator.assignments[index]!.agent
          .modelSelection,
      );
    }
  }
  if (
    rawWorkflowDefaults?.collaboration?.secondAgent !== undefined &&
    workflowDefaults !== undefined
  ) {
    rawWorkflowDefaults.collaboration.secondAgent.modelSelection =
      structuredClone(
        workflowDefaults.collaboration.secondAgent.modelSelection,
      );
  }
  if (
    rawWorkflowDefaults?.planRepair?.agent !== undefined &&
    workflowDefaults?.planRepair.agent !== undefined
  ) {
    rawWorkflowDefaults.planRepair.agent.modelSelection = structuredClone(
      workflowDefaults.planRepair.agent.modelSelection,
    );
  }

  return canonical;
}

/* ------------------------------------------------------------------ */
/*  Config reader factory                                             */
/* ------------------------------------------------------------------ */

export interface ConfigReader {
  readConfig(): Promise<GlobalConfig>;
  readRawConfig(): Promise<RawGlobalConfig>;
  writeConfig(config: GlobalConfig): Promise<void>;
  writeRawConfig(config: RawGlobalConfig): Promise<void>;
  getConfigDirPath(): string;
}

/**
 * Create a config reader that reads/writes from a specific config directory.
 * Useful for testing with temp directories without mocking fs or os.
 */
export function createConfigReader(configDir: string): ConfigReader {
  const configFile = path.join(configDir, "config.json");
  const log = createLogger("config");

  async function ensureDir(): Promise<void> {
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }
  }

  // Parsed-config cache invalidated by the file's (mtime, size) token, mirroring
  // the diff and transcript caches. The merged config is re-read only when the
  // file changes on disk; every write through this reader nulls the cache so a
  // same-size rewrite within one mtime tick can't serve a stale parse.
  let configCache: {
    mtimeMs: number;
    size: number;
    config: GlobalConfig;
  } | null = null;

  return {
    async readConfig(): Promise<GlobalConfig> {
      let fileStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        fileStat = await stat(configFile);
      } catch {
        fileStat = null;
      }

      if (fileStat === null) {
        await ensureDir();
        const config = defaultConfig();
        await this.writeConfig(config);
        const written = await stat(configFile);
        configCache = {
          mtimeMs: written.mtimeMs,
          size: written.size,
          config,
        };
        return config;
      }

      const cached = configCache;
      if (
        cached !== null &&
        cached.mtimeMs === fileStat.mtimeMs &&
        cached.size === fileStat.size
      ) {
        return cached.config;
      }

      const raw = await readFile(configFile, "utf-8");
      const parsed = rawGlobalConfigSchema.parse(JSON.parse(raw));
      const config = materializeGlobalConfig(parsed);
      configCache = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        config,
      };
      return config;
    },

    async readRawConfig(): Promise<RawGlobalConfig> {
      if (!existsSync(configFile)) {
        log.debug("config.raw_read", { exists: false, configDir });
        return {};
      }

      let parsed: unknown;
      try {
        const contents = await readFile(configFile, "utf-8");
        parsed = JSON.parse(contents);
      } catch (err) {
        log.warn("config.raw_read_error", {
          error: getErrorMessage(err),
          configDir,
        });
        return {};
      }

      const result = rawGlobalConfigSchema.safeParse(parsed);
      if (!result.success) {
        log.warn("config.raw_validation_error", {
          error: result.error.message,
          configDir,
        });
        return {};
      }

      // Zod .default() fills in values for missing keys at every nesting
      // level. Intersect the validated result with the original JSON keys
      // recursively so callers can distinguish explicit config from
      // schema defaults.
      const filtered = intersectKeys(parsed, result.data) as RawGlobalConfig;

      log.debug("config.raw_read", {
        exists: true,
        fieldCount: Object.keys(filtered).length,
        configDir,
      });
      return filtered;
    },

    async writeConfig(config: GlobalConfig): Promise<void> {
      await ensureDir();
      const canonical = globalConfigSchema.parse(structuredClone(config));
      canonicalizeGlobalModelSelections(canonical);
      // Atomic temp-then-rename, not a truncating write: this file is read
      // concurrently by every other Command Center process, and a plain
      // `writeFile` leaves a window where a reader observes it truncated and
      // fails on `JSON.parse("")`.
      await atomicWriteJson(configFile, canonical);
      configCache = null;
    },

    async writeRawConfig(config: RawGlobalConfig): Promise<void> {
      await ensureDir();
      const canonical = canonicalizeRawGlobalConfig(config);
      await atomicWriteJson(configFile, canonical);
      configCache = null;
      log.info("config.raw_write", {
        fieldCount: Object.keys(canonical).length,
        configDir,
      });
    },

    getConfigDirPath(): string {
      return configDir;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Default singleton (backward-compatible module-level exports)      */
/* ------------------------------------------------------------------ */

// Lazily constructed so module-load never calls `createLogger` (the factory does)
// before `@/lib/logging` has finished initializing — loader and logging form an
// import cycle, so an eager top-level reader would read `createLogger` as
// undefined. First actual config access happens well after the graph is loaded.
let defaultReader: ConfigReader | null = null;
function getDefaultReader(): ConfigReader {
  if (defaultReader === null) {
    defaultReader = createConfigReader(CONFIG_DIR);
  }
  return defaultReader;
}

/** Read the global config, creating a default one if it doesn't exist */
export function readConfig(): Promise<GlobalConfig> {
  return getDefaultReader().readConfig();
}

/** Read the raw config from disk without merging defaults. Returns {} if file doesn't exist. */
export function readRawConfig(): Promise<RawGlobalConfig> {
  return getDefaultReader().readRawConfig();
}

/** Write raw (explicit-only) config to disk, replacing the entire file. */
export function writeRawConfig(config: RawGlobalConfig): Promise<void> {
  return getDefaultReader().writeRawConfig(config);
}

/** Write the global config to disk */
export function writeConfig(config: GlobalConfig): Promise<void> {
  return getDefaultReader().writeConfig(config);
}

/** Get the config directory path (for testing/diagnostics) */
export function getConfigDirPath(): string {
  return CONFIG_DIR;
}
