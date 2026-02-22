import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ConversationState, SessionState, ContainerStatus } from "@/types";
import { perRepoConfigSchema, type PerRepoConfig } from "./schemas";
import { readState, updateSession, removeSession } from "./state";
import { createLogger } from "./logging";
import {
  checkPrerequisites,
  resolveConfig,
  prepareSessionEnvironment,
  startContainer,
  buildContainerEnv,
  stopAndRemoveContainer,
} from "./devcontainer";
import { broadcastContainerStatus } from "./sse-broadcaster";

const logger = createLogger("sessions");

const execFileAsync = promisify(execFile);

/** Sanitize a session name into a valid git branch suffix */
export function sanitizeBranchName(sessionName: string): string {
  return sessionName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Validate session name: non-empty, reasonable length, no weird chars */
export function validateSessionName(name: string): string | null {
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
  return perRepoConfigSchema.parse(JSON.parse(raw));
}

/** Execute a git command in the given working directory */
async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

/** CSM default port for hook callbacks */
const CSM_PORT = 3000;

/**
 * Helper to update container status on a session and broadcast SSE event.
 * Uses updateSession to write the full session object atomically,
 * preventing partial field updates from being lost to concurrent writes.
 */
async function updateContainerStatus(
  projectPath: string,
  session: SessionState,
  status: ContainerStatus,
  fields?: Partial<
    Pick<SessionState, "containerId" | "containerError" | "claudeHostDir">
  >,
): Promise<void> {
  session.containerStatus = status;
  if (fields?.containerId !== undefined)
    session.containerId = fields.containerId;
  if (fields?.containerError !== undefined)
    session.containerError = fields.containerError;
  if (fields?.claudeHostDir !== undefined)
    session.claudeHostDir = fields.claudeHostDir;

  // Persist the full session to state (serialized via write lock)
  await updateSession(projectPath, session);

  // Broadcast SSE event
  const projectName = path.basename(projectPath);
  broadcastContainerStatus({
    type: "container-status",
    projectName,
    sessionName: session.sessionName,
    containerStatus: status,
    containerId: session.containerId,
    error: session.containerError,
  });
}

/**
 * Create a new session for a project.
 * - Validates unique name
 * - Creates a worktree from main
 * - Creates branch csm/<sanitized-name>
 * - Runs optional init script
 * - Builds and starts a dev container
 * - On failure, rolls back completely (worktree + container)
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
    logger.info("session.create", {
      projectName: projectPath,
      sessionName,
      worktreePath,
      branchName,
    });

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
    logger.error("session.create_failure", {
      projectName: projectPath,
      sessionName,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

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

  // Build session state with an initial conversation
  const now = new Date().toISOString();
  const initialConversation: ConversationState = {
    id: crypto.randomUUID(),
    name: null,
    claudeSessionId: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: now,
    lastActivityAt: now,
    source: "csm",
    summary: null,
    archived: false,
  };
  const session: SessionState = {
    sessionName,
    worktreePath,
    branchName,
    createdAt: now,
    lastActivityAt: now,
    archived: false,
    finished: false,
    conversations: [initialConversation],
    source: "csm",
    containerId: null,
    containerStatus: "none",
    containerError: null,
    claudeHostDir: null,
  };

  // Persist initial session state before container setup
  await updateSession(projectPath, session);

  // --- Container Setup ---
  try {
    // Check prerequisites
    const prereqs = await checkPrerequisites();
    if (prereqs.errors.length > 0) {
      throw new Error(
        `Container prerequisites not met: ${prereqs.errors.join("; ")}`,
      );
    }

    // Resolve container config (project or CSM default)
    const containerConfig = resolveConfig(projectPath);

    // Update status: building
    await updateContainerStatus(projectPath, session, "building");

    // Prepare session environment (hooks, .claude/ dir)
    const claudeDir = await prepareSessionEnvironment(
      sessionName,
      projectPath,
      CSM_PORT,
    );

    // Update status: starting
    await updateContainerStatus(projectPath, session, "starting", {
      claudeHostDir: claudeDir,
    });

    // Build container env vars
    const envVars = buildContainerEnv(projectPath, sessionName);

    // Start container
    const containerInfo = await startContainer(
      worktreePath,
      claudeDir,
      envVars,
      containerConfig,
    );

    // Update status: running
    await updateContainerStatus(projectPath, session, "running", {
      containerId: containerInfo.containerId,
    });

    logger.info("session.container_ready", {
      sessionName,
      containerId: containerInfo.containerId,
    });
  } catch (containerErr) {
    const errorMessage =
      containerErr instanceof Error
        ? containerErr.message
        : String(containerErr);

    logger.error("session.container_failure", {
      sessionName,
      error: errorMessage,
    });

    // Update status to error
    await updateContainerStatus(projectPath, session, "error", {
      containerError: errorMessage,
    });

    // Rollback container if it was partially created
    if (session.containerId) {
      try {
        await stopAndRemoveContainer(session.containerId);
      } catch {
        // best-effort container cleanup
      }
    }

    // Rollback worktree and branch
    try {
      if (existsSync(worktreePath)) {
        await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
      }
    } catch {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    try {
      await git(projectPath, ["branch", "-D", branchName]);
    } catch {
      // branch may not have been created
    }

    // Remove session from state
    await removeSession(projectPath, sessionName);

    throw new Error(`Container setup failed: ${errorMessage}`);
  }

  return session;
}

/**
 * Delete a session.
 * - For CSM-created sessions: removes the worktree directory from disk
 * - For imported sessions: only removes the session record from state
 * - Does NOT delete the branch or transcripts
 */
export async function deleteSession(
  projectPath: string,
  sessionName: string,
): Promise<{ worktreeRemoved: boolean }> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const source = session.source ?? "csm";
  let worktreeRemoved = false;
  let worktreeCleanup = "skipped";

  // Stop and remove container first (if any)
  if (session.containerId) {
    try {
      await stopAndRemoveContainer(session.containerId);
      logger.info("session.container_removed", {
        sessionName,
        containerId: session.containerId,
      });
    } catch (err) {
      // Container cleanup failure should not block session deletion
      logger.warn("session.container_remove_warning", {
        sessionName,
        containerId: session.containerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Note: session's .claude/ host directory is NOT deleted.
  // Transcripts are preserved for historical access (Req 7.3).

  if (existsSync(session.worktreePath)) {
    try {
      await git(projectPath, [
        "worktree",
        "remove",
        "--force",
        session.worktreePath,
      ]);
      worktreeCleanup = "success";
      worktreeRemoved = true;
    } catch (err) {
      logger.error("session.worktree_remove_failure", {
        sessionName,
        worktreePath: session.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: manual removal
      await rm(session.worktreePath, { recursive: true, force: true });
      worktreeCleanup = "fallback";
      worktreeRemoved = true;
    }
  }

  logger.info("session.delete", {
    sessionName,
    source,
    worktreeCleanup,
  });

  // Remove from state
  await removeSession(projectPath, sessionName);

  return { worktreeRemoved };
}
