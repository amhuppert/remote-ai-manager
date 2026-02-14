import path from "node:path";
import { existsSync } from "node:fs";
import { readConfig } from "./config";

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
