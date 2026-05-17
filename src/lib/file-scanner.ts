import { readdir } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { createLogger } from "./logging";
import { getErrorMessage } from "@/lib/errors";
import type { FileItem } from "@/types";

const logger = createLogger("file-scanner");

const DEFAULT_MAX_RESULTS = 20_000;

export interface ScanOptions {
  ignorePatterns: string[];
  maxResults?: number;
}

export interface ScanResult {
  items: FileItem[];
  truncated: boolean;
  scannedCount: number;
}

/**
 * Scan a project directory recursively and return all non-excluded files.
 * Paths are relative to projectPath, using POSIX forward slashes.
 */
export async function scanProjectFiles(
  projectPath: string,
  options: ScanOptions,
): Promise<ScanResult> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const matcher = ignore().add(options.ignorePatterns);

  const state = {
    items: [] as FileItem[],
    scannedCount: 0,
    truncated: false,
  };

  await walkDir(projectPath, "", matcher, maxResults, state);

  return {
    items: state.items,
    truncated: state.truncated,
    scannedCount: state.scannedCount,
  };
}

type Matcher = ReturnType<typeof ignore>;

interface WalkState {
  items: FileItem[];
  scannedCount: number;
  truncated: boolean;
}

async function walkDir(
  basePath: string,
  relativePath: string,
  matcher: Matcher,
  maxResults: number,
  state: WalkState,
): Promise<void> {
  if (state.truncated) return;

  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

  let entries;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch (err) {
    logger.warn("readdir-error", {
      path: fullPath,
      error: getErrorMessage(err),
    });
    return;
  }

  for (const entry of entries) {
    if (state.truncated) return;

    const entryRelative = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;

    if (entry.isSymbolicLink()) {
      logger.debug("symlink-skipped", { path: entryRelative });
      continue;
    }

    if (entry.isDirectory()) {
      if (matcher.ignores(`${entryRelative}/`)) continue;
      await walkDir(basePath, entryRelative, matcher, maxResults, state);
    } else if (entry.isFile()) {
      state.scannedCount += 1;
      if (matcher.ignores(entryRelative)) continue;
      state.items.push({ path: entryRelative });
      if (state.items.length >= maxResults) {
        state.truncated = true;
        return;
      }
    }
  }
}
