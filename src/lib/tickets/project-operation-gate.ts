import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { createLogger } from "@/lib/logging";

const logger = createLogger("tickets.project-gate");

type GateKind = "ticket" | "project_deletion";
type Release = () => void;

export interface TicketProjectOperationContext {
  /** True when this operation had to wait for a project deletion ahead of it. */
  projectDeletionPrecededOperation: boolean;
}

interface Acquisition extends TicketProjectOperationContext {
  release: Release;
}

interface Waiter {
  kind: GateKind;
  projectDeletionPrecededOperation: boolean;
  resolve(acquisition: Acquisition): void;
}

interface ProjectGateState {
  activeTicketOperations: number;
  deletionActive: boolean;
  waiters: Waiter[];
}

export interface TicketProjectOperationGate {
  /** Ticket work may overlap with other ticket work in the same project. */
  runTicketOperation<T>(
    projectPath: string,
    operation: (context: TicketProjectOperationContext) => Promise<T>,
  ): Promise<T>;
  /** Project deletion waits for prior ticket work and excludes later work. */
  runProjectDeletion<T>(
    projectPath: string,
    deletion: () => Promise<T>,
  ): Promise<T>;
}

export function createTicketProjectOperationGate(): TicketProjectOperationGate {
  const states = new Map<string, ProjectGateState>();

  function stateFor(projectPath: string): ProjectGateState {
    let state = states.get(projectPath);
    if (state === undefined) {
      state = {
        activeTicketOperations: 0,
        deletionActive: false,
        waiters: [],
      };
      states.set(projectPath, state);
    }
    return state;
  }

  function removeIdleState(projectPath: string, state: ProjectGateState): void {
    if (
      state.activeTicketOperations === 0 &&
      !state.deletionActive &&
      state.waiters.length === 0 &&
      states.get(projectPath) === state
    ) {
      states.delete(projectPath);
    }
  }

  function drain(projectPath: string, state: ProjectGateState): void {
    if (state.deletionActive) return;

    if (state.activeTicketOperations === 0) {
      const first = state.waiters[0];
      if (first?.kind === "project_deletion") {
        state.waiters.shift();
        state.deletionActive = true;
        let released = false;
        first.resolve({
          projectDeletionPrecededOperation: false,
          release: () => {
            if (released) return;
            released = true;
            state.deletionActive = false;
            drain(projectPath, state);
          },
        });
        return;
      }
    }

    while (state.waiters[0]?.kind === "ticket") {
      const waiter = state.waiters.shift();
      if (waiter === undefined) break;
      state.activeTicketOperations += 1;
      let released = false;
      waiter.resolve({
        projectDeletionPrecededOperation:
          waiter.projectDeletionPrecededOperation,
        release: () => {
          if (released) return;
          released = true;
          state.activeTicketOperations -= 1;
          drain(projectPath, state);
        },
      });
    }

    removeIdleState(projectPath, state);
  }

  function acquire(projectPath: string, kind: GateKind): Promise<Acquisition> {
    const state = stateFor(projectPath);
    return new Promise((resolve) => {
      state.waiters.push({
        kind,
        projectDeletionPrecededOperation:
          kind === "ticket" &&
          (state.deletionActive ||
            state.waiters.some((waiter) => waiter.kind === "project_deletion")),
        resolve,
      });
      drain(projectPath, state);
    });
  }

  async function runTicket<T>(
    projectPath: string,
    operation: (context: TicketProjectOperationContext) => Promise<T>,
  ): Promise<T> {
    const acquisition = await acquire(projectPath, "ticket");
    try {
      return await operation({
        projectDeletionPrecededOperation:
          acquisition.projectDeletionPrecededOperation,
      });
    } finally {
      acquisition.release();
    }
  }

  return {
    runTicketOperation(projectPath, operation) {
      return runTicket(projectPath, operation);
    },
    async runProjectDeletion(projectPath, deletion) {
      const queuedAt = performance.now();
      logger.debug("project_gate.deletion_queued", { projectPath });
      const acquisition = await acquire(projectPath, "project_deletion");
      const acquiredAt = performance.now();
      logger.info("project_gate.deletion_acquired", {
        projectPath,
        waitMs: Math.round(acquiredAt - queuedAt),
      });
      try {
        return await deletion();
      } finally {
        acquisition.release();
        logger.info("project_gate.deletion_released", {
          projectPath,
          durationMs: Math.round(performance.now() - acquiredAt),
        });
      }
    },
  };
}

export function getTicketProjectOperationGate(): TicketProjectOperationGate {
  return getGlobalSingleton("__cc_ticket_project_operation_gate", () =>
    createTicketProjectOperationGate(),
  );
}
