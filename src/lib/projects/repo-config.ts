import { existsSync as defaultExistsSync } from "node:fs";
import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { perRepoConfigSchema, type PerRepoConfig } from "../config/schemas";

// ============================================================
// Types
// ============================================================

export interface RepoConfigDeps {
  existsSync: typeof defaultExistsSync;
  readFile: typeof defaultReadFile;
}

const defaultDeps: RepoConfigDeps = {
  existsSync: defaultExistsSync,
  readFile: defaultReadFile,
};

// ============================================================
// Factory
// ============================================================

export function createRepoConfig(deps: RepoConfigDeps = defaultDeps) {
  const { existsSync, readFile } = deps;

  /** Read optional per-repo config */
  async function readRepoConfig(
    repoRoot: string,
  ): Promise<PerRepoConfig | null> {
    const configPath = path.join(repoRoot, "CommandCenter.json");
    if (!existsSync(configPath)) return null;

    const raw = await readFile(configPath, "utf-8");
    return perRepoConfigSchema.parse(JSON.parse(raw));
  }

  return { readRepoConfig };
}

// ============================================================
// Default singleton for backward compatibility
// ============================================================

const defaultInstance = createRepoConfig();

export const readRepoConfig = defaultInstance.readRepoConfig;
