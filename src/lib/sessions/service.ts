import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  sanitizeBranchName,
  generateRandomSuffix,
  ensureUniqueName,
  validateSessionName,
} from "./repo";
import { buildChildEnv } from "../shared/child-env";
import { defaultGitClient, type GitClient } from "../git/client";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionCreationMode, SessionState } from "@/lib/sessions/schemas";
import { readState, mutateState } from "../state-store";
import { createLogger, timed } from "../logging";
import type { BulkSessionResult } from "@/lib/sessions/schemas";
import { readRepoConfig } from "../projects/repo-config";
import { readConfig } from "../config/loader";
import { resolveBranchPrefix } from "../config/cascade";
import { stopAllForSession } from "../dev-server/registry";
import { getErrorMessage } from "@/lib/shared/errors";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { executeOptimisticWorkflow } from "../shared/optimistic";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import {
  deleteNotificationsForSession as defaultDeleteNotificationsForSession,
  deleteNotificationsForProject as defaultDeleteNotificationsForProject,
} from "../notifications/repo";
import {
  deleteJobRecordsForSession as defaultDeleteJobRecordsForSession,
  deleteJobRecordsForProject as defaultDeleteJobRecordsForProject,
} from "../jobs/repo";
import type { ArtifactRegistry } from "../workflows/primitives/artifact-registry";
import { createSessionArtifactRegistryForProduction } from "../workflows/primitives/default-session-artifact-registry";

const logger = createLogger("sessions");

const execFileAsync = promisify(execFile);

export {
  sanitizeBranchName,
  generateRandomSuffix,
  validateSessionName,
} from "./repo";

/**
 * Reserved project-level session name used by the workflow planner. The
 * leading-and-trailing underscores make it match the reserved-name convention
 * (`isReservedSessionName`), keeping it out of the UI session list. The same
 * literal is used as the on-disk worktree directory.
 */
export const PLANNER_SESSION_NAME = "__planner__";

// ============================================================
// Types
// ============================================================

export interface SessionDeps {
  existsSync: typeof existsSync;
  rm: typeof rm;
  execFileAsync: typeof execFileAsync;
  gitClient: GitClient;
  readState: typeof readState;
  mutateState: typeof mutateState;
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
  deleteNotificationsForSession(
    projectName: string,
    sessionName: string,
  ): number;
  deleteJobRecordsForSession(projectName: string, sessionName: string): number;
  deleteNotificationsForProject(projectName: string): number;
  deleteJobRecordsForProject(projectName: string): number;
}

