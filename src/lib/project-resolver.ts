import path from "node:path";
import { existsSync } from "node:fs";
import { readConfig } from "./config";

/**
 * Extract a human-readable project name from an absolute project path.
 * Returns the last path segment, or the full path as fallback.
 */
export function getProjectDisplayName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

/**
 * Resolve a project name (from URL) to its absolute filesystem path.
 * Returns null if the project directory doesn't exist or has no .git.
 *
 * @param projectName - The project directory name
 * @param baseDir - Optional base directory override (default: from config)
 */
export async function resolveProjectPath(
  projectName: string,
  baseDir?: string,
): Promise<string | null> {
  const resolvedBaseDir = baseDir ?? (await readConfig()).baseDir;
  const projectPath = path.join(resolvedBaseDir, projectName);

  if (!existsSync(projectPath)) return null;

  const gitPath = path.join(projectPath, ".git");
  if (!existsSync(gitPath)) return null;

  return projectPath;
}
