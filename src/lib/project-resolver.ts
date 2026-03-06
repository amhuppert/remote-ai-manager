import path from "node:path";
import { existsSync } from "node:fs";
import { readConfig as readConfigDefault } from "./config";
import type { GlobalConfig } from "@/types";

/* ------------------------------------------------------------------ */
/*  DI factory                                                         */
/* ------------------------------------------------------------------ */

export interface ProjectResolverDeps {
  readConfig: () => Promise<GlobalConfig>;
}

export const defaultProjectResolverDeps: ProjectResolverDeps = {
  readConfig: readConfigDefault,
};

export interface ProjectResolver {
  resolveProjectPath(
    projectName: string,
    baseDir?: string,
  ): Promise<string | null>;
}

export function createProjectResolver(
  deps: ProjectResolverDeps = defaultProjectResolverDeps,
): ProjectResolver {
  return {
    async resolveProjectPath(
      projectName: string,
      baseDir?: string,
    ): Promise<string | null> {
      const resolvedBaseDir = baseDir ?? (await deps.readConfig()).baseDir;
      const projectPath = path.join(resolvedBaseDir, projectName);

      if (!existsSync(projectPath)) return null;

      const gitPath = path.join(projectPath, ".git");
      if (!existsSync(gitPath)) return null;

      return projectPath;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Pure utility (no deps)                                             */
/* ------------------------------------------------------------------ */

/**
 * Extract a human-readable project name from an absolute project path.
 * Returns the last path segment, or the full path as fallback.
 */
export function getProjectDisplayName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

/* ------------------------------------------------------------------ */
/*  Default singleton (backward-compatible module-level exports)      */
/* ------------------------------------------------------------------ */

const defaultResolver = createProjectResolver();

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
  return defaultResolver.resolveProjectPath(projectName, baseDir);
}
