import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ConversationState, SessionState } from "@/types";
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

const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "for",
  "in",
  "on",
  "of",
  "with",
  "that",
  "this",
  "is",
  "it",
  "be",
  "do",
  "my",
  "our",
]);

/** Generate a short readable session name from an objective using Claude Haiku */
export async function generateSessionName(
  objective: string,
  projectPath: string,
): Promise<string> {
  try {
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
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("CLAUDE"),
            ),
          ),
        } as NodeJS.ProcessEnv,
      },
    );

    const name = stdout.trim().split("\n")[0]!.trim();
    if (name && validateSessionName(name) === null) {
      return name;
    }
    // Haiku returned something invalid — fall through to heuristic
  } catch (err) {
    logger.warn("session.name_generation_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return fallbackSessionName(objective);
}

/** Capitalize the first letter of a word */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Derive a session name from objective text using simple heuristics */
function fallbackSessionName(objective: string): string {
  const words = objective
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /^[a-z0-9]+$/.test(w))
    .filter((w) => !FILLER_WORDS.has(w));
  const name = words.slice(0, 4).map(capitalize).join(" ");
  return name || "Session";
}

/**
 * Create a new session for a project.
 * - Auto-generates session name from objective via Claude Haiku
 * - Creates a worktree from main
 * - Creates branch csm/<sanitized-name>
 * - Writes memory-bank/focus.md with the objective
 * - Runs optional init script
 * - On failure, rolls back completely
 */
export async function createSession(
  projectPath: string,
  objective: string,
): Promise<SessionState> {
  // Generate session name from objective
  const baseName = await generateSessionName(objective, projectPath);

  // Ensure uniqueness within project
  const state = await readState();
  const project = state.projects[projectPath];
  const existingNames = new Set(Object.keys(project?.sessions ?? {}));
  const sessionName = ensureUniqueName(baseName, existingNames);

  // Validate the generated name
  const validationError = validateSessionName(sessionName);
  if (validationError) {
    throw new Error(`Generated session name is invalid: ${validationError}`);
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
      objective,
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

    // Write memory-bank/focus.md with the objective
    const memoryBankDir = path.join(worktreePath, "memory-bank");
    await mkdir(memoryBankDir, { recursive: true });
    await writeFile(
      path.join(memoryBankDir, "focus.md"),
      `# Session Focus\n\n## Objective\n\n${objective}\n`,
      "utf-8",
    );

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
    objective,
  };

  // Persist to state
  if (!state.projects[projectPath]) {
    state.projects[projectPath] = {
      rootPath: projectPath,
      sessions: {},
    };
  }
  // Safe to assert: we just ensured the project exists above
  state.projects[projectPath]!.sessions[sessionName] = session;
  await writeState(state);

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
