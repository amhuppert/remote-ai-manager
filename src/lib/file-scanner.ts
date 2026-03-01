import { readdir } from "node:fs/promises";
import path from "node:path";
import type { FileItem } from "@/types";

/** Directories to skip entirely during traversal */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".nuxt",
  ".output",
  ".cache",
  ".vscode",
  ".idea",
  ".cursor",
  "coverage",
  ".nyc_output",
  "storybook-static",
  ".worktrees",
  "dist",
  "build",
  ".svelte-kit",
  ".parcel-cache",
]);

/** Specific filenames to exclude */
const EXCLUDED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".eslintcache",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
]);

/** Binary/media extensions to exclude */
const EXCLUDED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".webp",
  ".mp4",
  ".mp3",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

/**
 * Scan a project directory recursively and return all non-excluded files.
 * Paths are relative to projectPath, using forward slashes.
 */
export async function scanProjectFiles(
  projectPath: string,
): Promise<FileItem[]> {
  const results: FileItem[] = [];
  await walkDir(projectPath, "", results);
  return results;
}

async function walkDir(
  basePath: string,
  relativePath: string,
  results: FileItem[],
): Promise<void> {
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

  const entries = await readdir(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryRelative = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        await walkDir(basePath, entryRelative, results);
      }
    } else if (entry.isFile()) {
      if (
        !EXCLUDED_FILES.has(entry.name) &&
        !EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        results.push({ path: entryRelative });
      }
    }
  }
}
