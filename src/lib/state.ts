import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ManagerState,
  ProjectState,
  SessionState,
  ConversationState,
  RoadmapItem,
  RoadmapItemType,
  RoadmapItemStatus,
  ReferenceDocument,
} from "@/types";
import { getErrorMessage } from "@/lib/errors";
import { managerStateSchema } from "./schemas";
import { readConfig } from "./config";
import { createLogger } from "./logging";
import { withStateLock } from "./state-mutex";

const logger = createLogger("state");

// ============================================================
// Types
// ============================================================

export interface StateDeps {
  readConfig: typeof readConfig;
}

export const defaultStateDeps: StateDeps = {
  readConfig,
};

// ============================================================
// Factory
// ============================================================

/**
 * Create a state manager backed by the given config reader.
 * Tests can inject a custom readConfig pointing to a temp directory;
 * production uses the default singleton.
 */
export function createStateManager(deps: StateDeps = defaultStateDeps) {
  const { readConfig } = deps;

  // ----------------------------------------------------------
  // Core I/O
  // ----------------------------------------------------------

  /** Default empty manager state */
  function emptyState(): ManagerState {
    return { projects: {}, archivedProjects: [], pinnedProjects: [] };
  }

  /**
   * Read the manager state from disk.
   * Returns empty state only when the file does not exist (first-time setup).
   * Throws on read errors or schema validation failures to prevent
   * mutateState from writing empty state over a valid file.
   */
  async function readState(): Promise<ManagerState> {
    const config = await readConfig();
    const statePath = config.stateFilePath;

    if (!existsSync(statePath)) {
      return emptyState();
    }

    let raw: string;
    try {
      raw = await readFile(statePath, "utf-8");
    } catch (err) {
      logger.error("state.read_failure", {
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        filePath: statePath,
        error: getErrorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw new Error(
        `Failed to read state file ${statePath}: ${getErrorMessage(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.error("state.parse_failure", {
        filePath: statePath,
        error: getErrorMessage(err),
        fileSize: raw.length,
        preview: raw.slice(0, 200),
      });
      throw new Error(
        `State file contains invalid JSON (${raw.length} bytes): ${getErrorMessage(err)}`,
      );
    }

    const result = managerStateSchema.safeParse(parsed);
    if (!result.success) {
      logger.error("state.schema_validation_failure", {
        filePath: statePath,
        issues: result.error.issues,
        issueCount: result.error.issues.length,
      });
      throw new Error(
        `State file failed schema validation (${result.error.issues.length} issues): ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    return result.data;
  }

  /**
   * Write manager state to disk atomically (write to temp, then rename).
   * This prevents partial writes from corrupting the state file.
   *
   * @deprecated Use `mutateState` instead — direct `writeState` calls
   * bypass the mutex and can cause lost updates. Will be unexported
   * once all callers are migrated.
   */
  async function writeState(
    state: ManagerState,
    label?: string,
  ): Promise<void> {
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
      label,
      projectCount,
      sessionCount,
      fileSize: json.length,
    });

    await writeFile(tmpPath, json, "utf-8");

    try {
      await rename(tmpPath, statePath);
    } catch (err) {
      logger.error("state.rename_failure", {
        tmpPath,
        finalPath: statePath,
        error: getErrorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
  }

  // ----------------------------------------------------------
  // Functional Mutation API (mutex-protected)
  // ----------------------------------------------------------

  /**
   * Read state inside the mutex, apply a mutation, write back.
   * The mutation callback receives a mutable reference to the full state.
   * Returns whatever the callback returns.
   */
  async function mutateState<T = void>(
    label: string,
    mutate: (state: ManagerState) => T | Promise<T>,
  ): Promise<T> {
    return withStateLock(label, async () => {
      const state = await readState();
      const result = await mutate(state);
      await writeState(state, label);

      logger.info("state.mutation", { label });

      return result;
    });
  }

  /**
   * Read state, locate a session, apply a mutation, write back.
   * Creates the project entry if it doesn't exist.
   * Returns whatever the callback returns.
   *
   * Throws if the session is not found.
   */
  async function mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState, project: ProjectState) => T | Promise<T>,
  ): Promise<T> {
    return mutateState<T>(`${label}[${sessionName}]`, async (state) => {
      if (!state.projects[projectPath]) {
        state.projects[projectPath] = {
          rootPath: projectPath,
          sessions: {},
          roadmapItems: [],
        };
      }

      const project = state.projects[projectPath]!;
      const session = project.sessions[sessionName];
      if (!session) {
        throw new Error(
          `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
        );
      }

      return mutate(session, project);
    });
  }

  /**
   * Mutate a specific conversation within a session.
   * Auto-updates lastActivityAt on both conversation and session.
   * Returns whatever the callback returns.
   *
   * Throws if session or conversation is not found.
   */
  async function mutateConversation<T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T> {
    return mutateSession<T>(
      projectPath,
      sessionName,
      label,
      async (session) => {
        const conversation = session.conversations.find(
          (c) => c.id === conversationId,
        );
        if (!conversation) {
          throw new Error(
            `Conversation "${conversationId}" not found in session "${sessionName}" during ${label}`,
          );
        }

        const result = await mutate(conversation);
        conversation.lastActivityAt = new Date().toISOString();
        session.lastActivityAt = new Date().toISOString();
        return result;
      },
    );
  }

  // ----------------------------------------------------------
  // Read-only Queries (no mutex needed)
  // ----------------------------------------------------------

  /** Get all sessions for a project */
  async function getProjectSessions(
    projectPath: string,
  ): Promise<SessionState[]> {
    const state = await readState();
    const project = state.projects[projectPath];
    if (!project) return [];

    return Object.values(project.sessions);
  }

  /** Get a specific session by project path and session name */
  async function getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null> {
    const state = await readState();
    const project = state.projects[projectPath];
    if (!project) return null;

    return project.sessions[sessionName] ?? null;
  }

  /** Read archived project paths from persisted state */
  async function getArchivedProjects(): Promise<Set<string>> {
    const state = await readState();
    return new Set(state.archivedProjects);
  }

  /** Read pinned project paths from persisted state */
  async function getPinnedProjects(): Promise<Set<string>> {
    const state = await readState();
    return new Set(state.pinnedProjects);
  }

  // ----------------------------------------------------------
  // Mutex-Protected Mutations (public API)
  // ----------------------------------------------------------

  /** Get or create a ProjectState entry for a given project path */
  async function getOrCreateProject(
    projectPath: string,
  ): Promise<ProjectState> {
    return mutateState("getOrCreateProject", async (state) => {
      const existing = state.projects[projectPath];
      if (existing) {
        return existing;
      }

      const project: ProjectState = {
        rootPath: projectPath,
        sessions: {},
        roadmapItems: [],
      };

      state.projects[projectPath] = project;
      return project;
    });
  }

  /**
   * Update a specific session within a project and persist.
   *
   * @deprecated Use `mutateSession` instead — this function replaces the
   * entire session object, which can overwrite concurrent changes.
   */
  async function updateSession(
    projectPath: string,
    session: SessionState,
  ): Promise<void> {
    return mutateState("updateSession.deprecated", (state) => {
      if (!state.projects[projectPath]) {
        state.projects[projectPath] = {
          rootPath: projectPath,
          sessions: {},
          roadmapItems: [],
        };
      }

      state.projects[projectPath]!.sessions[session.sessionName] = session;
    });
  }

  /** Remove a session from a project's state */
  async function removeSession(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    return mutateState("removeSession", (state) => {
      const project = state.projects[projectPath];
      if (!project) return;

      delete project.sessions[sessionName];
    });
  }

  /** Set a session's archived flag */
  async function setSessionArchived(
    projectPath: string,
    sessionName: string,
    archived: boolean,
  ): Promise<void> {
    return mutateSession(
      projectPath,
      sessionName,
      "setSessionArchived",
      (session) => {
        session.archived = archived;
      },
    );
  }

  /** Set a session's TDD-enabled flag */
  async function setSessionTddEnabled(
    projectPath: string,
    sessionName: string,
    tddEnabled: boolean,
  ): Promise<void> {
    return mutateSession(
      projectPath,
      sessionName,
      "setSessionTddEnabled",
      (session) => {
        session.tddEnabled = tddEnabled;
      },
    );
  }

  /** Mark a session as finished (merged) and archived atomically */
  async function setSessionFinished(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    return mutateSession(
      projectPath,
      sessionName,
      "setSessionFinished",
      (session) => {
        session.finished = true;
        session.archived = true;
      },
    );
  }

  /** Add or remove a project path from the archived set */
  async function setProjectArchived(
    projectPath: string,
    archived: boolean,
  ): Promise<void> {
    return mutateState("setProjectArchived", (state) => {
      const current = new Set(state.archivedProjects);

      if (archived) {
        current.add(projectPath);
      } else {
        current.delete(projectPath);
      }

      state.archivedProjects = [...current];
    });
  }

  /** Add or remove a project path from the pinned set */
  async function setProjectPinned(
    projectPath: string,
    pinned: boolean,
  ): Promise<void> {
    return mutateState("setProjectPinned", (state) => {
      const current = new Set(state.pinnedProjects);

      if (pinned) {
        current.add(projectPath);
      } else {
        current.delete(projectPath);
      }

      state.pinnedProjects = [...current];
    });
  }

  /**
   * Reset any conversations stuck in "running" or "waiting_for_input" back to "awaiting".
   * Called on server startup — no prompt can survive a restart, so these are stale.
   * Returns the number of conversations recovered.
   */
  async function recoverStaleConversations(): Promise<number> {
    return mutateState("recoverStaleConversations", (state) => {
      let recovered = 0;

      for (const project of Object.values(state.projects)) {
        for (const session of Object.values(project.sessions)) {
          for (const conversation of session.conversations) {
            if (
              conversation.status === "running" ||
              conversation.status === "waiting_for_input"
            ) {
              // Skip conversations with a persisted machine snapshot —
              // rehydrateConversationActors() will restore these actors
              if (conversation.machineSnapshot) {
                logger.info("state.skip_snapshot_conversation", {
                  sessionName: session.sessionName,
                  conversationId: conversation.id,
                  status: conversation.status,
                });
                continue;
              }

              logger.warn("state.recover_stale_conversation", {
                sessionName: session.sessionName,
                conversationId: conversation.id,
                previousStatus: conversation.status,
              });
              conversation.status = "awaiting";
              conversation.pendingQuestionId = null;
              conversation.pendingQuestions = null;
              recovered++;
            }
          }
        }
      }

      if (recovered > 0) {
        logger.info("state.recovery_complete", { recovered });
      }

      return recovered;
    });
  }

  /**
   * Recover conversations stuck in "running" that have no active SDK query.
   * Unlike recoverStaleConversations (startup-only), this can be called anytime
   * to detect orphaned conversations whose prompt execution was lost (e.g., HMR,
   * silent crash, failed finally block). Uses a grace period to avoid racing
   * with prompt startup.
   */
  async function recoverOrphanedConversations(
    isQueryActive: (conversationId: string) => boolean,
    gracePeriodMs: number = 120_000,
  ): Promise<number> {
    const now = Date.now();
    return mutateState("recoverOrphanedConversations", (state) => {
      let recovered = 0;

      for (const project of Object.values(state.projects)) {
        for (const session of Object.values(project.sessions)) {
          for (const conversation of session.conversations) {
            if (conversation.status !== "running") continue;

            // If there's an active query, the conversation is legitimately running
            if (isQueryActive(conversation.id)) continue;

            // Grace period: don't recover conversations that just started
            const lastActive = new Date(conversation.lastActivityAt).getTime();
            if (now - lastActive < gracePeriodMs) continue;

            logger.warn("state.recover_orphaned_conversation", {
              sessionName: session.sessionName,
              conversationId: conversation.id,
              lastActivityAt: conversation.lastActivityAt,
              staleDurationMs: now - lastActive,
            });
            conversation.status = "awaiting";
            conversation.pendingQuestionId = null;
            conversation.pendingQuestions = null;
            recovered++;
          }
        }
      }

      if (recovered > 0) {
        logger.info("state.orphaned_recovery_complete", { recovered });
      }

      return recovered;
    });
  }

  /**
   * On startup, detect workflows stuck in "running" status and reset to "stopped".
   * Follows the same recovery pattern as recoverStaleConversations.
   */
  async function recoverStaleWorkflows(): Promise<number> {
    return mutateState("recoverStaleWorkflows", (state) => {
      let recovered = 0;

      for (const project of Object.values(state.projects)) {
        for (const session of Object.values(project.sessions)) {
          if (session.workflow && session.workflow.status === "running") {
            logger.warn("state.recover_stale_workflow", {
              sessionName: session.sessionName,
              previousStatus: session.workflow.status,
            });
            session.workflow.status = "stopped";
            recovered++;
          }
        }
      }

      if (recovered > 0) {
        logger.info("state.workflow_recovery_complete", { recovered });
      }

      return recovered;
    });
  }

  // ----------------------------------------------------------
  // Roadmap Item Mutations
  // ----------------------------------------------------------

  /** Get all roadmap items for a project (read-only, no mutex) */
  async function getRoadmapItems(projectPath: string): Promise<RoadmapItem[]> {
    const state = await readState();
    const project = state.projects[projectPath];
    return project?.roadmapItems ?? [];
  }

  /** Create a new roadmap item in a project */
  async function createRoadmapItem(
    projectPath: string,
    data: {
      title: string;
      description?: string | null;
      type: RoadmapItemType;
    },
  ): Promise<RoadmapItem> {
    const now = new Date().toISOString();
    const item: RoadmapItem = {
      id: randomUUID(),
      title: data.title,
      description: data.description ?? null,
      type: data.type,
      status: "incomplete",
      archived: false,
      createdAt: now,
      updatedAt: now,
    };

    await mutateState("createRoadmapItem", (state) => {
      if (!state.projects[projectPath]) {
        state.projects[projectPath] = {
          rootPath: projectPath,
          sessions: {},
          roadmapItems: [],
        };
      }
      state.projects[projectPath]!.roadmapItems.push(item);
    });

    return item;
  }

  /** Update a roadmap item's fields */
  async function updateRoadmapItem(
    projectPath: string,
    itemId: string,
    data: {
      title?: string;
      description?: string | null;
      status?: RoadmapItemStatus;
      archived?: boolean;
    },
  ): Promise<void> {
    await mutateState("updateRoadmapItem", (state) => {
      const project = state.projects[projectPath];
      if (!project) {
        throw new Error(`Project "${projectPath}" not found`);
      }

      const item = project.roadmapItems.find((i) => i.id === itemId);
      if (!item) {
        throw new Error(`Roadmap item "${itemId}" not found`);
      }

      if (data.title !== undefined) item.title = data.title;
      if (data.description !== undefined) item.description = data.description;
      if (data.status !== undefined) item.status = data.status;
      if (data.archived !== undefined) item.archived = data.archived;
      item.updatedAt = new Date().toISOString();
    });
  }

  /** Permanently delete a roadmap item */
  async function deleteRoadmapItem(
    projectPath: string,
    itemId: string,
  ): Promise<void> {
    await mutateState("deleteRoadmapItem", (state) => {
      const project = state.projects[projectPath];
      if (!project) {
        throw new Error(`Project "${projectPath}" not found`);
      }

      const index = project.roadmapItems.findIndex((i) => i.id === itemId);
      if (index === -1) {
        throw new Error(`Roadmap item "${itemId}" not found`);
      }

      project.roadmapItems.splice(index, 1);
    });
  }

  // ============================================================
  // Reference Document Operations
  // ============================================================

  /** Create a reference document or update its description if filePath already exists */
  async function createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<ReferenceDocument> {
    return mutateSession<ReferenceDocument>(
      projectPath,
      sessionName,
      "createReferenceDocument",
      (session) => {
        const existing = session.referenceDocuments.find(
          (d) => d.filePath === filePath,
        );
        if (existing) {
          existing.description = description;
          return existing;
        }

        const doc: ReferenceDocument = {
          id: randomUUID(),
          filePath,
          description,
          createdAt: new Date().toISOString(),
        };
        session.referenceDocuments.push(doc);
        return doc;
      },
    );
  }

  /** Remove a reference document from session state, returns the removed doc or null */
  async function deleteReferenceDocument(
    projectPath: string,
    sessionName: string,
    documentId: string,
  ): Promise<ReferenceDocument | null> {
    return mutateSession<ReferenceDocument | null>(
      projectPath,
      sessionName,
      "deleteReferenceDocument",
      (session) => {
        const index = session.referenceDocuments.findIndex(
          (d) => d.id === documentId,
        );
        if (index === -1) return null;
        const [removed] = session.referenceDocuments.splice(index, 1);
        return removed!;
      },
    );
  }

  /** Get all reference documents for a session (read-only, no mutex) */
  async function getReferenceDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<ReferenceDocument[]> {
    const state = await readState();
    const project = state.projects[projectPath];
    const session = project?.sessions[sessionName];
    return session?.referenceDocuments ?? [];
  }

  return {
    readState,
    writeState,
    mutateState,
    mutateSession,
    mutateConversation,
    getProjectSessions,
    getSession,
    getArchivedProjects,
    getPinnedProjects,
    getOrCreateProject,
    updateSession,
    removeSession,
    setSessionArchived,
    setSessionTddEnabled,
    setSessionFinished,
    setProjectArchived,
    setProjectPinned,
    recoverStaleConversations,
    recoverOrphanedConversations,
    recoverStaleWorkflows,
    getRoadmapItems,
    createRoadmapItem,
    updateRoadmapItem,
    deleteRoadmapItem,
    createReferenceDocument,
    deleteReferenceDocument,
    getReferenceDocuments,
  };
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultManager = createStateManager();

export const readState = defaultManager.readState;
export const writeState = defaultManager.writeState;
export const mutateState = defaultManager.mutateState;
export const mutateSession = defaultManager.mutateSession;
export const mutateConversation = defaultManager.mutateConversation;
export const getProjectSessions = defaultManager.getProjectSessions;
export const getSession = defaultManager.getSession;
export const getArchivedProjects = defaultManager.getArchivedProjects;
export const getPinnedProjects = defaultManager.getPinnedProjects;
export const getOrCreateProject = defaultManager.getOrCreateProject;
export const updateSession = defaultManager.updateSession;
export const removeSession = defaultManager.removeSession;
export const setSessionArchived = defaultManager.setSessionArchived;
export const setSessionTddEnabled = defaultManager.setSessionTddEnabled;
export const setSessionFinished = defaultManager.setSessionFinished;
export const setProjectArchived = defaultManager.setProjectArchived;
export const setProjectPinned = defaultManager.setProjectPinned;
export const recoverStaleConversations =
  defaultManager.recoverStaleConversations;
export const recoverOrphanedConversations =
  defaultManager.recoverOrphanedConversations;
export const recoverStaleWorkflows = defaultManager.recoverStaleWorkflows;
export const getRoadmapItems = defaultManager.getRoadmapItems;
export const createRoadmapItem = defaultManager.createRoadmapItem;
export const updateRoadmapItem = defaultManager.updateRoadmapItem;
export const deleteRoadmapItem = defaultManager.deleteRoadmapItem;
export const createReferenceDocument = defaultManager.createReferenceDocument;
export const deleteReferenceDocument = defaultManager.deleteReferenceDocument;
export const getReferenceDocuments = defaultManager.getReferenceDocuments;
