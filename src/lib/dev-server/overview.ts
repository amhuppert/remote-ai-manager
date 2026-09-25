import path from "node:path";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { DevServerEntry } from "./registry";
import type { DevServerStatusItem } from "./service";
import type {
  DevServerInstance,
  DevServerOverviewProject,
  DevServerOverviewResponse,
} from "./schemas";

const logger = createLogger("dev-server-overview");

export interface DevServerOverviewDeps {
  listProjects(): Promise<ReadonlyArray<{ name: string; path: string }>>;
  /** Configured project-root servers merged with their runtime state. */
  listProjectRootServers(projectPath: string): Promise<DevServerStatusItem[]>;
  listRegisteredServers(): DevServerEntry[];
  getSessionWorktree(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
}

export interface DevServerOverview {
  read(): Promise<DevServerOverviewResponse>;
}

function isActive(status: DevServerInstance["status"]): boolean {
  return status === "starting" || status === "running";
}

function describeConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `CommandCenter.json is invalid.\n${z.prettifyError(error)}`;
  }
  return `CommandCenter.json could not be read: ${getErrorMessage(error)}`;
}

function projectRootInstance(
  item: DevServerStatusItem,
  projectPath: string,
): DevServerInstance {
  return {
    owner: { kind: "project" },
    serverName: item.serverName,
    status: item.status,
    port: item.port,
    localUrl: item.localUrl,
    remoteUrl: item.remoteUrl,
    startedAt: item.startedAt,
    errorMessage: item.errorMessage,
    worktreePath: projectPath,
  };
}

/**
 * The cross-project dev-server picture: every configured project-root server
 * (the operator's launch surface) plus every session and lane server that is
 * starting or running. Stopped and errored session servers stay on their
 * session's own panel.
 */
export function createDevServerOverview(
  deps: DevServerOverviewDeps,
): DevServerOverview {
  async function sessionInstance(
    entry: DevServerEntry,
  ): Promise<DevServerInstance> {
    const sessionWorktree = await deps.getSessionWorktree(
      entry.projectPath,
      entry.sessionName,
    );
    const isLane =
      sessionWorktree !== null &&
      path.resolve(sessionWorktree) !== path.resolve(entry.worktreePath);
    return {
      owner: isLane
        ? {
            kind: "workflow-lane",
            sessionName: entry.sessionName,
            worktreeName: path.basename(entry.worktreePath),
          }
        : { kind: "session", sessionName: entry.sessionName },
      serverName: entry.serverName,
      status: entry.status,
      port: entry.port,
      localUrl: entry.port !== null ? `http://localhost:${entry.port}` : null,
      remoteUrl: entry.remoteUrl,
      startedAt: entry.startedAt,
      errorMessage: entry.errorMessage,
      worktreePath: entry.worktreePath,
    };
  }

  async function readProject(
    project: { name: string; path: string },
    sessionEntries: DevServerEntry[],
  ): Promise<DevServerOverviewProject> {
    let configError: string | null = null;
    let rootServers: DevServerInstance[] = [];
    try {
      rootServers = (await deps.listProjectRootServers(project.path)).map(
        (item) => projectRootInstance(item, project.path),
      );
    } catch (error) {
      configError = describeConfigError(error);
      logger.warn("dev-server.overview.config_unreadable", {
        projectName: project.name,
        error: getErrorMessage(error),
      });
    }
    const sessionServers = await Promise.all(
      [...sessionEntries]
        .sort(
          (a, b) =>
            a.sessionName.localeCompare(b.sessionName) ||
            a.worktreePath.localeCompare(b.worktreePath) ||
            a.serverName.localeCompare(b.serverName),
        )
        .map(sessionInstance),
    );
    return {
      projectName: project.name,
      projectPath: project.path,
      configError,
      servers: [...rootServers, ...sessionServers],
    };
  }

  async function read(): Promise<DevServerOverviewResponse> {
    const projects = await deps.listProjects();
    const activeSessionEntries = deps
      .listRegisteredServers()
      .filter(
        (entry) =>
          !isProjectSentinel(entry.sessionName) && isActive(entry.status),
      );
    const overview = await Promise.all(
      projects.map((project) =>
        readProject(
          project,
          activeSessionEntries.filter(
            (entry) => entry.projectPath === project.path,
          ),
        ),
      ),
    );
    const activeCount = (p: DevServerOverviewProject) =>
      p.servers.filter((s) => isActive(s.status)).length;
    overview.sort(
      (a, b) =>
        Number(activeCount(b) > 0) - Number(activeCount(a) > 0) ||
        a.projectName.localeCompare(b.projectName),
    );
    logger.info("dev-server.overview.read", {
      projectCount: overview.length,
      activeCount: overview.reduce((sum, p) => sum + activeCount(p), 0),
    });
    return { projects: overview };
  }

  return { read };
}
