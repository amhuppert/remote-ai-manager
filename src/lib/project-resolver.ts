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
 */
export async function resolveProjectPath(
  projectName: string,
): Promise<string | null> {
  const config = await readConfig();
  const projectPath = path.join(config.baseDir, projectName);

  if (!existsSync(projectPath)) return null;

  const gitPath = path.join(projectPath, ".git");
  if (!existsSync(gitPath)) return null;

  return projectPath;
}
