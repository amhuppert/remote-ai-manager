import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DiscoveredProject } from "@/types";
import { readConfig } from "./config";
import { readState } from "./state";

/**
 * Scan baseDir one level deep for directories containing a .git directory/file.
 * Returns discovered projects with session metadata from manager state.
 */
export async function discoverProjects(): Promise<DiscoveredProject[]> {
  const config = await readConfig();
  const baseDir = config.baseDir;

  if (!existsSync(baseDir)) {
    return [];
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  const state = await readState();

  const projects: DiscoveredProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip ignored patterns
    if (config.ignorePatterns.includes(entry.name)) continue;

    const repoPath = path.join(baseDir, entry.name);
    const gitPath = path.join(repoPath, ".git");

    // Check if .git exists (directory or file for worktrees)
    try {
      await stat(gitPath);
    } catch {
      continue; // No .git — skip
    }

    // Gather session stats from manager state
    const projectState = state.projects[repoPath];
    const sessions = projectState ? Object.values(projectState.sessions) : [];
    const activeSessions = sessions.filter((s) => !s.archived).length;
    const hasRunningSession = sessions.some((s) => s.status === "running");

    projects.push({
      name: entry.name,
      path: repoPath,
      activeSessions,
      hasRunningSession,
    });
  }

  // Sort: projects with active sessions first, then alphabetical
  projects.sort((a, b) => {
    if (a.activeSessions > 0 && b.activeSessions === 0) return -1;
    if (a.activeSessions === 0 && b.activeSessions > 0) return 1;
    return a.name.localeCompare(b.name);
  });

  return projects;
}
