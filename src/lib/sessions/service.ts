import { runAdmittedTask } from "@/lib/agent-backends/task-execution";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  generateRandomSuffix,
  ensureUniqueName,
  validateSessionName,
} from "./repo";
import { sanitizeBranchName } from "./branch-name";
import { buildChildEnv } from "../shared/child-env";
import { defaultGitClient, type GitClient } from "../git/client";
import { ensureCcArtifactsExcluded as defaultEnsureCcArtifactsExcluded } from "../git/worktree";
import { fastRemoveWorktree as defaultFastRemoveWorktree } from "../git/worktree-fast-remove";
import { buildConversation } from "@/lib/conversations/build-conversation";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import type {
  AgentProfileRef,
  AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionCreationMode, SessionState } from "@/lib/sessions/schemas";
import {
  getSession,
  getProjectSessionListItems,
  listProjectPaths,
  createSessionRow,
  deleteSessionRow,
  retargetChildrenToMain,
  applyFusedSessionDelete,
  deleteProjectRow,
} from "../state-store";
import { createLogger, timed } from "../logging";
import type { BulkSessionResult } from "@/lib/sessions/schemas";
import { readRepoConfig } from "../projects/repo-config";
import { readConfig } from "../config/loader";
import { resolveBranchPrefix } from "../config/cascade";
import { stopAllForSession } from "../dev-server/registry";
import { getErrorMessage } from "@/lib/shared/errors";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { executeOptimisticWorkflow } from "../shared/optimistic";
import { stopConversationActor } from "@/lib/workflows/conversation/manager";
import {
  getTaskRunner as registryGetTaskRunner,
  prepareManagedSkillsCheckout as registryPrepareManagedSkillsCheckout,
} from "@/lib/agent-backends/registry";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getNotificationsService } from "../notifications/service";
import { createJobsRepo } from "../jobs/repo";
import { createLaneWorktreeSweep } from "./lane-worktree-sweep";
import { deleteCollaborationArtifacts } from "../workflows/collaboration/artifacts-store";
import { createSessionAlignmentServiceForProduction } from "@/lib/session-alignment/service-factory";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { getStateDb } from "../state-store";
import type {
  ReconcileTicketSessionLifecycleInput,
  TicketProjectDeletionSnapshot,
} from "@/lib/tickets/lifecycle";
import {
  getSessionLifecycleGate,
  type SessionLifecycleOperationContext,
} from "./lifecycle-gate";

const logger = createLogger("sessions");

const execFileAsync = promisify(execFile);

export { sanitizeBranchName } from "./branch-name";
export { generateRandomSuffix, validateSessionName } from "./repo";

/**
 * Reserved project-level session name used by the workflow planner. The
 * leading-and-trailing underscores make it match the reserved-name convention
 * (`isReservedSessionName`), keeping it out of the UI session list. The same
 * literal is used as the on-disk worktree directory.
 */
export const PLANNER_SESSION_NAME = "__planner__";

/**
 * How many sessions one fused delete may remove. A whole 100-session batch in a
 * single mutation held the global write queue for over a second, which every
 * unrelated request behind it waits out; the queue is released between slices.
 */
const FUSED_DELETE_SLICE_SIZE = 10;

// ============================================================
// Types
// ============================================================

interface ProvisionSessionOptions {
  mode: SessionCreationMode;
  tddEnabled?: boolean;
  baseBranch?: string;
  targetBranch?: string;
  parentSessionName?: string;
  reservedDirName?: string;
  // Explicit branch name used verbatim (no prefix). When omitted the branch
  // is derived from the session name + config branch prefix as usual. Used
  // by chat-spawning so a reviewed/edited branch is exactly what gets
  // created (and a duplicate/invalid branch is rejected by `worktree add`).
  branchName?: string;
  /**
   * Profile for the session's initial conversation. Omitted (every system
   * creator, and any flow whose surface offers no picker) yields the explicit
   * Standard Agent snapshot rather than a profile-less conversation (R7).
   */
  profile?: AgentProfileRef | null;
}

export type DeleteSessionIfCurrentResult =
  | { deleted: true; worktreeRemoved: boolean }
  | { deleted: false; reason: "missing" | "replaced" | "finished" };

export interface ExpectedSessionIncarnation {
  createdAt: string;
  worktreePath: string;
  branchName: string;
}

export interface DeleteProjectResult {
  sessionsRemoved: number;
  deletedTicketNumbers: number[];
}

