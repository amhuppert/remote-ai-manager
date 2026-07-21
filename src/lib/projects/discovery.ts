import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { readConfig as readConfigDefault } from "@/lib/config/loader";
import {
  getProjectSessionListItems as getProjectSessionListItemsDefault,
  listProjectPaths as listProjectPathsDefault,
} from "@/lib/state-store";

/* ------------------------------------------------------------------ */
/*  DI factory                                                         */
/* ------------------------------------------------------------------ */

export interface DiscoveryDeps {
  readConfig: () => Promise<GlobalConfig>;
  listProjectPaths: () => Promise<readonly string[]>;
  getProjectSessionListItems: (
    projectPath: string,
  ) => Promise<SessionListItem[]>;
}

const defaultDiscoveryDeps: DiscoveryDeps = {
  readConfig: readConfigDefault,
  listProjectPaths: listProjectPathsDefault,
  getProjectSessionListItems: getProjectSessionListItemsDefault,
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
      const [config, statePaths] = await Promise.all([
        deps.readConfig(),
        deps.listProjectPaths(),
      ]);
      const baseDir = config.baseDir;

      if (!existsSync(baseDir)) {
        return [];
      }

      const entries = await readdir(baseDir, { withFileTypes: true });

      // One focused list-item read per state project, in parallel; sessions'
      // `derivedStatus` is already computed by the accessor, so no whole-state
      // read and no per-session status derivation here.
      const sessionsByProject = new Map<string, SessionListItem[]>();
      await Promise.all(
        statePaths.map(async (projectPath) => {
          sessionsByProject.set(
            projectPath,
            await deps.getProjectSessionListItems(projectPath),
          );
        }),
      );

      const summarize = (
        sessions: SessionListItem[] | undefined,
      ): { activeSessions: number; hasRunningSession: boolean } => {
        const nonArchived = (sessions ?? []).filter((s) => !s.archived);
        return {
          activeSessions: nonArchived.length,
          hasRunningSession: nonArchived.some(
            (s) => s.derivedStatus === "running",
          ),
        };
      };

      const candidates = await Promise.all(
        entries.map(async (entry): Promise<DiscoveredProject | null> => {
          if (!entry.isDirectory()) return null;

          // Skip ignored patterns
          if (config.ignorePatterns.includes(entry.name)) return null;

          const repoPath = path.join(baseDir, entry.name);
          const gitPath = path.join(repoPath, ".git");

          // Check if .git exists (directory or file for worktrees)
          try {
            await stat(gitPath);
          } catch {
            return null; // No .git — skip
          }

          return {
            name: entry.name,
            path: repoPath,
            ...summarize(sessionsByProject.get(repoPath)),
          };
        }),
      );
      const projects: DiscoveredProject[] = candidates.filter(
        (p): p is DiscoveredProject => p !== null,
      );

      // Surface state-only (orphan) projects so they can be deleted from the UI.
      const discoveredPaths = new Set(projects.map((p) => p.path));
      for (const statePath of statePaths) {
        if (discoveredPaths.has(statePath)) continue;
        if (existsSync(statePath)) continue;

        projects.push({
          name: path.basename(statePath),
          path: statePath,
          ...summarize(sessionsByProject.get(statePath)),
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
