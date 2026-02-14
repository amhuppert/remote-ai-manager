import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { GlobalConfig } from "@/types";

/** Returns the OS-appropriate config directory for CSM */
function getConfigDir(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "csm");
  }
  // Linux / other: use XDG_CONFIG_HOME or ~/.config
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) {
    return path.join(xdg, "csm");
  }
  return path.join(os.homedir(), ".config", "csm");
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/** Default global config values */
function defaultConfig(): GlobalConfig {
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
    stateFilePath: path.join(CONFIG_DIR, "state.json"),
    claudeTimeoutMs: 300_000,
  };
}

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
  return { ...defaultConfig(), ...(parsed as Partial<GlobalConfig>) };
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
