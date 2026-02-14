import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionState, PerRepoConfig } from "@/types";
import { readState, writeState } from "./state";

const execFileAsync = promisify(execFile);

/** Sanitize a session name into a valid git branch suffix */
function sanitizeBranchName(sessionName: string): string {
  return sessionName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Validate session name: non-empty, reasonable length, no weird chars */
function validateSessionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "Session name cannot be empty";
  }
  if (name.length > 100) {
    return "Session name must be 100 characters or less";
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name)) {
    return "Session name must start with a letter or number and contain only letters, numbers, spaces, hyphens, or underscores";
  }
  return null;
}

/** Read optional per-repo config */
async function readRepoConfig(repoRoot: string): Promise<PerRepoConfig | null> {
  const configPath = path.join(repoRoot, "ClaudeSessionManager.json");
  if (!existsSync(configPath)) return null;

  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as PerRepoConfig;
}

/** Execute a git command in the given working directory */
async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

/**
 * Create a new session for a project.
 * - Validates unique name
 * - Creates a worktree from main
 * - Creates branch csm/<sanitized-name>
 * - Runs optional init script
 * - On failure, rolls back completely
 */
export async function createSession(
  projectPath: string,
  sessionName: string,
): Promise<SessionState> {
  // Validate name
  const validationError = validateSessionName(sessionName);
  if (validationError) {
    throw new Error(validationError);
  }

  // Check uniqueness within project
  const state = await readState();
  const project = state.projects[projectPath];
  if (project?.sessions[sessionName]) {
    throw new Error(`Session "${sessionName}" already exists in this project`);
  }

  const sanitized = sanitizeBranchName(sessionName);
  const branchName = `csm/${sanitized}`;

  // Worktree location: .worktrees/<sanitized> inside the project
  const worktreePath = path.join(projectPath, ".worktrees", sanitized);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree directory already exists: ${worktreePath}`);
  }

  try {
    // Create worktree + branch from main
    await git(projectPath, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      "main",
    ]);

    // Run optional init script
    const repoConfig = await readRepoConfig(projectPath);
    if (repoConfig?.initScriptPath) {
      const scriptPath = path.isAbsolute(repoConfig.initScriptPath)
        ? repoConfig.initScriptPath
        : path.join(projectPath, repoConfig.initScriptPath);

      if (!existsSync(scriptPath)) {
        throw new Error(`Init script not found: ${scriptPath}`);
      }

      await execFileAsync(scriptPath, [], {
        cwd: worktreePath,
        env: {
          ...process.env,
          PROJECT_ROOT: projectPath,
          WORKTREE_PATH: worktreePath,
          SESSION_NAME: sessionName,
          BRANCH_NAME: branchName,
        },
        timeout: 60_000,
      });
    }
  } catch (err) {
    // Rollback: remove the worktree if it was created
    try {
      if (existsSync(worktreePath)) {
        await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
      }
    } catch {
      // Best-effort cleanup, also try raw rm
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    // Delete the branch if it was created
    try {
      await git(projectPath, ["branch", "-D", branchName]);
    } catch {
      // branch may not have been created
    }

    throw err;
  }

  // Build session state
  const now = new Date().toISOString();
  const session: SessionState = {
    sessionName,
    worktreePath,
    branchName,
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready",
    createdAt: now,
    lastActivityAt: now,
    promptCount: 0,
    archived: false,
  };

  // Persist to state
  if (!state.projects[projectPath]) {
    state.projects[projectPath] = {
      rootPath: projectPath,
      sessions: {},
    };
  }
  const proj = state.projects[projectPath];
  if (proj) {
    proj.sessions[sessionName] = session;
  }
  await writeState(state);

  return session;
}

/**
 * Delete a session.
 * - Removes the worktree directory
 * - Removes from manager state
 * - Does NOT delete the branch or transcripts
 */
export async function deleteSession(
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

  // Remove worktree
  if (existsSync(session.worktreePath)) {
    try {
      await git(projectPath, [
        "worktree",
        "remove",
        "--force",
        session.worktreePath,
      ]);
    } catch {
      // Fallback: manual removal
      await rm(session.worktreePath, { recursive: true, force: true });
    }
  }

  // Remove from state
  delete project.sessions[sessionName];
  await writeState(state);
}
