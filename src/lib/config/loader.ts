import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
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
import {
  clampEffortToModel,
  getCodexReasoningLevelsForModel,
  type CodexReasoningEffort,
} from "@/lib/agent-backends/schemas";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

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
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 3_600_000,
      },
      codex: {
        fastMode: false,
        model: "gpt-5.4",
        reasoningEffort: "high",
        timeoutMs: null,
      },
    },
    defaultAgentBackend: "claude",
    preMergeTimeoutMs: 300_000,
    maxConcurrentQueries: 3,
    tailscaleEnabled: true,
    workflowDefaults: {
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
      contextValidator: {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      scriptValidator: {
        enabled: false,
      },
      humanApprovalGate: {
        enabled: false,
      },
      askUserQuestions: {
        enabled: false,
      },
      iterationPolicy: {
        maxIterations: 20,
        continuity: { enabled: true },
      },
      circuitBreaker: {
        consecutiveFailureThreshold: 3,
      },
      mutability: {
        allowAgentTaskAdd: false,
      },
      planRepair: {
        enabled: true,
        maxAttemptsPerContext: 2,
      },
      collaboration: {
        enabled: false,
        secondAgent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        negotiationRounds: 3,
        autonomousResolutionThreshold: "minor",
      },
    },
    compaction: {
      backend: "claude",
      conversationModel: "sonnet",
      messageModel: "sonnet",
      effort: "medium",
      timeoutMs: 180_000,
    },
    conversationNaming: {
      enabled: true,
      backend: "claude",
      model: "haiku",
      effort: "low",
      timeoutMs: null,
    },
  };
}

function resolveDefaultCodexEffort(
  model: string,
): CodexReasoningEffort | undefined {
  const supported = getCodexReasoningLevelsForModel(model);
  if (supported === null || supported.includes("high")) return "high";
  return supported.at(-1);
}

export function materializeGlobalConfig(
  rawConfig: RawGlobalConfig,
): GlobalConfig {
  const merged = mergeConfigWithDefaults(defaultConfig(), rawConfig);
  const rawClaude = rawConfig.agentBackends?.claude;
  const rawCodex = rawConfig.agentBackends?.codex;

  if (rawClaude?.reasoningEffort === undefined) {
    const effort = clampEffortToModel(
      "high",
      merged.agentBackends.claude.model,
    );
    if (effort === undefined) {
      delete merged.agentBackends.claude.reasoningEffort;
    } else {
      merged.agentBackends.claude.reasoningEffort = effort;
    }
  }

  if (rawCodex?.reasoningEffort === undefined) {
    merged.agentBackends.codex.reasoningEffort = resolveDefaultCodexEffort(
      merged.agentBackends.codex.model,
    );
  }

  return globalConfigSchema.parse(merged);
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
      const json = JSON.stringify(config, null, 2);
      await writeFile(configFile, json, "utf-8");
      configCache = null;
    },

    async writeRawConfig(config: RawGlobalConfig): Promise<void> {
      await ensureDir();
      const json = JSON.stringify(config, null, 2);
      await writeFile(configFile, json, "utf-8");
      configCache = null;
      log.info("config.raw_write", {
        fieldCount: Object.keys(config).length,
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