export interface SessionDeps {
  stopConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    reason: string,
  ): Promise<void>;
  existsSync: typeof existsSync;
  rm: typeof rm;
  execFileAsync: typeof execFileAsync;
  gitClient: GitClient;
  /**
   * Git-ignore CC's `.cc/` artifact namespace for the repo owning the worktree
   * (appends to the repo-local `info/exclude`; idempotent). Called at
   * provisioning so no auto-commit ever sweeps ephemeral scratch into a branch.
   */
  ensureCcArtifactsExcluded(worktreePath: string): Promise<void>;
  /**
   * Materialize backend-owned managed-skill discovery state before the new
   * checkout is returned to command-discovery consumers.
   */
  prepareManagedSkillsCheckout(worktreePath: string): Promise<void>;
  fastRemoveWorktree: typeof defaultFastRemoveWorktree;
  /** Detail-tier read of one session (existence check + full slice). */
  getSession: typeof getSession;
  /** List-item-tier read of a project's sessions (name-set + iteration). */
  getProjectSessionListItems: typeof getProjectSessionListItems;
  /** Identity-tier list of project root paths (project existence check). */
  listProjectPaths: typeof listProjectPaths;
  /** Focused session insert (+ initial conversations/refs). */
  createSessionRow: typeof createSessionRow;
  /** Focused single-session delete (provisioning rollback). */
  deleteSessionRow: typeof deleteSessionRow;
  /** Focused retarget of a parent's direct children onto main. */
  retargetChildrenToMain: typeof retargetChildrenToMain;
  /** Focused fused delete (retarget children + delete named sessions). */
  applyFusedSessionDelete: typeof applyFusedSessionDelete;
  /** Focused project-row delete (FK cascade removes sessions/conversations). */
  deleteProjectRow: typeof deleteProjectRow;
  readConfig: typeof readConfig;
  readRepoConfig: typeof readRepoConfig;
  /**
   * Resolve and compose the profile the session's initial conversation runs
   * under. Optional so the production resolver is the default everywhere; a
   * test substitutes it only to prove a non-built-in tier.
   */
  resolveProfileSnapshot?(
    projectPath: string,
    ref?: AgentProfileRef | null,
  ): Promise<AgentProfileSnapshot>;
  stopAllForSession: typeof stopAllForSession;
  getProjectDisplayName: typeof getProjectDisplayName;
  executeOptimisticWorkflow: typeof executeOptimisticWorkflow;
  buildChildEnv: typeof buildChildEnv;
  /** Resolves the backend task runner used for the session-naming turn. */
  getTaskRunner(backend: AgentBackendId): AgentTaskRunner;
  deleteNotificationsForSession(
    projectName: string,
    sessionName: string,
  ): number;
  deleteJobRecordsForSession(projectName: string, sessionName: string): number;
  deleteNotificationsForProject(projectName: string): number;
  deleteJobRecordsForProject(projectName: string): number;
  /**
   * Purge context_artifacts rows for a session, or — without a sessionName —
   * every row for the project. Keys by project PATH (the context_artifacts
   * table stores project_path, unlike the projectName-keyed notification/job
   * cleanups above).
   */
  deleteContextArtifactsForScope(
    projectPath: string,
    sessionName?: string,
  ): number;
  /**
   * Capture ticket ids before the project-row cascade removes the lookup rows.
   */
  captureTicketContentForProject(projectPath: string): Promise<string[]>;
  /** Best-effort removal of captured ticket-content snapshots after cascade. */
  cleanupTicketContentForProject(
    projectPath: string,
    ticketIds: string[],
  ): Promise<void>;
  /**
   * Capture notepad ids before the project-row cascade removes the lookup rows.
   */
  captureNotepadContentForProject(projectPath: string): Promise<string[]>;
  /** Best-effort removal of captured notepad image bytes after cascade. */
  cleanupNotepadContentForProject(
    projectPath: string,
    notepadIds: string[],
  ): Promise<void>;
  runSessionLifecycleOperation<T>(
    projectPath: string,
    sessionName: string,
    operation: (context: SessionLifecycleOperationContext) => Promise<T>,
  ): Promise<T>;
  runSessionLifecycleOperations<T>(
    projectPath: string,
    sessionNames: Iterable<string>,
    operation: (context: SessionLifecycleOperationContext) => Promise<T>,
  ): Promise<T>;
  runSessionProjectDeletion<T>(
    projectPath: string,
    deletion: () => Promise<T>,
  ): Promise<T>;
  /** Excludes ticket operations for the full project-deletion lifecycle. */
  runTicketProjectDeletion<T>(
    projectPath: string,
    deletion: () => Promise<T>,
  ): Promise<T>;
  reconcileTicketSessionLifecycle(
    input: ReconcileTicketSessionLifecycleInput,
  ): Promise<void>;
  captureTicketProjectDeletion(
    projectPath: string,
  ): Promise<TicketProjectDeletionSnapshot>;
  publishTicketProjectDeletion(
    snapshot: TicketProjectDeletionSnapshot,
  ): Promise<void>;
  sweepLaneWorktrees(input: {
    projectPath: string;
    sessionWorktreePath: string;
  }): Promise<string[]>;
  /**
   * Copy the parent session's active alignment charter into a freshly-forked
   * session. Best-effort: implementations must not throw on a missing charter
   * (it is a no-op) — the caller additionally guards so a failure never fails
   * session creation.
   */
  copyAlignmentCharterFromParent(input: {
    projectPath: string;
    sourceSessionName: string;
    targetSessionName: string;
  }): Promise<void>;
}

// Built lazily so importing this module never opens the DB; the alignment
// service is constructed on the first charter copy.
let alignmentService: ReturnType<
  typeof createSessionAlignmentServiceForProduction
> | null = null;

function getAlignmentService() {
  alignmentService ??= createSessionAlignmentServiceForProduction();
  return alignmentService;
}

