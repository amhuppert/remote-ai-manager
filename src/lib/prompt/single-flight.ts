/**
 * Locks for serializing operations that share state.
 *
 * Conversation locks prevent two prompts from running concurrently against
 * the same conversation (same transcript / runtime). Multiple conversations
 * in the same session may hold their locks simultaneously, allowing parallel
 * agent activity within a single worktree.
 *
 * Session locks serialize git-mutating background jobs (merge / commit /
 * resolve-conflicts) within a session.
 *
 * Project locks serialize squash merge operations across sessions within
 * the same project, ensuring only one squash merge targets main at a time.
 *
 * All three use in-memory Maps — if a lock is already held, callers receive
 * an immediate rejection rather than queuing.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

/* ------------------------------------------------------------------ */
/*  LockManager interface and factory                                 */
/* ------------------------------------------------------------------ */

export interface LockManager {
  isProjectLocked(projectPath: string): boolean;
  acquireProjectLock(projectPath: string): () => void;
  isSessionBusy(projectPath: string, sessionName: string): boolean;
  acquireSessionLock(projectPath: string, sessionName: string): () => void;
  forceReleaseSessionLock(projectPath: string, sessionName: string): boolean;
  getHeldSessionLocks(): Array<{
    projectPath: string;
    sessionName: string;
  }>;
  /** `storeSessionName` is the session-keyed storage name, which is the project
   *  sentinel for a project conversation — see {@link acquireConversationLock}. */
  isConversationBusy(
    projectPath: string,
    storeSessionName: string,
    conversationId: string,
  ): boolean;
  /**
   * The conversation lock serves BOTH scopes through one session-keyed name, so
   * `storeSessionName` is the project sentinel for a project conversation. It
   * keys the in-memory Map (an internal runtime concern, A5) and is deliberately
   * never logged: the lock's structured events carry the discriminated scope
   * instead, so a project turn cannot report the sentinel as a session (R1.3).
   */
  acquireConversationLock(
    projectPath: string,
    storeSessionName: string,
    conversationId: string,
  ): () => void;
}