const defaultSessionDeps: SessionDeps = {
  existsSync,
  rm,
  execFileAsync,
  gitClient: defaultGitClient,
  readState,
  mutateState,
  readConfig,
  readRepoConfig,
  stopAllForSession,
  getProjectDisplayName,
  executeOptimisticWorkflow,
  buildChildEnv,
  query,
  createSessionArtifactRegistry: createSessionArtifactRegistryForProduction,
  deleteNotificationsForSession: defaultDeleteNotificationsForSession,
  deleteJobRecordsForSession: defaultDeleteJobRecordsForSession,
  deleteNotificationsForProject: defaultDeleteNotificationsForProject,
  deleteJobRecordsForProject: defaultDeleteJobRecordsForProject,
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
    readConfig,
    readRepoConfig,
    stopAllForSession,
    getProjectDisplayName,
    executeOptimisticWorkflow,
    buildChildEnv,
    query,
    createSessionArtifactRegistry,
    deleteNotificationsForSession,
    deleteJobRecordsForSession,
    deleteNotificationsForProject,
    deleteJobRecordsForProject,
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
   *
   * When `opts.reservedDirName` is supplied, the worktree directory and branch
   * suffix use that literal name (no random hex suffix) — used to produce a
   * stable, lazily-created worktree for reserved sessions like the planner.
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
      reservedDirName?: string;
    },
  ): Promise<SessionState> {
    const dirName =
      opts.reservedDirName ??
      `${sanitizeBranchName(sessionName)}-${generateRandomSuffix()}`;

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
      pendingPromptText: null,
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
    const [baseName, state] = await Promise.all([
      generateSessionName(objective, projectPath),
      readState(),
    ]);

    // Ensure uniqueness within project
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
    const [baseName, state] = await Promise.all([
      generateSessionName(instructions, projectPath),
      readState(),
    ]);

    // Ensure uniqueness within project
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
   * Lazily create the project-level reserved planner session.
   *
   * Returns the existing `__planner__` session if one is already persisted for
   * the project; otherwise provisions a fresh worktree at
   * `.worktrees/__planner__` (deterministic, no random suffix) plus the
   * initial conversation row. The planner runs every workflow-generation turn
   * against this session so its conversation actor has a stable transcript
   * the user can audit/replay.
   */
  async function ensurePlannerSession(
    projectPath: string,
  ): Promise<SessionState> {
    const state = await readState();
    const existing =
      state.projects[projectPath]?.sessions[PLANNER_SESSION_NAME];
    if (existing) {
      return existing;
    }

    return provisionSession(projectPath, PLANNER_SESSION_NAME, {
      mode: "fast",
      objective: null,
      reservedDirName: PLANNER_SESSION_NAME,
    });
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
   * Run all non-state side effects required to delete a session: close
   * backend runtimes, stop dev servers, remove the worktree directory (with
   * a manual-rm fallback if `git worktree remove` errors), purge transcripts,
   * and delete notification/job-record rows. Does NOT touch the JSON state
   * tree — callers are responsible for the subsequent mutateState.
   */
  async function performSessionDeletionSideEffects(
    projectPath: string,
    sessionName: string,
    session: SessionState,
  ): Promise<{ worktreeRemoved: boolean }> {
    for (const conv of session.conversations) {
      try {
        getRuntime(conv.id)?.close();
      } catch {
        // best-effort: don't block deletion
      }
    }

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
        await timed(
          logger,
          "session.worktree_remove",
          { sessionName, worktreePath: session.worktreePath, cleanup: "git" },
          () =>
            git(projectPath, [
              "worktree",
              "remove",
              "--force",
              session.worktreePath,
            ]),
        );
        worktreeCleanup = "success";
        worktreeRemoved = true;
      } catch (err) {
        logger.error("session.worktree_remove_failure", {
          sessionName,
          worktreePath: session.worktreePath,
          error: getErrorMessage(err),
        });
        await timed(
          logger,
          "session.worktree_remove",
          {
            sessionName,
            worktreePath: session.worktreePath,
            cleanup: "fallback",
          },
          () => rm(session.worktreePath, { recursive: true, force: true }),
        );
        worktreeCleanup = "fallback";
        worktreeRemoved = true;
      }
    }

    // Transcripts are stored centrally under $configDir/transcripts/, not in
    // the worktree, so they survive worktree removal unless purged explicitly.
    for (const conv of session.conversations) {
      if (!conv.transcriptPath) continue;
      try {
        await rm(conv.transcriptPath, { force: true });
      } catch (err) {
        logger.warn("session.transcript_remove_failure", {
          sessionName,
          conversationId: conv.id,
          transcriptPath: conv.transcriptPath,
          error: getErrorMessage(err),
        });
      }
    }

    const projectName = getProjectDisplayName(projectPath);
    const notificationsRemoved = deleteNotificationsForSession(
      projectName,
      sessionName,
    );
    const jobRecordsRemoved = deleteJobRecordsForSession(
      projectName,
      sessionName,
    );

    logger.info("session.delete", {
      sessionName,
      source,
      worktreeCleanup,
      notificationsRemoved,
      jobRecordsRemoved,
    });

    return { worktreeRemoved };
  }

  /**
   * Apply a single whole-state mutation that retargets orphaned children of
   * any deleted parent in `deletedSessionNames` and removes those sessions
   * from the project. Idempotent and safe to call with sessions that no
   * longer exist.
   */
  async function applyFusedDeleteMutation(
    label: string,
    projectPath: string,
    deletedSessionNames: Iterable<string>,
  ): Promise<void> {
    const deletedSet = new Set(deletedSessionNames);
    if (deletedSet.size === 0) return;
    await mutateState(label, (state) => {
      const proj = state.projects[projectPath];
      if (!proj) return;
      for (const child of Object.values(proj.sessions)) {
        if (
          child.parentSessionName &&
          deletedSet.has(child.parentSessionName)
        ) {
          child.targetBranch = "main";
          child.parentSessionName = null;
        }
      }
      for (const name of deletedSet) {
        delete proj.sessions[name];
      }
    });
  }

  /**
   * Delete a session.
   * - Removes the worktree directory from disk (for both CC-created and imported sessions)
   * - Removes transcript files for every conversation in the session
   * - Removes notification and job-record rows for the (project, session) pair
   * - Removes the session row from state (which cascades conversations + reference docs)
   * - Does NOT delete the git branch or the project directory on disk
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

    const result = await performSessionDeletionSideEffects(
      projectPath,
      sessionName,
      session,
    );

    await applyFusedDeleteMutation("deleteSession", projectPath, [sessionName]);

    return result;
  }

  /**
   * Delete multiple sessions in a single batch.
   * - Per-session side effects (worktree removal, transcript purge,
   *   notification/job cleanup) run sequentially: concurrent
   *   `git worktree remove` against the same parent repository races on
   *   `.git/config.lock` and fails.
   * - All successful deletions are applied to JSON state via a single
   *   `mutateState` at the end (see PERFORMANCE.md — bulk routes pay the
   *   whole-state diff cost once per batch, not once per item).
   * - A session that was not found is reported as a failure result and
   *   does not abort the rest of the batch.
   */
  async function bulkDeleteSessions(
    projectPath: string,
    sessionNames: string[],
  ): Promise<BulkSessionResult[]> {
    const state = await readState();
    const project = state.projects[projectPath];
    if (!project) {
      throw new Error(`Project not found: ${projectPath}`);
    }

    const results: BulkSessionResult[] = [];
    const succeeded: string[] = [];

    for (const sessionName of sessionNames) {
      const session = project.sessions[sessionName];
      if (!session) {
        results.push({
          sessionName,
          success: false,
          error: `Session "${sessionName}" not found in project`,
        });
        continue;
      }
      try {
        await performSessionDeletionSideEffects(
          projectPath,
          sessionName,
          session,
        );
        succeeded.push(sessionName);
        results.push({ sessionName, success: true });
      } catch (err) {
        results.push({
          sessionName,
          success: false,
          error: getErrorMessage(err),
        });
      }
    }

    await applyFusedDeleteMutation(
      "bulkDeleteSessions",
      projectPath,
      succeeded,
    );

    return results;
  }

  /**
   * Delete a project and every trace of it from CC state.
   * - Iterates every session and runs the full session-delete path (worktrees,
   *   transcripts, dev servers, per-session notification/job rows)
   * - Bulk-removes any remaining notification/job rows for the project name
   * - Removes the project row from state (cascades sessions/conversations/refs)
   * - Does NOT delete the project directory on disk or any git branches
   */
  async function deleteProject(
    projectPath: string,
  ): Promise<{ sessionsRemoved: number }> {
    const state = await readState();
    const project = state.projects[projectPath];
    if (!project) {
      throw new Error(`Project not found: ${projectPath}`);
    }

    const sessionNames = Object.keys(project.sessions);
    let sessionsRemoved = 0;
    for (const sessionName of sessionNames) {
      try {
        await deleteSession(projectPath, sessionName);
        sessionsRemoved += 1;
      } catch (err) {
        logger.warn("project.delete.session_remove_failure", {
          projectPath,
          sessionName,
          error: getErrorMessage(err),
        });
        sessionsRemoved += 1;
      }
    }

    const projectName = getProjectDisplayName(projectPath);
    const notificationsRemoved = deleteNotificationsForProject(projectName);
    const jobRecordsRemoved = deleteJobRecordsForProject(projectName);

    await mutateState("deleteProject", (state) => {
      delete state.projects[projectPath];
      state.archivedProjects = state.archivedProjects.filter(
        (p) => p !== projectPath,
      );
      state.pinnedProjects = state.pinnedProjects.filter(
        (p) => p !== projectPath,
      );
    });

    logger.info("project.delete", {
      projectPath,
      sessionsRemoved,
      notificationsRemoved,
      jobRecordsRemoved,
    });

    return { sessionsRemoved };
  }

  return {
    generateSessionName,
    provisionSession,
    createSessionFast,
    createSessionFocus,
    createSessionOptimistic,
    ensurePlannerSession,
    retargetOrphanedChildren,
    deleteSession,
    bulkDeleteSessions,
    deleteProject,
  };
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultService = createSessionService();

export const createSessionFast = defaultService.createSessionFast;
export const createSessionFocus = defaultService.createSessionFocus;
export const createSessionOptimistic = defaultService.createSessionOptimistic;
export const ensurePlannerSession = defaultService.ensurePlannerSession;
export const retargetOrphanedChildren = defaultService.retargetOrphanedChildren;
export const deleteSession = defaultService.deleteSession;
export const bulkDeleteSessions = defaultService.bulkDeleteSessions;
export const deleteProject = defaultService.deleteProject;