const defaultSessionDeps: SessionDeps = {
  stopConversationActor,
  existsSync,
  rm,
  execFileAsync,
  gitClient: defaultGitClient,
  ensureCcArtifactsExcluded: (worktreePath) =>
    defaultEnsureCcArtifactsExcluded(worktreePath),
  prepareManagedSkillsCheckout: registryPrepareManagedSkillsCheckout,
  fastRemoveWorktree: defaultFastRemoveWorktree,
  getSession,
  getProjectSessionListItems,
  listProjectPaths,
  createSessionRow,
  deleteSessionRow,
  retargetChildrenToMain,
  applyFusedSessionDelete,
  deleteProjectRow,
  readConfig,
  readRepoConfig,
  stopAllForSession,
  getProjectDisplayName,
  executeOptimisticWorkflow,
  buildChildEnv,
  getTaskRunner: registryGetTaskRunner,
  deleteNotificationsForSession: (projectName, sessionName) =>
    getNotificationsService().deleteNotificationsForSession(
      projectName,
      sessionName,
    ),
  deleteJobRecordsForSession: (projectName, sessionName) =>
    createJobsRepo(getStateDb()).deleteJobRecordsForSession(
      projectName,
      sessionName,
    ),
  deleteNotificationsForProject: (projectName) =>
    getNotificationsService().deleteNotificationsForProject(projectName),
  deleteJobRecordsForProject: (projectName) =>
    createJobsRepo(getStateDb()).deleteJobRecordsForProject(projectName),
  deleteContextArtifactsForScope: (projectPath, sessionName) =>
    createContextArtifactsRepo(getStateDb()).deleteByScope(
      projectPath,
      sessionName,
    ),
  captureTicketContentForProject: async (projectPath) => {
    const { getTicketsRepo } = await import("@/lib/tickets/service-factory");
    return getTicketsRepo().listTicketIds(projectPath);
  },
  cleanupTicketContentForProject: async (projectPath, ticketIds) => {
    // Lazy: the sessions service must never import ticket modules statically
    // (service-factory imports back into sessions/service — an ESM cycle).
    const { getTicketContentStore } =
      await import("@/lib/tickets/service-factory");
    await getTicketContentStore().deleteProject(projectPath, ticketIds);
  },
  captureNotepadContentForProject: async (projectPath) => {
    const { getNotepadsRepo } = await import("@/lib/notepads/service-factory");
    return getNotepadsRepo().listNotepadIds(projectPath);
  },
  cleanupNotepadContentForProject: async (projectPath, notepadIds) => {
    const { getNotepadContentStore } =
      await import("@/lib/notepads/service-factory");
    await getNotepadContentStore().deleteProject(projectPath, notepadIds);
  },
  runSessionLifecycleOperation: (projectPath, sessionName, operation) =>
    getSessionLifecycleGate().runExclusive(projectPath, sessionName, operation),
  runSessionLifecycleOperations: (projectPath, sessionNames, operation) =>
    getSessionLifecycleGate().runExclusiveMany(
      projectPath,
      sessionNames,
      operation,
    ),
  runSessionProjectDeletion: (projectPath, deletion) =>
    getSessionLifecycleGate().runProjectDeletion(projectPath, deletion),
  runTicketProjectDeletion: async (projectPath, deletion) => {
    const { getTicketProjectOperationGate } =
      await import("@/lib/tickets/project-operation-gate");
    return getTicketProjectOperationGate().runProjectDeletion(
      projectPath,
      deletion,
    );
  },
  reconcileTicketSessionLifecycle: async (input) => {
    const { reconcileTicketSessionLifecycle } =
      await import("@/lib/tickets/lifecycle");
    await reconcileTicketSessionLifecycle(input);
  },
  captureTicketProjectDeletion: async (projectPath) => {
    const { captureTicketProjectDeletion } =
      await import("@/lib/tickets/lifecycle");
    return captureTicketProjectDeletion(projectPath);
  },
  publishTicketProjectDeletion: async (snapshot) => {
    const { publishTicketProjectDeletion } =
      await import("@/lib/tickets/lifecycle");
    await publishTicketProjectDeletion(snapshot);
  },
  sweepLaneWorktrees: (input) => createLaneWorktreeSweep().sweep(input),
  copyAlignmentCharterFromParent: async (input) => {
    await getAlignmentService().copyActiveCharter(input);
  },
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
    ensureCcArtifactsExcluded,
    prepareManagedSkillsCheckout,
    fastRemoveWorktree,
    getSession,
    getProjectSessionListItems,
    listProjectPaths,
    createSessionRow,
    deleteSessionRow,
    retargetChildrenToMain,
    applyFusedSessionDelete,
    deleteProjectRow,
    readConfig,
    readRepoConfig,
    stopAllForSession,
    getProjectDisplayName,
    executeOptimisticWorkflow,
    buildChildEnv,
    getTaskRunner,
    deleteNotificationsForSession,
    deleteJobRecordsForSession,
    deleteNotificationsForProject,
    deleteJobRecordsForProject,
    deleteContextArtifactsForScope,
    captureTicketContentForProject,
    cleanupTicketContentForProject,
    captureNotepadContentForProject,
    cleanupNotepadContentForProject,
    runSessionLifecycleOperation,
    runSessionLifecycleOperations,
    runSessionProjectDeletion,
    runTicketProjectDeletion,
    reconcileTicketSessionLifecycle,
    captureTicketProjectDeletion,
    publishTicketProjectDeletion,
    sweepLaneWorktrees,
    copyAlignmentCharterFromParent,
  } = deps;

  function assertProjectWasNotDeleted(
    projectPath: string,
    context: SessionLifecycleOperationContext,
  ): void {
    if (!context.projectDeletionPrecededOperation) return;
    throw new Error(
      `Project was deleted while the session operation waited: ${projectPath}`,
    );
  }

  function runAvailableSessionLifecycleOperation<T>(
    projectPath: string,
    sessionName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runSessionLifecycleOperation(projectPath, sessionName, (context) => {
      assertProjectWasNotDeleted(projectPath, context);
      return operation();
    });
  }

  function runAvailableSessionLifecycleOperations<T>(
    projectPath: string,
    sessionNames: Iterable<string>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runSessionLifecycleOperations(
      projectPath,
      sessionNames,
      (context) => {
        assertProjectWasNotDeleted(projectPath, context);
        return operation();
      },
    );
  }

  /** Execute a git command in the given working directory */
  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return gitClient.git(args, cwd);
  }

  /** Generate a short readable session name from an objective via a backend naming task */
  async function generateSessionName(
    objective: string,
    projectPath: string,
  ): Promise<string> {
    const result = await runAdmittedTask(
      "claude",
      {
        executionClass: "nongoverned-task",
        workingDirectory: projectPath,
        prompt: `Generate a short name (2-4 words, Title Case, space-separated) for a coding session with this objective. Output ONLY the name, nothing else.\n\nObjective: ${objective}`,
        modelSelection: { modelId: "haiku", parameters: {} },
        timeoutMs: 60_000,
        executionProfile: "isolated-one-shot",
        autonomous: true,
      },
      { getRunner: getTaskRunner },
    );

    if (result.error) {
      logger.warn("session.name_generation_failed", {
        projectPath,
        error: result.error,
        timedOut: result.timedOut,
      });
      throw new Error(result.error);
    }

    const name = (result.text ?? "").trim().split("\n")[0]!.trim();
    if (!name) {
      throw new Error("Session name generation returned empty result");
    }
    if (sanitizeBranchName(name).length === 0) {
      throw new Error(
        "Generated session name is invalid: must contain at least one letter or number",
      );
    }
    return name;
  }

  /**
   * Provision the worktree, run init script, and persist session state.
   * Shared by every creation flow (normal, optimistic, chat-spawned, planner).
   *
   * When `opts.reservedDirName` is supplied, the worktree directory and branch
   * suffix use that literal name (no random hex suffix) — used to produce a
   * stable, lazily-created worktree for reserved sessions like the planner.
   */
  async function provisionSessionUnlocked(
    projectPath: string,
    sessionName: string,
    opts: ProvisionSessionOptions,
  ): Promise<SessionState> {
    if (await getSession(projectPath, sessionName)) {
      throw new Error(
        `Session "${sessionName}" already exists in this project`,
      );
    }

    const dirName =
      opts.reservedDirName ??
      `${sanitizeBranchName(sessionName)}-${generateRandomSuffix()}`;

    const globalConfig = await readConfig();
    const repoConfig = await readRepoConfig(projectPath);
    const prefix = resolveBranchPrefix(globalConfig, repoConfig);
    const branchName =
      opts.branchName ?? (prefix ? `${prefix}/${dirName}` : dirName);

    const worktreePath = path.join(projectPath, ".worktrees", dirName);

    if (existsSync(worktreePath)) {
      throw new Error(`Worktree directory already exists: ${worktreePath}`);
    }

    // Build session state with an initial conversation BEFORE creating the
    // worktree on disk. This prevents a race where worktree reconciliation
    // (GET /sessions) sees the new directory before the session is in state
    // and imports it as a duplicate with conversations: [].
    const now = new Date().toISOString();
    // Resolved before the session row is written, so the initial conversation
    // is durable with its profile in place (R6) — no window in which a runtime
    // could be created for a snapshot-less row.
    const profileSnapshot = await (
      deps.resolveProfileSnapshot ?? resolveConversationProfileSnapshot
    )(projectPath, opts.profile);
    const initialConversation = buildConversation({
      id: crypto.randomUUID(),
      scope: "session",
      name: `${sessionName} 1`,
      createdAt: now,
      agentBackend: globalConfig.defaultAgentBackend ?? "claude",
      profileSnapshot,
    });
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
      creationMode: opts.mode,
      tddEnabled: opts.tddEnabled ?? true,
      targetBranch: opts.targetBranch ?? "main",
      parentSessionName: opts.parentSessionName ?? null,
      graphWorkflowExecution: null,
      referenceDocuments: [],
    };

    // Persist to state first — reconciliation will see this session and skip
    // the worktree directory when it appears on disk moments later. Focused
    // insert: the write-queue hold is O(1) in total-state, and the slow
    // provisioning below (git worktree add, init script) runs OUTSIDE any queue
    // callback (no-slow-work-in-critical-section).
    await createSessionRow(projectPath, session);

    try {
      logger.info("session.create", {
        projectName: projectPath,
        sessionName,
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

      // Git-ignore CC's `.cc/` artifact namespace for this repo before any
      // artifact (init-script output, charter, dev-server/validation logs,
      // agent scratch) lands in the worktree, so no auto-commit — merge/commit
      // machines and pre-merge auto-fix all stage with `git add -A` — ever
      // sweeps ephemeral scratch into a branch. Best-effort: a failure here
      // must never fail session creation, and it must not trip the rollback.
      try {
        await ensureCcArtifactsExcluded(worktreePath);
      } catch (err) {
        logger.warn("session.ensure_cc_excluded_failure", {
          projectName: projectPath,
          sessionName,
          worktreePath,
          error: getErrorMessage(err),
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

        // Worktree this session was branched from, so init scripts can copy
        // files from the parent into the new worktree. Falls back to the
        // project root when branched from the main branch (no parent session).
        const parentWorktreePath = opts.parentSessionName
          ? ((await getSession(projectPath, opts.parentSessionName))
              ?.worktreePath ?? projectPath)
          : projectPath;

        await timed(
          logger,
          "session.init_script",
          { scriptPath, worktreePath, parentWorktreePath, sessionName },
          () =>
            execFileAsync(scriptPath, [], {
              cwd: worktreePath,
              env: {
                ...buildChildEnv(),
                PROJECT_ROOT: projectPath,
                CLAUDE_PROJECT_DIR: projectPath,
                WORKTREE_PATH: worktreePath,
                PARENT_WORKTREE_PATH: parentWorktreePath,
                SESSION_NAME: sessionName,
                BRANCH_NAME: branchName,
              },
            }),
        );
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
        await deleteSessionRow(projectPath, sessionName, "rollbackSession");
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

    // Init scripts may replace `.agents/`, so managed-skill discovery state is
    // prepared only after the checkout is otherwise complete. This is
    // best-effort host tooling: a failure degrades autocomplete but must not
    // roll back a valid session and worktree.
    try {
      await prepareManagedSkillsCheckout(worktreePath);
    } catch (err) {
      logger.warn("session.managed_skills_checkout_prepare_failed", {
        projectName: projectPath,
        sessionName,
        worktreePath,
        error: getErrorMessage(err),
      });
    }

    // Seed a forked normal session with its parent's active alignment charter.
    // Best-effort: a copy failure must never fail session creation (the session
    // and worktree are already fully provisioned above).
    if (opts.mode === "normal" && opts.parentSessionName) {
      try {
        await copyAlignmentCharterFromParent({
          projectPath,
          sourceSessionName: opts.parentSessionName,
          targetSessionName: sessionName,
        });
      } catch (err) {
        logger.warn("session.copy_alignment_charter_failure", {
          projectName: projectPath,
          sessionName,
          parentSessionName: opts.parentSessionName,
          error: getErrorMessage(err),
        });
      }
    }

    return session;
  }

  function provisionSession(
    projectPath: string,
    sessionName: string,
    opts: ProvisionSessionOptions,
  ): Promise<SessionState> {
    return runAvailableSessionLifecycleOperation(projectPath, sessionName, () =>
      provisionSessionUnlocked(projectPath, sessionName, opts),
    );
  }

  /**
   * Create a session in normal mode.
   * User provides the session name directly; branch is derived from it.
   */
  async function createSessionNormal(
    projectPath: string,
    sessionName: string,
    tddEnabled?: boolean,
    branchOpts?: {
      baseBranch?: string;
      targetBranch?: string;
      parentSessionName?: string;
      /** Profile for the initial conversation; default when absent (R7). */
      profile?: AgentProfileRef;
    },
  ): Promise<SessionState> {
    const validationError = validateSessionName(sessionName);
    if (validationError) {
      throw new Error(validationError);
    }

    return runAvailableSessionLifecycleOperation(
      projectPath,
      sessionName,
      async () => {
        // Ensure uniqueness within project
        if (await getSession(projectPath, sessionName)) {
          throw new Error(
            `Session "${sessionName}" already exists in this project`,
          );
        }

        return provisionSessionUnlocked(projectPath, sessionName, {
          mode: "normal",
          tddEnabled,
          ...branchOpts,
        });
      },
    );
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
      /** Profile for the initial conversation; default when absent (R7). */
      profile?: AgentProfileRef;
    },
  ): Promise<SessionState> {
    const [baseName, existingSessions] = await Promise.all([
      generateSessionName(instructions, projectPath),
      getProjectSessionListItems(projectPath),
    ]);

    // Ensure uniqueness within project
    const existingNames = new Set(existingSessions.map((s) => s.sessionName));
    const sessionName = ensureUniqueName(baseName, existingNames);

    const session = await provisionSession(projectPath, sessionName, {
      mode: "optimistic",
      tddEnabled,
      ...branchOpts,
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
   * Provision a chat-spawned session deterministically with an explicit name,
   * target, and creation mode — reusing `provisionSession` (worktree + init),
   * the same name validations, and the same name-derived branch (slug + prefix
   * + uniqueness suffix) as the New Session flow. It deliberately does NOT fire
   * any auto-run workflow (even for optimistic mode): the shared
   * readiness-gated first-turn dispatcher delivers the first turn for every
   * mode, and autonomous orchestration beyond the first turn (merging/workflow
   * launches) is out of scope for spawned sessions.
   */
  async function createSpawnedSession(
    projectPath: string,
    input: {
      name: string;
      targetBranch: string;
      mode: SessionCreationMode;
      baseBranch: string;
      tddEnabled?: boolean;
    },
  ): Promise<SessionState> {
    const validationError = validateSessionName(input.name);
    if (validationError) {
      throw new Error(validationError);
    }

    return runAvailableSessionLifecycleOperation(
      projectPath,
      input.name,
      async () => {
        // Ensure uniqueness within project
        if (await getSession(projectPath, input.name)) {
          throw new Error(
            `Session "${input.name}" already exists in this project`,
          );
        }

        return provisionSessionUnlocked(projectPath, input.name, {
          mode: input.mode,
          tddEnabled: input.tddEnabled,
          baseBranch: input.baseBranch,
          targetBranch: input.targetBranch,
        });
      },
    );
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
    return runAvailableSessionLifecycleOperation(
      projectPath,
      PLANNER_SESSION_NAME,
      async () => {
        const existing = await getSession(projectPath, PLANNER_SESSION_NAME);
        if (existing) {
          return existing;
        }

        return provisionSessionUnlocked(projectPath, PLANNER_SESSION_NAME, {
          mode: "normal",
          reservedDirName: PLANNER_SESSION_NAME,
        });
      },
    );
  }

  /**
   * Retarget all direct child sessions to main when their parent is
   * merged or deleted. Only affects direct children — no cascading.
   */
  async function retargetOrphanedChildren(
    projectPath: string,
    parentSessionName: string,
  ): Promise<void> {
    await retargetChildrenToMain(projectPath, parentSessionName);
  }

  /**
   * Run all non-state side effects required to delete a session: close
   * backend runtimes, stop dev servers, remove the worktree directory (with
   * a manual-rm fallback if `git worktree remove` errors), purge transcripts,
   * and delete notification/job-record rows. Does NOT touch the JSON state
   * tree — callers are responsible for the subsequent focused delete.
   */
  async function performSessionDeletionSideEffects(
    projectPath: string,
    sessionName: string,
    session: SessionState,
  ): Promise<{ worktreeRemoved: boolean }> {
    // Awaited before the worktree goes away: a live backend worker holds the
    // worktree as its cwd, so removal has to follow verified teardown.
    for (const conv of session.conversations) {
      await deps.stopConversationActor(
        projectPath,
        sessionName,
        conv.id,
        "session_deletion",
      );
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
        const result = await fastRemoveWorktree({
          projectPath,
          worktreePath: session.worktreePath,
        });
        worktreeCleanup = result.status === "moved" ? "success" : result.status;
        worktreeRemoved = true;
      } catch (err) {
        logger.error("session.worktree_remove_failure", {
          sessionName,
          worktreePath: session.worktreePath,
          error: getErrorMessage(err),
        });
        worktreeCleanup = "failed";
      }
    }

    // Graph-workflow lane worktrees (`<sessionDir>.<laneId>`) outlive halted
    // or aborted executions for forensics; session deletion is their terminal
    // cleanup point.
    const laneWorktreesRemoved = await sweepLaneWorktrees({
      projectPath,
      sessionWorktreePath: session.worktreePath,
    });

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

    // Collaboration artifact streams live in per-workflow JSONL sidecars under
    // $configDir/collab-artifacts/, also outside the worktree, so they need
    // the same explicit purge as transcripts. The keys of `workflowEnvelopes`
    // are the workflow ids whose sidecars to remove.
    for (const workflowId of Object.keys(session.workflowEnvelopes ?? {})) {
      try {
        await deleteCollaborationArtifacts(workflowId);
      } catch (err) {
        logger.warn("session.collab_artifacts_remove_failure", {
          sessionName,
          workflowId,
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
    const contextArtifactsRemoved = deleteContextArtifactsForScope(
      projectPath,
      sessionName,
    );

    logger.info("session.delete", {
      sessionName,
      source,
      worktreeCleanup,
      laneWorktreesRemoved,
      notificationsRemoved,
      jobRecordsRemoved,
      contextArtifactsRemoved,
    });

    return { worktreeRemoved };
  }

  /**
   * Retarget the orphaned children of every deleted parent in
   * `deletedSessionNames` and remove those sessions in one focused delete.
   * Idempotent and safe to call with sessions that no longer exist.
   */
  async function applyFusedDeleteMutation(
    label: string,
    projectPath: string,
    deletedSessionNames: Iterable<string>,
  ): Promise<void> {
    await applyFusedSessionDelete(projectPath, deletedSessionNames, label);
  }

  async function reconcileDeletedTicketSession(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    try {
      await reconcileTicketSessionLifecycle({
        projectPath,
        sessionName,
        endReason: "deleted",
      });
    } catch (err) {
      logger.warn("session.delete.ticket_lifecycle_reconcile_failure", {
        projectPath,
        sessionName,
        error: getErrorMessage(err),
      });
    }
  }

  /**
   * Delete a session.
   * - Removes the worktree directory from disk (for both CC-created and imported sessions)
   * - Removes transcript files for every conversation in the session
   * - Removes notification and job-record rows for the (project, session) pair
   * - Removes the session row from state (which cascades conversations + reference docs)
   * - Does NOT delete the git branch or the project directory on disk
   */
  async function deleteSessionUnlocked(
    projectPath: string,
    sessionName: string,
    expected?: ExpectedSessionIncarnation,
  ): Promise<DeleteSessionIfCurrentResult> {
    const session = await getSession(projectPath, sessionName);
    if (!session) {
      if (expected !== undefined) {
        return { deleted: false, reason: "missing" };
      }
      // Preserve the original error's project-vs-session distinction: a missing
      // session in an existing project is a session error; a missing project is
      // a project error.
      const projectExists = (await listProjectPaths()).includes(projectPath);
      throw new Error(
        projectExists
          ? `Session "${sessionName}" not found in project`
          : `Project not found: ${projectPath}`,
      );
    }
    if (
      expected !== undefined &&
      (session.createdAt !== expected.createdAt ||
        session.worktreePath !== expected.worktreePath ||
        session.branchName !== expected.branchName)
    ) {
      return { deleted: false, reason: "replaced" };
    }
    if (expected !== undefined && session.finished) {
      return { deleted: false, reason: "finished" };
    }

    const result = await performSessionDeletionSideEffects(
      projectPath,
      sessionName,
      session,
    );

    if (expected !== undefined) {
      try {
        await git(projectPath, ["branch", "-D", session.branchName]);
        logger.info("session.compensation_branch_removed", {
          projectPath,
          sessionName,
          branchName: session.branchName,
        });
      } catch (err) {
        logger.error("session.compensation_branch_remove_failure", {
          projectPath,
          sessionName,
          branchName: session.branchName,
          error: getErrorMessage(err),
        });
        throw err;
      }
    }

    await applyFusedDeleteMutation("deleteSession", projectPath, [sessionName]);
    await reconcileDeletedTicketSession(projectPath, sessionName);

    return { deleted: true, worktreeRemoved: result.worktreeRemoved };
  }

  async function deleteSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ worktreeRemoved: boolean }> {
    const result = await runAvailableSessionLifecycleOperation(
      projectPath,
      sessionName,
      () => deleteSessionUnlocked(projectPath, sessionName),
    );
    if (!result.deleted) {
      throw new Error(`Session "${sessionName}" not found in project`);
    }
    return { worktreeRemoved: result.worktreeRemoved };
  }

  function deleteSessionIfCurrent(
    projectPath: string,
    sessionName: string,
    expected: ExpectedSessionIncarnation,
  ): Promise<DeleteSessionIfCurrentResult> {
    return runAvailableSessionLifecycleOperation(projectPath, sessionName, () =>
      deleteSessionUnlocked(projectPath, sessionName, expected),
    );
  }

  /**
   * Delete multiple sessions in a single batch.
   * - Per-session side effects (worktree removal, transcript purge,
   *   notification/job cleanup) run sequentially: concurrent
   *   `git worktree remove` against the same parent repository races on
   *   `.git/config.lock` and fails.
   * - Successful deletions are applied to state through focused
   *   `applyFusedSessionDelete` calls of at most
   *   {@link FUSED_DELETE_SLICE_SIZE} sessions, awaited one after another so the
   *   global write queue is released between slices. That trades the batch's
   *   state mutation being one atomic step for a bounded hold: the end-to-end
   *   guarantee does not exist today anyway, because each session's side effects
   *   (worktree removal, transcript purge) are themselves non-atomic and already
   *   run to completion before any of them is recorded.
   * - A session that was not found is reported as a failure result and
   *   does not abort the rest of the batch.
   */
  async function bulkDeleteSessionsUnlocked(
    projectPath: string,
    sessionNames: string[],
  ): Promise<BulkSessionResult[]> {
    if (!(await listProjectPaths()).includes(projectPath)) {
      throw new Error(`Project not found: ${projectPath}`);
    }

    const results: BulkSessionResult[] = [];
    const succeeded: string[] = [];

    for (const sessionName of sessionNames) {
      const session = await getSession(projectPath, sessionName);
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

    for (
      let offset = 0;
      offset < succeeded.length;
      offset += FUSED_DELETE_SLICE_SIZE
    ) {
      await applyFusedDeleteMutation(
        "bulkDeleteSessions",
        projectPath,
        succeeded.slice(offset, offset + FUSED_DELETE_SLICE_SIZE),
      );
    }
    for (const sessionName of succeeded) {
      await reconcileDeletedTicketSession(projectPath, sessionName);
    }

    return results;
  }

  function bulkDeleteSessions(
    projectPath: string,
    sessionNames: string[],
  ): Promise<BulkSessionResult[]> {
    return runAvailableSessionLifecycleOperations(
      projectPath,
      sessionNames,
      () => bulkDeleteSessionsUnlocked(projectPath, sessionNames),
    );
  }

  /**
   * Delete a project and every trace of it from CC state.
   * - Iterates every session and runs the full session-delete path (worktrees,
   *   transcripts, dev servers, per-session notification/job rows)
   * - Bulk-removes any remaining notification/job rows for the project name
   * - Removes the project row from state (cascades sessions/conversations/refs)
   * - Does NOT delete the project directory on disk or any git branches
   */
  async function deleteProjectGated(
    projectPath: string,
  ): Promise<DeleteProjectResult> {
    if (!(await listProjectPaths()).includes(projectPath)) {
      throw new Error(`Project not found: ${projectPath}`);
    }

    const ticketDeletionSnapshot: TicketProjectDeletionSnapshot =
      await captureTicketProjectDeletion(projectPath);

    let ticketContentIds: string[] | null = null;
    try {
      ticketContentIds = await captureTicketContentForProject(projectPath);
    } catch (err) {
      logger.warn("project.delete.ticket_content_capture_failure", {
        projectPath,
        orphanPathKey: await import("@/lib/tickets/content-store")
          .then((m) => m.TICKET_CONTENT_ROOT_DIRNAME)
          .catch(() => "ticket-content"),
        error: getErrorMessage(err),
      });
    }

    let notepadContentIds: string[] | null = null;
    try {
      notepadContentIds = await captureNotepadContentForProject(projectPath);
    } catch (err) {
      logger.warn("project.delete.notepad_content_capture_failure", {
        projectPath,
        orphanPathKey: await import("@/lib/notepads/content-store")
          .then((m) => m.NOTEPAD_CONTENT_ROOT_DIRNAME)
          .catch(() => "notepad-content"),
        error: getErrorMessage(err),
      });
    }

    const sessionNames = (await getProjectSessionListItems(projectPath)).map(
      (s) => s.sessionName,
    );
    let sessionsRemoved = 0;
    for (const sessionName of sessionNames) {
      try {
        const deletion = await deleteSessionUnlocked(projectPath, sessionName);
        if (!deletion.deleted) {
          throw new Error(`Session "${sessionName}" not found in project`);
        }
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
    // Superset cleanup: project-scope conversations have no per-conversation
    // delete flow, so their artifacts (session_name NULL) — plus any
    // stragglers from sessions whose delete partially failed above — are
    // removed here at project-delete granularity.
    const contextArtifactsRemoved = deleteContextArtifactsForScope(projectPath);

    // Focused project-row delete: the FK cascade removes the project's sessions
    // (and their conversations/reference documents); archived/pinned membership
    // is derived from the project row, so it drops with the row.
    await deleteProjectRow(
      projectPath,
      ticketDeletionSnapshot.externalNeighborTicketIds,
      new Date().toISOString(),
    );

    // Ticket snapshot blobs live outside the DB, so the committed row cascade
    // cannot reach them. The ids were captured while the ticket rows existed;
    // cleanup is best-effort only after no live row can reference a blob.
    if (ticketContentIds !== null) {
      try {
        await cleanupTicketContentForProject(projectPath, ticketContentIds);
      } catch (err) {
        logger.warn("project.delete.ticket_content_cleanup_failure", {
          projectPath,
          orphanPathKey: await import("@/lib/tickets/content-store")
            .then((m) => m.TICKET_CONTENT_ROOT_DIRNAME)
            .catch(() => "ticket-content"),
          error: getErrorMessage(err),
        });
      }
    }

    // Notepad image bytes are the same shape of problem as ticket blobs: the
    // row cascade cannot reach the filesystem, so the ids captured above drive
    // a best-effort sweep once no live row can reference them.
    if (notepadContentIds !== null) {
      try {
        await cleanupNotepadContentForProject(projectPath, notepadContentIds);
      } catch (err) {
        logger.warn("project.delete.notepad_content_cleanup_failure", {
          projectPath,
          orphanPathKey: await import("@/lib/notepads/content-store")
            .then((m) => m.NOTEPAD_CONTENT_ROOT_DIRNAME)
            .catch(() => "notepad-content"),
          error: getErrorMessage(err),
        });
      }
    }

    try {
      await publishTicketProjectDeletion(ticketDeletionSnapshot);
    } catch (err) {
      logger.warn("project.delete.ticket_event_publish_failure", {
        projectPath,
        ticketCount: ticketDeletionSnapshot.ticketNumbers.length,
        error: getErrorMessage(err),
      });
    }

    logger.info("project.delete", {
      projectPath,
      sessionsRemoved,
      notificationsRemoved,
      jobRecordsRemoved,
      contextArtifactsRemoved,
    });

    return {
      sessionsRemoved,
      deletedTicketNumbers: [...ticketDeletionSnapshot.ticketNumbers],
    };
  }

  function deleteProject(projectPath: string): Promise<DeleteProjectResult> {
    return runTicketProjectDeletion(projectPath, () =>
      runSessionProjectDeletion(projectPath, () =>
        deleteProjectGated(projectPath),
      ),
    );
  }

  return {
    generateSessionName,
    provisionSession,
    createSessionNormal,
    createSessionOptimistic,
    createSpawnedSession,
    ensurePlannerSession,
    retargetOrphanedChildren,
    deleteSession,
    deleteSessionIfCurrent,
    bulkDeleteSessions,
    deleteProject,
  };
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultService = createSessionService();

export const createSessionNormal = defaultService.createSessionNormal;
export const createSessionOptimistic = defaultService.createSessionOptimistic;
export const createSpawnedSession = defaultService.createSpawnedSession;
export const ensurePlannerSession = defaultService.ensurePlannerSession;
export const retargetOrphanedChildren = defaultService.retargetOrphanedChildren;
export const deleteSession = defaultService.deleteSession;
export const deleteSessionIfCurrent = defaultService.deleteSessionIfCurrent;
export const bulkDeleteSessions = defaultService.bulkDeleteSessions;
export const deleteProject = defaultService.deleteProject;
