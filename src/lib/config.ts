import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { cache } from "react";
import { rawGlobalConfigSchema } from "./schemas";
import type { GlobalConfig, PerRepoConfig } from "@/types";
import { createLogger } from "@/lib/logging";

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
  const override = process.env["CC_CONFIG_DIR"];
  if (override) {
    return override;
  }

  const dirName = process.env["CC_ENV"] === "dev" ? "cc-dev" : "cc";

  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", dirName);
  }
  // Linux / other: use XDG_CONFIG_HOME or ~/.config
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) {
    return path.join(xdg, dirName);
  }
  return path.join(os.homedir(), ".config", dirName);
}

const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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
    claudeTimeoutMs: 3_600_000,
    defaultModel: "opus",
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
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigWithDefaults<T>(defaults: T, overrides: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(overrides)) {
    return (overrides === undefined ? defaults : overrides) as T;
  }

  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = mergeConfigWithDefaults(result[key], value);
  }
  return result as T;
}

/* ------------------------------------------------------------------ */
/*  Config reader factory                                             */
/* ------------------------------------------------------------------ */

export interface ConfigReader {
  readConfig(): Promise<GlobalConfig>;
  readRawConfig(): Promise<Partial<GlobalConfig>>;
  writeConfig(config: GlobalConfig): Promise<void>;
  writeRawConfig(config: Partial<GlobalConfig>): Promise<void>;
  getConfigDirPath(): string;
}

/**
 * Recursively intersect `validated` with only the keys present in `raw`.
 * For nested plain objects, recurse so that Zod-injected defaults inside
 * nested schemas (e.g. codexConfigSchema.enabled) are stripped.
 */
export function intersectKeys(raw: unknown, validated: unknown): unknown {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof validated !== "object" ||
    validated === null ||
    Array.isArray(raw) ||
    Array.isArray(validated)
  ) {
    return validated;
  }

  const rawObj = raw as Record<string, unknown>;
  const validObj = validated as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(rawObj)) {
    if (!(key in validObj)) continue;
    const rawVal = rawObj[key];
    const validVal = validObj[key];

    if (
      typeof rawVal === "object" &&
      rawVal !== null &&
      !Array.isArray(rawVal) &&
      typeof validVal === "object" &&
      validVal !== null &&
      !Array.isArray(validVal)
    ) {
      result[key] = intersectKeys(rawVal, validVal);
    } else {
      result[key] = validVal;
    }
  }

  return result;
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

  return {
    async readConfig(): Promise<GlobalConfig> {
      await ensureDir();

      if (!existsSync(configFile)) {
        const config = defaultConfig();
        await this.writeConfig(config);
        return config;
      }

      const raw = await readFile(configFile, "utf-8");
      const parsed = rawGlobalConfigSchema.parse(JSON.parse(raw));

      return mergeConfigWithDefaults(defaultConfig(), parsed);
    },

    async readRawConfig(): Promise<Partial<GlobalConfig>> {
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
          error: err instanceof Error ? err.message : String(err),
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
      const filtered = intersectKeys(
        parsed,
        result.data,
      ) as Partial<GlobalConfig>;

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
    },

    async writeRawConfig(config: Partial<GlobalConfig>): Promise<void> {
      await ensureDir();
      const json = JSON.stringify(config, null, 2);
      await writeFile(configFile, json, "utf-8");
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

/** Ensure the config directory exists */
async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

/** Read the global config, creating a default one if it doesn't exist */
async function readConfigUncached(): Promise<GlobalConfig> {
  await ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    const config = defaultConfig();
    await writeConfig(config);
    return config;
  }

  const raw = await readFile(CONFIG_FILE, "utf-8");
  const parsed = rawGlobalConfigSchema.parse(JSON.parse(raw));

  return mergeConfigWithDefaults(defaultConfig(), parsed);
}

export const readConfig = cache(readConfigUncached);

/** Read the raw config from disk without merging defaults. Returns {} if file doesn't exist. */
export async function readRawConfig(): Promise<Partial<GlobalConfig>> {
  const reader = createConfigReader(CONFIG_DIR);
  return reader.readRawConfig();
}

/** Write raw (explicit-only) config to disk, replacing the entire file. */
export async function writeRawConfig(
  config: Partial<GlobalConfig>,
): Promise<void> {
  const reader = createConfigReader(CONFIG_DIR);
  return reader.writeRawConfig(config);
}

/** Write the global config to disk */
export async function writeConfig(config: GlobalConfig): Promise<void> {
  await ensureConfigDir();
  const json = JSON.stringify(config, null, 2);
  await writeFile(CONFIG_FILE, json, "utf-8");
}

/** Get the config directory path (for testing/diagnostics) */
export function getConfigDirPath(): string {
  return CONFIG_DIR;
}

/**
 * Resolve the branch prefix from per-project and global config.
 * Per-project overrides global. Falls back to "csm".
 */
export function resolveBranchPrefix(
  globalConfig: Pick<GlobalConfig, "branchPrefix">,
  repoConfig?: Pick<PerRepoConfig, "branchPrefix"> | null,
): string {
  return repoConfig?.branchPrefix ?? globalConfig.branchPrefix ?? "csm";
}
