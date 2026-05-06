import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
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
import { readConfig, resolveBranchPrefix } from "./config";
import { stopAllForSession } from "./dev-server-registry";
import { getErrorMessage } from "@/lib/errors";
import { getProjectDisplayName } from "./project-resolver";
import { executeOptimisticWorkflow } from "./optimistic";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import type { ArtifactRegistry } from "./workflows/primitives/artifact-registry";
import { createSessionArtifactRegistryForProduction } from "./workflows/primitives/default-session-artifact-registry";

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

/** Generate a 6-character random hex suffix for branch/worktree uniqueness */
export function generateRandomSuffix(): string {
  return crypto.randomBytes(3).toString("hex");
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
  rm: typeof rm;
  execFileAsync: typeof execFileAsync;
  gitClient: GitClient;
  readState: typeof readState;
  mutateState: typeof mutateState;
  ensureUniqueName: typeof ensureUniqueName;
  readConfig: typeof readConfig;
  readRepoConfig: typeof readRepoConfig;
  stopAllForSession: typeof stopAllForSession;
  getProjectDisplayName: typeof getProjectDisplayName;
  executeOptimisticWorkflow: typeof executeOptimisticWorkflow;
  buildChildEnv: typeof buildChildEnv;
  query: typeof query;
  createSessionArtifactRegistry(input: {
    projectPath: string;
    sessionName: string;
  }): ArtifactRegistry;
}

export const defaultSessionDeps: SessionDeps = {
  existsSync,
  rm,
  execFileAsync,
  gitClient: defaultGitClient,
  readState,
  mutateState,
  ensureUniqueName,
  readConfig,
  readRepoConfig,
  stopAllForSession,
  getProjectDisplayName,
  executeOptimisticWorkflow,
  buildChildEnv,
  query,
  createSessionArtifactRegistry: createSessionArtifactRegistryForProduction,
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
    rm,
    execFileAsync,
    gitClient,
    readState,
    mutateState,
    ensureUniqueName,
    readConfig,
    readRepoConfig,
    stopAllForSession,
    getProjectDisplayName,
    executeOptimisticWorkflow,
    buildChildEnv,
    query,
    createSessionArtifactRegistry,
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
          env: { ...buildChildEnv(), CLAUDECODE: "" } as Record<string, string>,
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
      baseBranch?: string;
      targetBranch?: string;
      parentSessionName?: string;
    },
  ): Promise<SessionState> {
    const sanitized = sanitizeBranchName(sessionName);
    const suffix = generateRandomSuffix();
    const dirName = `${sanitized}-${suffix}`;

    const globalConfig = await readConfig();
    const repoConfig = await readRepoConfig(projectPath);
    const prefix = resolveBranchPrefix(globalConfig, repoConfig);
    const branchName = prefix ? `${prefix}/${dirName}` : dirName;

    const worktreePath = path.join(projectPath, ".worktrees", dirName);

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
      contextTokens: null,
      contextWindowMax: null,
      debugMode: null,
      machineSnapshot: null,
      agentBackend: "claude",
      backendRef: null,
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
      targetBranch: opts.targetBranch ?? "main",
      parentSessionName: opts.parentSessionName ?? null,
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
      referenceDocuments: [],
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
        opts.baseBranch ?? "main",
      ]);

      // Focus mode writes a placeholder focus.md that the agent enriches after research.
      // Fast and optimistic modes skip this — focus.md is only for the Focus Mode workflow.
      if (opts.mode === "focus") {
        const registry = createSessionArtifactRegistry({
          projectPath,
          sessionName,
        });
        await registry.write({
          kind: "focus_memory",
          worktreePath,
          relativePath: "memory-bank/focus.md",
          contents: `# Session Focus\n\n## Objective\n\n${opts.objective}\n\n> This focus document will be enriched after objective analysis.\n`,
          audience: "user_facing",
          required: true,
          source: { workflowId: "session-init" },
          description:
            "Session focus document — captures the objective and is enriched after objective analysis.",
        });
      }

      // Run optional init script
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
    branchOpts?: {
      baseBranch?: string;
      targetBranch?: string;
      parentSessionName?: string;
    },
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
      ...branchOpts,
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
    branchOpts?: {
      baseBranch?: string;
      targetBranch?: string;
      parentSessionName?: string;
    },
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
      ...branchOpts,
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
    branchOpts?: {
      baseBranch?: string;
      targetBranch?: string;
      parentSessionName?: string;
    },
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
      ...branchOpts,
    });

    const projectName = getProjectDisplayName(projectPath);

    // Resolve parent worktree path when targeting a non-main branch
    let targetWorktreePath: string | undefined;
    const targetBranch = session.targetBranch ?? "main";
    if (targetBranch !== "main" && session.parentSessionName) {
      const parentSession = project?.sessions[session.parentSessionName];
      targetWorktreePath = parentSession?.worktreePath;
    }

    // Launch orchestrator as fire-and-forget (not awaited)
    void executeOptimisticWorkflow({
      projectPath,
      projectName,
      session,
      instructions,
      images,
      targetWorktreePath,
    });

    return session;
  }

  /**
   * Retarget all direct child sessions to main when their parent is
   * merged or deleted. Only affects direct children — no cascading.
   */
  async function retargetOrphanedChildren(
    projectPath: string,
    parentSessionName: string,
  ): Promise<void> {
    await mutateState("retargetOrphanedChildren", (state) => {
      const project = state.projects[projectPath];
      if (!project) return;

      for (const session of Object.values(project.sessions)) {
        if (session.parentSessionName === parentSessionName) {
          session.targetBranch = "main";
          session.parentSessionName = null;
        }
      }
    });
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

    // Close any active backend runtimes before removal
    for (const conv of session.conversations) {
      try {
        getRuntime(conv.id)?.close();
      } catch {
        // best-effort: don't block deletion
      }
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

    // Retarget any child sessions before removing parent from state
    await retargetOrphanedChildren(projectPath, sessionName);

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
    retargetOrphanedChildren,
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
export const retargetOrphanedChildren = defaultService.retargetOrphanedChildren;
export const deleteSession = defaultService.deleteSession;
