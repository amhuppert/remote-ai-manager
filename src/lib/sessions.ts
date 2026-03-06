import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildChildEnv } from "./child-env";
import { defaultGitClient, type GitClient } from "./git-client";
import type {
  ConversationState,
  ImagePayload,
  SessionCreationMode,
  SessionState,
} from "@/types";
import { readState, mutateState } from "./state";
import { createLogger } from "./logging";
import { ensureUniqueName } from "./worktrees";
import { readRepoConfig } from "./repo-config";
import { stopAllForSession } from "./dev-server-registry";
import { getErrorMessage } from "@/lib/errors";
import { getProjectDisplayName } from "./project-resolver";
import { executeOptimisticWorkflow } from "./optimistic";

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

/** Validate session name: non-empty, reasonable length, must produce a valid branch suffix */
export function validateSessionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "Session name cannot be empty";
  }
  if (name.length > 100) {
    return "Session name must be 100 characters or less";
  }
  // The display name is stored as-is; we only require that sanitizing it
  // produces at least one alphanumeric character for a valid branch name.
  if (sanitizeBranchName(name).length === 0) {
    return "Session name must contain at least one letter or number";
  }
  return null;
}

// ============================================================
// Types
// ============================================================

export type MergeMainResult =
  | { status: "clean" }
  | { status: "conflicts"; conflictFiles: string[] };

export interface SessionDeps {
  existsSync: typeof existsSync;
  mkdir: typeof mkdir;
  rm: typeof rm;
  writeFile: typeof writeFile;
  execFileAsync: typeof execFileAsync;
  gitClient: GitClient;
  readState: typeof readState;
  mutateState: typeof mutateState;
  ensureUniqueName: typeof ensureUniqueName;
  readRepoConfig: typeof readRepoConfig;
  stopAllForSession: typeof stopAllForSession;
  getProjectDisplayName: typeof getProjectDisplayName;
  executeOptimisticWorkflow: typeof executeOptimisticWorkflow;
  buildChildEnv: typeof buildChildEnv;
  query: typeof query;
}

export const defaultSessionDeps: SessionDeps = {
  existsSync,
  mkdir,
  rm,
  writeFile,
  execFileAsync,
  gitClient: defaultGitClient,
  readState,
  mutateState,
  ensureUniqueName,
  readRepoConfig,
  stopAllForSession,
  getProjectDisplayName,
  executeOptimisticWorkflow,
  buildChildEnv,
  query,
};

// ============================================================
// Factory
// ============================================================

/**
 * Create a session service backed by the given dependencies.
 * Tests can inject fakes; production uses the default singleton.
 */
