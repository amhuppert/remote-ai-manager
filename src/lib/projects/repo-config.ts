import { existsSync as defaultExistsSync } from "node:fs";
import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { perRepoConfigSchema, type PerRepoConfig } from "../config/schemas";

// ============================================================
// Types
// ============================================================

/**
 * Narrowed to the two calls this module actually makes, so a test can supply a
 * plain function instead of satisfying the full `node:fs` overload sets.
 */
export interface RepoConfigDeps {
  existsSync(path: string): boolean;
  readFile(path: string, encoding: "utf-8"): Promise<string>;
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
