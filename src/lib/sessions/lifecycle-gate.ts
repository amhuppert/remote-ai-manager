import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { createLogger } from "@/lib/logging";

const logger = createLogger("sessions.lifecycle-gate");

type Release = () => void;

export interface SessionLifecycleOperationContext {
  projectDeletionPrecededOperation: boolean;
}

interface KeyState {
  tail: Promise<void>;
  pending: number;
}

interface ProjectWaiter {
  kind: "operation" | "deletion";
  projectDeletionPrecededOperation: boolean;
  resolve(
    acquisition: SessionLifecycleOperationContext & { release: Release },
  ): void;
}

interface ProjectState {
  activeOperations: number;
  deletionActive: boolean;
  waiters: ProjectWaiter[];
}

export interface SessionLifecycleGate {
  runExclusive<T>(
    projectPath: string,
    sessionName: string,
    operation: (context: SessionLifecycleOperationContext) => Promise<T>,
  ): Promise<T>;
  runExclusiveMany<T>(
    projectPath: string,
    sessionNames: Iterable<string>,
    operation: (context: SessionLifecycleOperationContext) => Promise<T>,
  ): Promise<T>;
  runProjectDeletion<T>(
    projectPath: string,
    deletion: () => Promise<T>,
  ): Promise<T>;
}

export function createSessionLifecycleGate(): SessionLifecycleGate {
  const states = new Map<string, KeyState>();
  const projectStates = new Map<string, ProjectState>();

  function keyFor(projectPath: string, sessionName: string): string {
    return JSON.stringify([projectPath, sessionName]);
  }

  async function acquire(key: string): Promise<Release> {
    let state = states.get(key);
    if (state === undefined) {
      state = { tail: Promise.resolve(), pending: 0 };
      states.set(key, state);
    }

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const predecessor = state.tail;
    state.tail = gate;
    state.pending += 1;
    await predecessor;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.pending -= 1;
      releaseGate();
      if (state.pending === 0 && states.get(key) === state) {
        states.delete(key);
      }
    };
  }

  function projectStateFor(projectPath: string): ProjectState {
    let state = projectStates.get(projectPath);
    if (state === undefined) {
      state = { activeOperations: 0, deletionActive: false, waiters: [] };
      projectStates.set(projectPath, state);
    }
    return state;
  }

  function removeIdleProjectState(
    projectPath: string,
    state: ProjectState,
  ): void {
    if (
      state.activeOperations === 0 &&
      !state.deletionActive &&
      state.waiters.length === 0 &&
      projectStates.get(projectPath) === state
    ) {
      projectStates.delete(projectPath);
    }
  }

  function drainProject(projectPath: string, state: ProjectState): void {
    if (state.deletionActive) return;

    if (state.activeOperations === 0 && state.waiters[0]?.kind === "deletion") {
      const waiter = state.waiters.shift()!;
      state.deletionActive = true;
      let released = false;
      waiter.resolve({
        projectDeletionPrecededOperation: false,
        release: () => {
          if (released) return;
          released = true;
          state.deletionActive = false;
          drainProject(projectPath, state);
        },
      });
      return;
    }

    while (state.waiters[0]?.kind === "operation") {
      const waiter = state.waiters.shift()!;
      state.activeOperations += 1;
      let released = false;
      waiter.resolve({
        projectDeletionPrecededOperation:
          waiter.projectDeletionPrecededOperation,
        release: () => {
          if (released) return;
          released = true;
          state.activeOperations -= 1;
          drainProject(projectPath, state);
        },
      });
    }

    removeIdleProjectState(projectPath, state);
  }

  function acquireProject(
    projectPath: string,
    kind: "operation" | "deletion",
  ): Promise<SessionLifecycleOperationContext & { release: Release }> {
    const state = projectStateFor(projectPath);
    return new Promise((resolve) => {
      state.waiters.push({
        kind,
        projectDeletionPrecededOperation:
          kind === "operation" &&
          (state.deletionActive ||
            state.waiters.some((waiter) => waiter.kind === "deletion")),
        resolve,
      });
      drainProject(projectPath, state);
    });
  }

  async function runWithKeys<T>(
    projectPath: string,
    sessionNames: string[],
    keys: string[],
    operation: (context: SessionLifecycleOperationContext) => Promise<T>,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    const releases: Release[] = [];
    const projectAcquisition = await acquireProject(projectPath, "operation");
    let acquiredAt = enqueuedAt;
    try {
      for (const key of keys) {
        releases.push(await acquire(key));
      }
      acquiredAt = performance.now();
      return await operation({
        projectDeletionPrecededOperation:
          projectAcquisition.projectDeletionPrecededOperation,
      });
    } finally {
      for (let index = releases.length - 1; index >= 0; index -= 1) {
        releases[index]!();
      }
      projectAcquisition.release();
      const releasedAt = performance.now();
      logger.info("session.lifecycle_gate.timing", {
        projectPath,
        sessionName: sessionNames.length === 1 ? sessionNames[0] : undefined,
        sessionCount: sessionNames.length,
        durationMs: +(releasedAt - enqueuedAt).toFixed(2),
        waitMs: +(acquiredAt - enqueuedAt).toFixed(2),
        holdMs: +(releasedAt - acquiredAt).toFixed(2),
      });
    }
  }

  return {
    runExclusive(projectPath, sessionName, operation) {
      return runWithKeys(
        projectPath,
        [sessionName],
        [keyFor(projectPath, sessionName)],
        operation,
      );
    },
    runExclusiveMany(projectPath, sessionNames, operation) {
      const normalizedSessionNames = Array.from(new Set(sessionNames)).sort();
      const keys = normalizedSessionNames.map((sessionName) =>
        keyFor(projectPath, sessionName),
      );
      return runWithKeys(projectPath, normalizedSessionNames, keys, operation);
    },
    async runProjectDeletion(projectPath, deletion) {
      const enqueuedAt = performance.now();
      const acquisition = await acquireProject(projectPath, "deletion");
      const acquiredAt = performance.now();
      try {
        return await deletion();
      } finally {
        acquisition.release();
        const releasedAt = performance.now();
        logger.info("session.lifecycle_project_deletion.timing", {
          projectPath,
          durationMs: +(releasedAt - enqueuedAt).toFixed(2),
          waitMs: +(acquiredAt - enqueuedAt).toFixed(2),
          holdMs: +(releasedAt - acquiredAt).toFixed(2),
        });
      }
    },
  };
}

export function getSessionLifecycleGate(): SessionLifecycleGate {
  return getGlobalSingleton("__cc_session_lifecycle_gate", () =>
    createSessionLifecycleGate(),
  );
}
