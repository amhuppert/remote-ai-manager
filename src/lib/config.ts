import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { globalConfigSchema } from "./schemas";
import type { GlobalConfig, PerRepoConfig } from "@/types";

/**
 * Resolve the config directory for Command Center.
 *
 * Priority:
 * 1. CC_CONFIG_DIR env var (explicit override)
 * 2. OS-appropriate default, with "cc-dev" suffix when NODE_ENV=development
 *    to isolate dev server state from production
 */
export function resolveConfigDir(): string {
  const override = process.env["CC_CONFIG_DIR"];
  if (override) {
    return override;
  }

  const dirName = process.env["NODE_ENV"] === "development" ? "cc-dev" : "cc";

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
function defaultConfig(configDir: string = CONFIG_DIR): GlobalConfig {
  return {
    baseDir: path.join(os.homedir(), "projects"),
    ignorePatterns: [
      "node_modules",
      ".next",
      "dist",
      "build",
      "target",
      ".cache",
      ".turbo",
      ".venv",
    ],
    stateFilePath: path.join(configDir, "state.json"),
    claudeTimeoutMs: 3_600_000,
    defaultModel: "opus",
    defaultAgentBackend: "claude",
    mergeCheckIntervalMs: 5 * 60 * 1000,
    preMergeTimeoutMs: 300_000,
    maxConcurrentQueries: 3,
    tailscaleEnabled: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Config reader factory                                             */
/* ------------------------------------------------------------------ */

export interface ConfigReader {
  readConfig(): Promise<GlobalConfig>;
  writeConfig(config: GlobalConfig): Promise<void>;
  getConfigDirPath(): string;
}

/**
 * Create a config reader that reads/writes from a specific config directory.
 * Useful for testing with temp directories without mocking fs or os.
 */
export function createConfigReader(configDir: string): ConfigReader {
  const configFile = path.join(configDir, "config.json");

  async function ensureDir(): Promise<void> {
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }
  }

  return {
    async readConfig(): Promise<GlobalConfig> {
      await ensureDir();

      if (!existsSync(configFile)) {
        const config = defaultConfig(configDir);
        await this.writeConfig(config);
        return config;
      }

      const raw = await readFile(configFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      return {
        ...defaultConfig(configDir),
        ...globalConfigSchema.partial().parse(parsed),
      };
    },

    async writeConfig(config: GlobalConfig): Promise<void> {
      await ensureDir();
      const json = JSON.stringify(config, null, 2);
      await writeFile(configFile, json, "utf-8");
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
export async function readConfig(): Promise<GlobalConfig> {
  await ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    const config = defaultConfig();
    await writeConfig(config);
    return config;
  }

  const raw = await readFile(CONFIG_FILE, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  // Merge with defaults to handle missing fields from older configs
  return { ...defaultConfig(), ...globalConfigSchema.partial().parse(parsed) };
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
