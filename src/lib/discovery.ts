import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DiscoveredProject, GlobalConfig, ManagerState } from "@/types";
import { readConfig as readConfigDefault } from "./config";
import { readState as readStateDefault } from "./state";
import { deriveSessionStatus } from "./conversations";

/* ------------------------------------------------------------------ */
/*  DI factory                                                         */
/* ------------------------------------------------------------------ */

export interface DiscoveryDeps {
  readConfig: () => Promise<GlobalConfig>;
  readState: () => Promise<ManagerState>;
}

export const defaultDiscoveryDeps: DiscoveryDeps = {
  readConfig: readConfigDefault,
  readState: readStateDefault,
};

export interface DiscoveryService {
  discoverProjects(): Promise<DiscoveredProject[]>;
}

export function createDiscoveryService(
  deps: DiscoveryDeps = defaultDiscoveryDeps,
): DiscoveryService {
  return {
    /**
     * Scan baseDir one level deep for directories containing a .git directory/file.
     * Returns discovered projects with session metadata from manager state.
     */
    async discoverProjects(): Promise<DiscoveredProject[]> {
      const config = await deps.readConfig();
      const baseDir = config.baseDir;

      if (!existsSync(baseDir)) {
        return [];
      }

      const entries = await readdir(baseDir, { withFileTypes: true });
      const state = await deps.readState();

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
        const sessions = projectState
          ? Object.values(projectState.sessions)
          : [];
        const nonArchivedSessions = sessions.filter((s) => !s.archived);
        const activeSessions = nonArchivedSessions.length;
        const hasRunningSession = nonArchivedSessions.some(
          (s) => deriveSessionStatus(s) === "running",
        );

        projects.push({
          name: entry.name,
          path: repoPath,
          activeSessions,
          hasRunningSession,
        });
      }

      // Surface state-only (orphan) projects so they can be deleted from the UI.
      const discoveredPaths = new Set(projects.map((p) => p.path));
      for (const [statePath, projectState] of Object.entries(state.projects)) {
        if (discoveredPaths.has(statePath)) continue;
        if (existsSync(statePath)) continue;

        const sessions = Object.values(projectState.sessions);
        const nonArchivedSessions = sessions.filter((s) => !s.archived);
        const hasRunningSession = nonArchivedSessions.some(
          (s) => deriveSessionStatus(s) === "running",
        );

        projects.push({
          name: path.basename(statePath),
          path: statePath,
          activeSessions: nonArchivedSessions.length,
          hasRunningSession,
          missing: true,
        });
      }

      // Sort: projects with active sessions first, then alphabetical
      projects.sort((a, b) => {
        if (a.activeSessions > 0 && b.activeSessions === 0) return -1;
        if (a.activeSessions === 0 && b.activeSessions > 0) return 1;
        return a.name.localeCompare(b.name);
      });

      return projects;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Default singleton (backward-compatible module-level exports)      */
/* ------------------------------------------------------------------ */

const defaultService = createDiscoveryService();

export async function discoverProjects(): Promise<DiscoveredProject[]> {
  return defaultService.discoverProjects();
}
