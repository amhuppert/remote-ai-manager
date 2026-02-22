import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ManagerState, ProjectState, SessionState } from "@/types";
import { managerStateSchema } from "./schemas";
import { readConfig } from "./config";
import { createLogger } from "./logging";

const logger = createLogger("state");

/** Default empty manager state */
function emptyState(): ManagerState {
  return { projects: {}, archivedProjects: [], pinnedProjects: [] };
}

/** Read the manager state from disk, returning empty state if file missing */
export async function readState(): Promise<ManagerState> {
  const config = await readConfig();
  const statePath = config.stateFilePath;

  if (!existsSync(statePath)) {
    return emptyState();
  }

  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = managerStateSchema.safeParse(parsed);
    return result.success ? result.data : emptyState();
  } catch (err) {
    logger.error("state.read_failure", {
      errorType: err instanceof Error ? err.constructor.name : typeof err,
      filePath: statePath,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return emptyState();
  }
}

/**
 * Write manager state to disk atomically (write to temp, then rename).
 * This prevents partial writes from corrupting the state file.
 */
export async function writeState(state: ManagerState): Promise<void> {
  const config = await readConfig();
  const statePath = config.stateFilePath;

  // Ensure parent directory exists
  const dir = path.dirname(statePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const tmpPath = `${statePath}.tmp.${Date.now()}`;
  const json = JSON.stringify(state, null, 2);

  const projectCount = Object.keys(state.projects).length;
  let sessionCount = 0;
  for (const project of Object.values(state.projects)) {
    sessionCount += Object.keys(project.sessions).length;
  }

  logger.debug("state.write", {
    projectCount,
    sessionCount,
    fileSize: json.length,
  });

  await writeFile(tmpPath, json, "utf-8");

  logger.debug("state.atomic_write", {
    tmpPath,
    finalPath: statePath,
  });

  try {
    await rename(tmpPath, statePath);
  } catch (err) {
    logger.error("state.rename_failure", {
      tmpPath,
      finalPath: statePath,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

/** Get or create a ProjectState entry for a given project path */
export async function getOrCreateProject(
  projectPath: string,
): Promise<ProjectState> {
  const state = await readState();
  const existing = state.projects[projectPath];
  if (existing) {
    return existing;
  }

  const project: ProjectState = {
    rootPath: projectPath,
    sessions: {},
  };

  state.projects[projectPath] = project;
  await writeState(state);
  return project;
}

/** Update a specific session within a project and persist */
export async function updateSession(
  projectPath: string,
  session: SessionState,
): Promise<void> {
  const state = await readState();

  if (!state.projects[projectPath]) {
    state.projects[projectPath] = {
      rootPath: projectPath,
      sessions: {},
    };
  }

  // Safe to assert: we just ensured the project exists above
  state.projects[projectPath]!.sessions[session.sessionName] = session;

  await writeState(state);
}

/** Remove a session from a project's state */
export async function removeSession(
  projectPath: string,
  sessionName: string,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return;

  delete project.sessions[sessionName];
  await writeState(state);
}

/** Get all sessions for a project */
export async function getProjectSessions(
  projectPath: string,
): Promise<SessionState[]> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return [];

  return Object.values(project.sessions);
}

/** Get a specific session by project path and session name */
export async function getSession(
  projectPath: string,
  sessionName: string,
): Promise<SessionState | null> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return null;

  return project.sessions[sessionName] ?? null;
}

/** Set a session's archived flag */
export async function setSessionArchived(
  projectPath: string,
  sessionName: string,
  archived: boolean,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  session.archived = archived;
  await writeState(state);
}

/** Mark a session as finished (merged) and archived atomically */
export async function setSessionFinished(
  projectPath: string,
  sessionName: string,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  session.finished = true;
  session.archived = true;
  await writeState(state);
}

/** Read archived project paths from persisted state */
export async function getArchivedProjects(): Promise<Set<string>> {
  const state = await readState();
  return new Set(state.archivedProjects);
}

/** Add or remove a project path from the archived set */
export async function setProjectArchived(
  projectPath: string,
  archived: boolean,
): Promise<void> {
  const state = await readState();
  const current = new Set(state.archivedProjects);

  if (archived) {
    current.add(projectPath);
  } else {
    current.delete(projectPath);
  }

  state.archivedProjects = [...current];
  await writeState(state);
}

/** Read pinned project paths from persisted state */
export async function getPinnedProjects(): Promise<Set<string>> {
  const state = await readState();
  return new Set(state.pinnedProjects);
}

/** Add or remove a project path from the pinned set */
export async function setProjectPinned(
  projectPath: string,
  pinned: boolean,
): Promise<void> {
  const state = await readState();
  const current = new Set(state.pinnedProjects);

  if (pinned) {
    current.add(projectPath);
  } else {
    current.delete(projectPath);
  }

  state.pinnedProjects = [...current];
  await writeState(state);
}
