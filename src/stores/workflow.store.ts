import { useMemo } from "react";
import { enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

enableMapSet();
import type {
  WorkflowStatus,
  FixPlanTask,
  CircuitBreakerState,
  HaltReason,
  RalphLoopIterationMeta,
  WorkflowStatusEvent,
  WorkflowIterationCompleteEvent,
  WorkflowFixPlanUpdatedEvent,
  WorkflowCircuitBreakerEvent,
} from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight summary of a workflow tracked via SSE events. */
export interface TrackedWorkflow {
  projectName: string;
  sessionName: string;
  status: WorkflowStatus;
  iterationCount: number;
  maxIterations: number;
  taskProgress: {
    total: number;
    completed: number;
    skipped: number;
    pending: number;
  };
  haltReason: HaltReason | null;
  /** Latest fix plan from SSE. */
  fixPlan: FixPlanTask[] | null;
  /** Latest circuit breaker state from SSE. */
  circuitBreaker: CircuitBreakerState | null;
  /** Latest iteration from SSE. */
  latestIteration: RalphLoopIterationMeta | null;
  updatedAt: string;
}

interface WorkflowStoreState {
  /** Tracked workflows keyed by "projectName::sessionName". */
  workflows: Map<string, TrackedWorkflow>;
  /** Toast queue for terminal workflow events. */
  toastQueue: Array<{
    projectName: string;
    sessionName: string;
    status: WorkflowStatus;
    haltReason: HaltReason | null;
  }>;
}

interface WorkflowStoreActions {
  handleStatusEvent: (event: WorkflowStatusEvent) => void;
  handleIterationComplete: (event: WorkflowIterationCompleteEvent) => void;
  handleFixPlanUpdated: (event: WorkflowFixPlanUpdatedEvent) => void;
  handleCircuitBreaker: (event: WorkflowCircuitBreakerEvent) => void;
  dismissToast: () => void;
}

type WorkflowStore = WorkflowStoreState & WorkflowStoreActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(projectName: string, sessionName: string): string {
  return `${projectName}::${sessionName}`;
}

const TERMINAL_STATUSES: WorkflowStatus[] = ["completed", "halted", "aborted"];

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useWorkflowStore = create<WorkflowStore>()(
  immer((set) => ({
    workflows: new Map<string, TrackedWorkflow>(),
    toastQueue: [],

    handleStatusEvent: (event) =>
      set((state) => {
        const key = makeKey(event.projectName, event.sessionName);
        const existing = state.workflows.get(key);
        const now = new Date().toISOString();

        const tracked: TrackedWorkflow = {
          projectName: event.projectName,
          sessionName: event.sessionName,
          status: event.workflowStatus,
          iterationCount: event.iterationCount,
          maxIterations: event.maxIterations,
          taskProgress: event.taskProgress,
          haltReason: event.haltReason,
          fixPlan: existing?.fixPlan ?? null,
          circuitBreaker: existing?.circuitBreaker ?? null,
          latestIteration: existing?.latestIteration ?? null,
          updatedAt: now,
        };

        state.workflows.set(key, tracked);

        // Push terminal events to toast queue
        if (TERMINAL_STATUSES.includes(event.workflowStatus)) {
          state.toastQueue.push({
            projectName: event.projectName,
            sessionName: event.sessionName,
            status: event.workflowStatus,
            haltReason: event.haltReason,
          });
        }
      }),

    handleIterationComplete: (event) =>
      set((state) => {
        const key = makeKey(event.projectName, event.sessionName);
        const existing = state.workflows.get(key);
        if (existing) {
          existing.latestIteration = event.iteration;
          existing.iterationCount = event.iteration.iterationNumber;
          existing.updatedAt = new Date().toISOString();
        }
      }),

    handleFixPlanUpdated: (event) =>
      set((state) => {
        const key = makeKey(event.projectName, event.sessionName);
        const existing = state.workflows.get(key);
        if (existing) {
          existing.fixPlan = event.fixPlan;
          existing.updatedAt = new Date().toISOString();
        }
      }),

    handleCircuitBreaker: (event) =>
      set((state) => {
        const key = makeKey(event.projectName, event.sessionName);
        const existing = state.workflows.get(key);
        if (existing) {
          existing.circuitBreaker = event.circuitBreaker;
          existing.updatedAt = new Date().toISOString();
        }
      }),

    dismissToast: () =>
      set((state) => {
        state.toastQueue.shift();
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useActiveWorkflows = () => {
  const workflows = useWorkflowStore((s) => s.workflows);
  return useMemo(
    () =>
      Array.from(workflows.values()).filter(
        (w) => w.status === "running" || w.status === "paused",
      ),
    [workflows],
  );
};

export const useWorkflowBySession = (
  projectName: string,
  sessionName: string,
) => {
  const workflows = useWorkflowStore((s) => s.workflows);
  return workflows.get(makeKey(projectName, sessionName)) ?? null;
};

export const useWorkflowToastQueue = () =>
  useWorkflowStore((s) => s.toastQueue);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useHandleWorkflowStatusEvent = () =>
  useWorkflowStore((s) => s.handleStatusEvent);
export const useHandleWorkflowIterationComplete = () =>
  useWorkflowStore((s) => s.handleIterationComplete);
export const useHandleWorkflowFixPlanUpdated = () =>
  useWorkflowStore((s) => s.handleFixPlanUpdated);
export const useHandleWorkflowCircuitBreaker = () =>
  useWorkflowStore((s) => s.handleCircuitBreaker);
export const useDismissWorkflowToast = () =>
  useWorkflowStore((s) => s.dismissToast);

/** @internal — exposed for direct state testing */
export { useWorkflowStore as _useWorkflowStore };