export function createSessionService(deps: SessionDeps = defaultSessionDeps) {
  const {
    existsSync,
    mkdir,
    rm,
    writeFile,
    execFileAsync,
    gitClient,
    readState,
    mutateState,
    ensureUniqueName,
    readRepoConfig,
    stopAllForSession,
    getProjectDisplayName,
    executeOptimisticWorkflow,
    buildChildEnv,
    query,
  } = deps;

  /** Execute a git command in the given working directory */
  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return gitClient.git(args, cwd);
  }

  /** Generate a short readable session name from an objective using the Agent SDK */
  async function generateSessionName(
    objective: string,
    projectPath: string,
  ): Promise<string> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 60_000);

    try {
      let text = "";

      const q = query({
        prompt: `Generate a short name (2-4 words, Title Case, space-separated) for a coding session with this objective. Output ONLY the name, nothing else.\n\nObjective: ${objective}`,
        options: {
          model: "haiku",
          maxTurns: 1,
          tools: [],
          mcpServers: {},
          settingSources: [],
          persistSession: false,
          cwd: projectPath,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController,
          env: { CLAUDECODE: "" },
        },
      });

      for await (const message of q) {
        if (message.type === "assistant") {
          const asstMsg = message as SDKAssistantMessage;
          for (const block of asstMsg.message.content) {
            if (block.type === "text" && "text" in block) {
              text += block.text;
            }
          }
        }
      }

      const name = text.trim().split("\n")[0]!.trim();
      if (!name) {
        throw new Error("Session name generation returned empty result");
      }
      if (sanitizeBranchName(name).length === 0) {
        throw new Error(
          "Generated session name is invalid: must contain at least one letter or number",
        );
      }
      return name;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Provision the worktree, run init script, and persist session state.
   * Shared by fast, focus, and optimistic creation flows.
   */
  async function provisionSession(
    projectPath: string,
    sessionName: string,
    opts: {
      mode: SessionCreationMode;
      objective: string | null;
      tddEnabled?: boolean;
    },
  ): Promise<SessionState> {
    const sanitized = sanitizeBranchName(sessionName);
    const branchName = `csm/${sanitized}`;
    const worktreePath = path.join(projectPath, ".worktrees", sanitized);

    if (existsSync(worktreePath)) {
      throw new Error(`Worktree directory already exists: ${worktreePath}`);
    }

    // Build session state with an initial conversation BEFORE creating the
    // worktree on disk. This prevents a race where worktree reconciliation
    // (GET /sessions) sees the new directory before the session is in state
    // and imports it as a duplicate with conversations: [].
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
      source: "cc",
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
      role: opts.mode === "focus" ? "initialization" : null,
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
      source: "cc",
      objective: opts.objective,
      creationMode: opts.mode,
      tddEnabled: opts.tddEnabled ?? true,
      workflow: null,
    };

    // Persist to state first — reconciliation will see this session and skip
    // the worktree directory when it appears on disk moments later.
    await mutateState("createSession", (state) => {
      if (!state.projects[projectPath]) {
        state.projects[projectPath] = {
          rootPath: projectPath,
          sessions: {},
          roadmapItems: [],
        };
      }
      state.projects[projectPath]!.sessions[sessionName] = session;
    });

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
      if (opts.mode !== "focus") {
        // Fast and optimistic modes: direct objective content
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
            ...buildChildEnv(),
            PROJECT_ROOT: projectPath,
            CLAUDE_PROJECT_DIR: projectPath,
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
        error: getErrorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      // Rollback: remove the session from state since creation failed
      try {
        await mutateState("rollbackSession", (state) => {
          const project = state.projects[projectPath];
          if (project) {
            delete project.sessions[sessionName];
          }
        });
      } catch {
        // ignore rollback errors
      }

      // Rollback: remove the worktree if it was created
      try {
        if (existsSync(worktreePath)) {
          await git(projectPath, [
            "worktree",
            "remove",
            "--force",
            worktreePath,
          ]);
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

    return session;
  }

  /**
   * Create a session in fast mode.
   * User provides the session name directly; branch is derived from it.
   */
  async function createSessionFast(
    projectPath: string,
    sessionName: string,
    tddEnabled?: boolean,
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
      throw new Error(
        `Session "${sessionName}" already exists in this project`,
      );
    }

    return provisionSession(projectPath, sessionName, {
      mode: "fast",
      objective: null,
      tddEnabled,
    });
  }

  /**
   * Create a session in focus mode.
   * AI generates the session name from the objective via the Agent SDK.
   */
  async function createSessionFocus(
    projectPath: string,
    objective: string,
    tddEnabled?: boolean,
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
      tddEnabled,
    });
  }

  /**
   * Create a session in optimistic mode.
   * AI generates the session name from the instructions.
   * Launches the optimistic workflow orchestrator as fire-and-forget.
   */
  async function createSessionOptimistic(
    projectPath: string,
    instructions: string,
    images?: ImagePayload[],
    tddEnabled?: boolean,
  ): Promise<SessionState> {
    const baseName = await generateSessionName(instructions, projectPath);

    // Ensure uniqueness within project
    const state = await readState();
    const project = state.projects[projectPath];
    const existingNames = new Set(Object.keys(project?.sessions ?? {}));
    const sessionName = ensureUniqueName(baseName, existingNames);

    const session = await provisionSession(projectPath, sessionName, {
      mode: "optimistic",
      objective: instructions,
      tddEnabled,
    });

    const projectName = getProjectDisplayName(projectPath);

    // Launch orchestrator as fire-and-forget (not awaited)
    void executeOptimisticWorkflow({
      projectPath,
      projectName,
      session,
      instructions,
      images,
    });

    return session;
  }

  /**
   * Delete a session.
   * - For CC-created sessions: removes the worktree directory from disk
   * - For imported sessions: only removes the session record from state
   * - Does NOT delete the branch or transcripts
   */
  async function deleteSession(
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

    // Stop all running dev servers before worktree removal (best-effort)
    try {
      await stopAllForSession({ projectPath, sessionName });
    } catch {
      // best-effort: don't block deletion
    }

    const source = session.source ?? "cc";
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
          error: getErrorMessage(err),
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
    await mutateState("deleteSession", (state) => {
      const proj = state.projects[projectPath];
      if (proj) {
        delete proj.sessions[sessionName];
      }
    });

    return { worktreeRemoved };
  }

  return {
    generateSessionName,
    provisionSession,
    createSessionFast,
    createSessionFocus,
    createSessionOptimistic,
    deleteSession,
  };
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultService = createSessionService();

export const generateSessionName = defaultService.generateSessionName;
export const provisionSession = defaultService.provisionSession;
export const createSessionFast = defaultService.createSessionFast;
export const createSessionFocus = defaultService.createSessionFocus;
export const createSessionOptimistic = defaultService.createSessionOptimistic;
export const deleteSession = defaultService.deleteSession;
