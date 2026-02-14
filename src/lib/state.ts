import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ManagerState, ProjectState, SessionState } from "@/types";
import { readConfig } from "./config";

/** Default empty manager state */
function emptyState(): ManagerState {
  return { projects: {} };
}

/** Read the manager state from disk, returning empty state if file missing */
export async function readState(): Promise<ManagerState> {
  const config = await readConfig();
  const statePath = config.stateFilePath;

  if (!existsSync(statePath)) {
    return emptyState();
  }

  const raw = await readFile(statePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return parsed as ManagerState;
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

  await writeFile(tmpPath, json, "utf-8");
  await rename(tmpPath, statePath);
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

  const project = state.projects[projectPath];
  if (project) {
    project.sessions[session.sessionName] = session;
  }

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