/** Create an isolated LockManager instance with its own lock state. */
export function createLockManager(
  log: Logger = createLogger("lock"),
): LockManager {
  const sessionLocks = new Map<string, Promise<void>>();
  const projectLocks = new Map<string, true>();
  const conversationLocks = new Map<string, Promise<void>>();

  function lockKey(projectPath: string, sessionName: string): string {
    return `${projectPath}::${sessionName}`;
  }

  function conversationLockKey(
    projectPath: string,
    storeSessionName: string,
    conversationId: string,
  ): string {
    return `${projectPath}::${storeSessionName}::${conversationId}`;
  }

  /** Diagnostic identity for a conversation lock event: scope-discriminated, so
   *  the project variant has no `sessionName` key for the sentinel to occupy. */
  function conversationLockFields(
    projectPath: string,
    storeSessionName: string,
    conversationId: string,
  ): Record<string, unknown> {
    return {
      projectPath,
      ...scopeRefFromStoreSessionName(storeSessionName),
      conversationId,
    };
  }

  return {
    isProjectLocked(projectPath: string): boolean {
      return projectLocks.has(projectPath);
    },

    acquireProjectLock(projectPath: string): () => void {
      if (projectLocks.has(projectPath)) {
        log.warn("project-lock.rejected", { projectPath });
        throw new Error(
          "Project is locked — a squash merge is already in progress",
        );
      }

      projectLocks.set(projectPath, true);
      log.debug("project-lock.acquired", { projectPath });

      return () => {
        projectLocks.delete(projectPath);
        log.debug("project-lock.released", { projectPath });
      };
    },

    isSessionBusy(projectPath: string, sessionName: string): boolean {
      return sessionLocks.has(lockKey(projectPath, sessionName));
    },

    acquireSessionLock(projectPath: string, sessionName: string): () => void {
      const key = lockKey(projectPath, sessionName);

      if (sessionLocks.has(key)) {
        log.warn("lock.rejected", { projectPath, sessionName });
        throw new Error("Session is busy — a prompt is already running");
      }

      let releaseFn: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });

      sessionLocks.set(key, promise);
      log.debug("lock.acquired", { projectPath, sessionName });

      return () => {
        sessionLocks.delete(key);
        releaseFn?.();
        log.debug("lock.released", { projectPath, sessionName });
      };
    },

    forceReleaseSessionLock(projectPath: string, sessionName: string): boolean {
      const key = lockKey(projectPath, sessionName);
      if (!sessionLocks.has(key)) return false;
      sessionLocks.delete(key);
      log.warn("lock.force_released", { projectPath, sessionName });
      return true;
    },

    getHeldSessionLocks(): Array<{
      projectPath: string;
      sessionName: string;
    }> {
      return Array.from(sessionLocks.keys()).map((key) => {
        const sep = key.indexOf("::");
        return {
          projectPath: key.slice(0, sep),
          sessionName: key.slice(sep + 2),
        };
      });
    },

    isConversationBusy(
      projectPath: string,
      storeSessionName: string,
      conversationId: string,
    ): boolean {
      return conversationLocks.has(
        conversationLockKey(projectPath, storeSessionName, conversationId),
      );
    },

    acquireConversationLock(
      projectPath: string,
      storeSessionName: string,
      conversationId: string,
    ): () => void {
      const key = conversationLockKey(
        projectPath,
        storeSessionName,
        conversationId,
      );
      const fields = conversationLockFields(
        projectPath,
        storeSessionName,
        conversationId,
      );

      if (conversationLocks.has(key)) {
        log.warn("conversation-lock.rejected", fields);
        throw new Error(
          "Conversation is busy — a prompt is already running for this conversation",
        );
      }

      let releaseFn: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });

      conversationLocks.set(key, promise);
      log.debug("conversation-lock.acquired", fields);

      return () => {
        conversationLocks.delete(key);
        releaseFn?.();
        log.debug("conversation-lock.released", fields);
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Global singleton instance (HMR-safe, backward-compatible)         */
/* ------------------------------------------------------------------ */

const LOCK_MANAGER_KEY = "__cc_lock_manager" as const;

function getDefaultLockManager(): LockManager {
  return getGlobalSingleton(LOCK_MANAGER_KEY, () => createLockManager());
}

/** Check whether a project-level merge lock is currently held */
export function isProjectLocked(projectPath: string): boolean {
  return getDefaultLockManager().isProjectLocked(projectPath);
}

/**
 * Acquire a project-level lock for serializing squash merge operations.
 * Returns a release closure if the lock was acquired.
 * Throws immediately if a lock is already held for this project.
 */
export function acquireProjectLock(projectPath: string): () => void {
  return getDefaultLockManager().acquireProjectLock(projectPath);
}

/** Check whether a session currently has a running prompt */
export function isSessionBusy(
  projectPath: string,
  sessionName: string,
): boolean {
  return getDefaultLockManager().isSessionBusy(projectPath, sessionName);
}

/**
 * Acquire a single-flight lock for a session.
 * Returns a release function if the lock was acquired.
 * Throws if the session is already busy.
 */
export function acquireSessionLock(
  projectPath: string,
  sessionName: string,
): () => void {
  return getDefaultLockManager().acquireSessionLock(projectPath, sessionName);
}

/**
 * Force-release a session lock (for recovery of orphaned locks).
 * Returns true if a lock was released, false if none was held.
 */
export function forceReleaseSessionLock(
  projectPath: string,
  sessionName: string,
): boolean {
  return getDefaultLockManager().forceReleaseSessionLock(
    projectPath,
    sessionName,
  );
}

/** List all currently held session locks (for diagnostics). */
export function getHeldSessionLocks(): Array<{
  projectPath: string;
  sessionName: string;
}> {
  return getDefaultLockManager().getHeldSessionLocks();
}

/** Check whether a specific conversation currently has a running prompt. */
export function isConversationBusy(
  projectPath: string,
  storeSessionName: string,
  conversationId: string,
): boolean {
  return getDefaultLockManager().isConversationBusy(
    projectPath,
    storeSessionName,
    conversationId,
  );
}

/**
 * Acquire a single-flight lock for a conversation.
 * Returns a release function if the lock was acquired.
 * Throws if the conversation is already running a prompt.
 *
 * Multiple conversations within the same session may hold their locks
 * simultaneously — concurrency is restricted only at the conversation level.
 *
 * `storeSessionName` is the session-keyed storage name (the project sentinel for
 * a project conversation); it keys the lock and is never logged.
 */
export function acquireConversationLock(
  projectPath: string,
  storeSessionName: string,
  conversationId: string,
): () => void {
  return getDefaultLockManager().acquireConversationLock(
    projectPath,
    storeSessionName,
    conversationId,
  );
}
