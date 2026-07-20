import { realpath as defaultRealpath } from "node:fs/promises";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import type { GlobalConfig } from "@/lib/config/schemas";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { discoverProjects as defaultDiscoverProjects } from "./discovery";
import { resolveProjectPath as defaultResolveProjectPath } from "./resolver";
import type { DiscoveredProject } from "./schemas";

const logger = createLogger("projects.command-center");

export interface GitCommonDirectoryDeps {
  gitClient: GitClient;
  realpath(path: string): Promise<string>;
}

export async function resolveGitCommonDirectory(
  projectPath: string,
  deps: GitCommonDirectoryDeps,
): Promise<string | null> {
  try {
    const { stdout } = await deps.gitClient.git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      projectPath,
    );
    const commonDirectory = stdout.trim();
    if (commonDirectory === "") {
      logger.debug("command_center_project.git_common_dir_empty", {
        projectPath,
      });
      return null;
    }

    return await deps.realpath(commonDirectory);
  } catch (error) {
    logger.debug("command_center_project.git_common_dir_unavailable", {
      projectPath,
      error: getErrorMessage(error),
    });
    return null;
  }
}

export interface CommandCenterProjectResolverDeps {
  readConfig(): Promise<GlobalConfig>;
  discoverProjects(): Promise<DiscoveredProject[]>;
  resolveProjectPath(
    projectName: string,
    baseDir: string,
  ): Promise<string | null>;
  gitClient: GitClient;
  realpath(path: string): Promise<string>;
  serverWorkingDirectory(): string;
}

export interface CommandCenterProjectResolver {
  resolveProjectName(): Promise<string | null>;
}

interface ResolutionCache {
  config: GlobalConfig;
  candidateKey: string;
  projectName: string | null;
}

const defaultDeps: CommandCenterProjectResolverDeps = {
  readConfig: defaultReadConfig,
  discoverProjects: defaultDiscoverProjects,
  resolveProjectPath: defaultResolveProjectPath,
  gitClient: defaultGitClient,
  realpath: defaultRealpath,
  serverWorkingDirectory() {
    return process.cwd();
  },
};

function availableCandidates(
  projects: DiscoveredProject[],
): DiscoveredProject[] {
  return projects
    .filter((project) => project.missing !== true)
    .sort((left, right) => {
      const pathOrder = left.path.localeCompare(right.path);
      return pathOrder !== 0 ? pathOrder : left.name.localeCompare(right.name);
    });
}

function candidateCacheKey(projects: DiscoveredProject[]): string {
  return JSON.stringify(projects.map(({ name, path }) => ({ name, path })));
}

export function createCommandCenterProjectResolver(
  deps: CommandCenterProjectResolverDeps = defaultDeps,
): CommandCenterProjectResolver {
  let cache: ResolutionCache | null = null;

  return {
    async resolveProjectName(): Promise<string | null> {
      const config = await deps.readConfig();
      const override = config.commandCenterProjectName;
      if (override !== undefined) {
        const projectPath = await deps.resolveProjectPath(
          override,
          config.baseDir,
        );
        if (projectPath === null) {
          logger.warn("command_center_project.override_unavailable", {
            projectName: override,
          });
          return null;
        }

        logger.debug("command_center_project.override_resolved", {
          projectName: override,
        });
        return override;
      }

      const candidates = availableCandidates(await deps.discoverProjects());
      const candidateKey = candidateCacheKey(candidates);
      if (
        cache !== null &&
        cache.config === config &&
        cache.candidateKey === candidateKey
      ) {
        logger.debug("command_center_project.cache_hit", {
          projectName: cache.projectName,
          candidateCount: candidates.length,
        });
        return cache.projectName;
      }

      const commonDirDeps: GitCommonDirectoryDeps = {
        gitClient: deps.gitClient,
        realpath: deps.realpath,
      };
      const serverCommonDirectory = await resolveGitCommonDirectory(
        deps.serverWorkingDirectory(),
        commonDirDeps,
      );
      if (serverCommonDirectory === null) {
        cache = { config, candidateKey, projectName: null };
        logger.debug("command_center_project.auto_detect_unavailable", {
          reason: "server_not_git",
          candidateCount: candidates.length,
        });
        return null;
      }

      const probedCandidates = await Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          commonDirectory: await resolveGitCommonDirectory(
            candidate.path,
            commonDirDeps,
          ),
        })),
      );
      const matches = probedCandidates.filter(
        ({ commonDirectory }) => commonDirectory === serverCommonDirectory,
      );
      const projectName =
        matches.length === 1 ? (matches[0]?.candidate.name ?? null) : null;

      cache = { config, candidateKey, projectName };
      if (projectName === null) {
        logger.debug("command_center_project.auto_detect_unresolved", {
          candidateCount: candidates.length,
          matchCount: matches.length,
        });
      } else {
        logger.debug("command_center_project.auto_detect_resolved", {
          projectName,
          candidateCount: candidates.length,
        });
      }
      return projectName;
    },
  };
}

const defaultResolver = createCommandCenterProjectResolver();

export function resolveCommandCenterProjectName(): Promise<string | null> {
  return defaultResolver.resolveProjectName();
}
