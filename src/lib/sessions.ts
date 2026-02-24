import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ConversationState,
  SessionCreationMode,
  SessionState,
} from "@/types";
import { perRepoConfigSchema, type PerRepoConfig } from "./schemas";
import { readState, writeState } from "./state";
import { createLogger } from "./logging";
import { ensureUniqueName } from "./worktrees";

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

/** Generate a short readable session name from an objective using Claude Haiku */
export async function generateSessionName(
  objective: string,
  projectPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    [
      "--model",
      "haiku",
      "-p",
      `Generate a short name (2-4 words, Title Case, space-separated) for a coding session with this objective. Output ONLY the name, nothing else.\n\nObjective: ${objective}`,
      "--output-format",
      "text",
      "--max-turns",
      "1",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: projectPath,
      timeout: 15_000,
      env: {
        ...process.env,
        CLAUDECODE: "", // Prevent nested session detection
      } as NodeJS.ProcessEnv,
    },
  );

  const name = stdout.trim().split("\n")[0]!.trim();
  if (!name) {
    throw new Error("Session name generation returned empty result");
  }
  const validationError = validateSessionName(name);
  if (validationError) {
    throw new Error(`Generated session name is invalid: ${validationError}`);
  }
  return name;
}

/**
 * Provision the worktree, run init script, and persist session state.
 * Shared by both fast and focus creation flows.
 */
async function provisionSession(
  projectPath: string,
  sessionName: string,
  opts: {
    mode: SessionCreationMode;
    objective: string | null;
  },
): Promise<SessionState> {
  const sanitized = sanitizeBranchName(sessionName);
  const branchName = `csm/${sanitized}`;
  const worktreePath = path.join(projectPath, ".worktrees", sanitized);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree directory already exists: ${worktreePath}`);
  }

  try {
    logger.info("session.create", {
      projectName: projectPath,
      sessionName,
      objective: opts.objective,
      worktreePath,
      branchName,
      mode: opts.mode,
    });

    await git(projectPath, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      "main",
    ]);

    // Write memory-bank/focus.md
    const memoryBankDir = path.join(worktreePath, "memory-bank");
    await mkdir(memoryBankDir, { recursive: true });
    if (opts.mode === "fast") {
      await writeFile(
        path.join(memoryBankDir, "focus.md"),
        `# Session Focus\n\n## Objective\n\n${opts.objective ?? sessionName}\n`,
        "utf-8",
      );
    } else {
      // Focus mode: placeholder — agent will overwrite after research
      await writeFile(
        path.join(memoryBankDir, "focus.md"),
        `# Session Focus\n\n## Objective\n\n${opts.objective}\n\n> This focus document will be enriched after objective analysis.\n`,
        "utf-8",
      );
    }

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
    name: `${sessionName} 1`,
    claudeSessionId: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: now,
    lastActivityAt: now,
    source: "csm",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
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
    objective: opts.objective,
    creationMode: opts.mode,
  };

  // Persist to state
  const state = await readState();
  if (!state.projects[projectPath]) {
    state.projects[projectPath] = {
      rootPath: projectPath,
      sessions: {},
    };
  }
  state.projects[projectPath]!.sessions[sessionName] = session;
  await writeState(state);

  return session;
}

/**
 * Create a session in fast mode.
 * User provides the session name directly; branch is derived from it.
 */
export async function createSessionFast(
  projectPath: string,
  sessionName: string,
): Promise<SessionState> {
  const validationError = validateSessionName(sessionName);
  if (validationError) {
    throw new Error(validationError);
  }

  // Ensure uniqueness within project
  const state = await readState();
  const project = state.projects[projectPath];
  const existingNames = new Set(Object.keys(project?.sessions ?? {}));
  if (existingNames.has(sessionName)) {
    throw new Error(`Session "${sessionName}" already exists in this project`);
  }

  return provisionSession(projectPath, sessionName, {
    mode: "fast",
    objective: null,
  });
}

/**
 * Create a session in focus mode.
 * AI generates the session name from the objective.
 * Throws if name generation fails (no fallback).
 */
export async function createSessionFocus(
  projectPath: string,
  objective: string,
): Promise<SessionState> {
  const baseName = await generateSessionName(objective, projectPath);

  // Ensure uniqueness within project
  const state = await readState();
  const project = state.projects[projectPath];
  const existingNames = new Set(Object.keys(project?.sessions ?? {}));
  const sessionName = ensureUniqueName(baseName, existingNames);

  return provisionSession(projectPath, sessionName, {
    mode: "focus",
    objective,
  });
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
  delete project.sessions[sessionName];
  await writeState(state);

  return { worktreeRemoved };
}
