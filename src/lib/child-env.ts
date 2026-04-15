/**
 * Build a sanitized copy of process.env for child processes.
 *
 * CC itself runs as a production Next.js server, so its process.env contains
 * variables that confuse or break child processes:
 *
 * - `NODE_ENV=production` — causes test runners to load React's production
 *   build (where `act()` is unavailable) and dev servers to behave incorrectly
 * - `__NEXT_*` / `__TURBOPACK_*` — Next.js/Turbopack internal vars that crash
 *   child Next.js processes
 * - `NODE_CHANNEL_*` — Node IPC channel vars from the parent process
 *
 * By removing `NODE_ENV`, each child tool uses its own default:
 * Jest → "test", Next.js dev → "development", etc.
 *
 * Additionally ensures `node` is on PATH. Child tools (vitest, eslint, etc.)
 * use `#!/usr/bin/env node` shebangs. When CC runs in a restricted environment
 * (e.g. agent sessions without shell profile), node may be absent from PATH
 * even though it's installed. We search well-known version manager directories
 * and prepend the found location.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@/lib/logging";

const logger = createLogger("child-env");

export function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete (env as Record<string, string | undefined>).NODE_ENV;

  for (const key of Object.keys(env)) {
    if (
      key.startsWith("__NEXT_") ||
      key.startsWith("NODE_CHANNEL_") ||
      key.startsWith("__TURBOPACK_")
    ) {
      delete env[key];
    }
  }

  ensureNodeOnPath(env);

  return env;
}

// ============================================================
// Node binary resolution
// ============================================================

export interface FindNodeDeps {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  homedir(): string;
  platform(): NodeJS.Platform;
  nvmDir?: string;
  fnmDir?: string;
}

const defaultFindNodeDeps: FindNodeDeps = {
  existsSync,
  readdirSync,
  homedir: () => os.homedir(),
  platform: () => process.platform,
  get nvmDir() {
    return process.env.NVM_DIR;
  },
  get fnmDir() {
    return process.env.FNM_DIR;
  },
};

let cachedNodeDir: string | null | undefined;

function ensureNodeOnPath(env: NodeJS.ProcessEnv): void {
  if (cachedNodeDir === undefined) {
    cachedNodeDir = findNodeBinDir(env.PATH, defaultFindNodeDeps);
    if (cachedNodeDir) {
      logger.info("child-env.node_resolved", { nodeDir: cachedNodeDir });
    }
  }
  if (cachedNodeDir) {
    env.PATH = env.PATH
      ? `${cachedNodeDir}${path.delimiter}${env.PATH}`
      : cachedNodeDir;
  }
}

/**
 * Search for a `node` binary when it isn't already on PATH.
 * Returns the directory containing the binary, or null.
 */
export function findNodeBinDir(
  currentPath: string | undefined,
  deps: FindNodeDeps = defaultFindNodeDeps,
): string | null {
  // Already on PATH — nothing to do
  const pathDirs = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (deps.existsSync(path.join(dir, "node"))) {
      return null;
    }
  }

  const home = deps.homedir();
  const candidates: string[] = [];

  // nvm — most popular version manager
  const nvmDir = deps.nvmDir ?? path.join(home, ".nvm");
  pushVersionedDirs(
    candidates,
    path.join(nvmDir, "versions", "node"),
    "bin",
    deps,
  );

  // fnm
  const fnmDir =
    deps.fnmDir ??
    (deps.platform() === "darwin"
      ? path.join(
          home,
          "Library",
          "Application Support",
          "fnm",
          "node-versions",
        )
      : path.join(home, ".local", "share", "fnm", "node-versions"));
  pushVersionedDirs(candidates, fnmDir, path.join("installation", "bin"), deps);

  // mise / rtx
  pushVersionedDirs(
    candidates,
    path.join(home, ".local", "share", "mise", "installs", "node"),
    "bin",
    deps,
  );

  // asdf
  pushVersionedDirs(
    candidates,
    path.join(home, ".asdf", "installs", "node"),
    "bin",
    deps,
  );

  // volta
  candidates.push(path.join(home, ".volta", "bin"));

  // System / homebrew locations
  candidates.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");

  for (const dir of candidates) {
    if (deps.existsSync(path.join(dir, "node"))) {
      return dir;
    }
  }

  return null;
}

/** Enumerate version directories under a base path, newest first. */
function pushVersionedDirs(
  out: string[],
  baseDir: string,
  binSuffix: string,
  deps: FindNodeDeps,
): void {
  if (!deps.existsSync(baseDir)) return;
  try {
    const versions = deps.readdirSync(baseDir);
    // Reverse lexicographic sort — puts higher version numbers first
    versions.sort().reverse();
    for (const v of versions) {
      out.push(path.join(baseDir, v, binSuffix));
    }
  } catch {
    // Directory unreadable
  }
}

/** Reset the cached node directory — only for tests. */
export function _resetNodeDirCache(): void {
  cachedNodeDir = undefined;
}
