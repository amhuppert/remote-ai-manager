/**
 * Ralph Loop XState workflow manager.
 *
 * Manages the lifecycle of Ralph Loop XState actors:
 *   - Creates actors with production implementations (.provide())
 *   - Tracks active actors in a globalThis-safe registry
 *   - Handles cleanup on terminal states
 *   - Provides event dispatch for API routes
 *
 * Replaces orchestrator-registry.ts and the startOrchestrator/runLoop
 * functions from orchestrator.ts with XState actor management.
 */

import {
  createActor,
  fromPromise,
  type ActorRefFrom,
  type Snapshot,
} from "xstate";
import { ralphLoopMachine } from "./machine";
import type { RalphLoopInput, RalphLoopEvent } from "./types";
import type { GeneratePlanInput, GeneratePlanOutput } from "./types";
import type { RunIterationInput, RunIterationOutput } from "./types";
import { workflowKey, registerRuntime, cleanupRuntime } from "../runtime-state";
import { persistWorkflowSnapshot } from "../persistence";
import { haltReasonToTerminalStatus } from "@/lib/ralph-loop/exit-detector";
import { createLogger } from "@/lib/logging";
import { dispatchPushForWorkflowStatus } from "@/lib/push-dispatcher";
import type { HaltReason, WorkflowStatus } from "@/types";

const logger = createLogger("ralph-loop-xstate");

type RalphLoopActor = ActorRefFrom<typeof ralphLoopMachine>;

// ============================================================
// Actor Registry (globalThis singleton for HMR safety)
// ============================================================

const GLOBAL_KEY = "__cc_ralph_loop_xstate_actors" as const;

function getActorRegistry(): Map<string, RalphLoopActor> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, RalphLoopActor>();
  }
  return g[GLOBAL_KEY] as Map<string, RalphLoopActor>;
}

// ============================================================
// State Mapping
// ============================================================

function mapStateToWorkflowStatus(
  stateValue: string | Record<string, unknown>,
): WorkflowStatus {
  if (typeof stateValue === "string") {
    switch (stateValue) {
      case "completed":
        return "completed";
      case "halted":
        return "halted";
      case "stopped":
        return "stopped";
      case "planning":
      case "generatingPlan":
      case "awaitingConfirmation":
        return "planning";
      default:
        return "running";
    }
  }
  // Compound state (e.g., { running: "executingIteration" })
  return "running";
}

/**
 * Derive workflow status from context for terminal states.
 *
 * During `always` transition batches (e.g., evaluatingExit → halted),
 * `self.getSnapshot().value` may return the pre-transition compound state
 * instead of the target state. The context's `haltReason` and `completedAt`
 * fields are set by `assign` actions that run during the transition, so
 * they reliably indicate the terminal status.
 */
function deriveWorkflowStatus(
  context: { haltReason: HaltReason | null; completedAt: string | null },
  snapshotValue: string | Record<string, unknown>,
): WorkflowStatus {
  if (context.haltReason) {
    return haltReasonToTerminalStatus(context.haltReason);
  }
  return mapStateToWorkflowStatus(snapshotValue);
}

// ============================================================
// Machine Provider (injects production actors + actions)
// ============================================================

function createProvidedMachine() {
  return ralphLoopMachine.provide({
    actors: {
      generatePlan: fromPromise<GeneratePlanOutput, GeneratePlanInput>(
        async ({ input }) => {
          const { generatePlanForMachine } =
            await import("./actor-implementations");
          return generatePlanForMachine(input);
        },
      ),
      runIteration: fromPromise<RunIterationOutput, RunIterationInput>(
        async ({ input }) => {
          const { runIterationForMachine } =
            await import("./actor-implementations");
          return runIterationForMachine(input);
        },
      ),
    },

    actions: {
      /**
       * Broadcast workflow-status SSE event and sync status to state file.
       * Reads workflow status from the XState machine state.
       */
      broadcastWorkflowStatus: ({ context, self }) => {
        const snapshot = self.getSnapshot();
        const workflowStatus = deriveWorkflowStatus(
          context,
          snapshot.value as string | Record<string, unknown>,
        );

        // Lazy imports to avoid circular dependencies
        void (async () => {
          const { getTaskProgress } =
            await import("@/lib/ralph-loop/fix-plan-manager");
          const { broadcast } = await import("@/lib/sse-broadcaster");
          const { mutateSession } = await import("@/lib/state");

          const progress = getTaskProgress(context.fixPlan);

          // Persist to state file — best-effort, errors logged but don't
          // block the SSE broadcast.
          try {
            await mutateSession(
              context.projectPath,
              context.sessionName,
              "workflow.xstateStatusSync",
              (sess) => {
                if (!sess.workflow) return;
                sess.workflow.status = workflowStatus;
                sess.workflow.haltReason = context.haltReason;
                sess.workflow.completedAt = context.completedAt;
              },
            );
          } catch (err) {
            logger.warn("workflow-manager.status_sync_failed", {
              sessionName: context.sessionName,
              workflowStatus,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Always broadcast SSE — even if state persistence failed,
          // the client needs to know the workflow status changed.
          try {
            broadcast({
              type: "workflow-status",
              projectName: context.projectName,
              sessionName: context.sessionName,
              workflowStatus,
              iterationCount: context.iterations.length,
              maxIterations: context.config.maxIterations,
              taskProgress: {
                total: progress.total,
                completed: progress.completed,
                skipped: progress.skipped,
                pending: progress.pending,
              },
              haltReason: context.haltReason,
            });
          } catch (err) {
            logger.warn("workflow-manager.broadcast_failed", {
              sessionName: context.sessionName,
              workflowStatus,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Push notification to phone for terminal states
          dispatchPushForWorkflowStatus({
            projectName: context.projectName,
            sessionName: context.sessionName,
            workflowStatus,
          });
        })();
      },

      /**
       * Iteration-complete SSE broadcast.
       * No-op here — already handled inside runIterationForMachine
       * via persistIterationResults().
       */
      broadcastIterationComplete: () => {},

      /**
       * Circuit-breaker SSE broadcast.
       * No-op here — already handled inside runIterationForMachine
       * via persistIterationResults().
       */
      broadcastCircuitBreaker: () => {},

      /**
       * Persist XState snapshot for recovery after restart.
       */
      persistSnapshot: ({ context, self }) => {
        try {
          const snapshot = self.getPersistedSnapshot();
          persistWorkflowSnapshot(
            context.projectPath,
            context.sessionName,
            snapshot as Snapshot<unknown>,
          );
        } catch {
          // fire-and-forget — snapshot persistence should not halt the machine
        }
      },
    },
  });
}

// ============================================================
// Public API
// ============================================================

/**
 * Start a new Ralph Loop workflow.
 * Creates an XState actor, registers runtime state, and sends CONFIRM_PLAN
 * to begin execution.
 */
export function startWorkflow(input: RalphLoopInput): void {
  const key = workflowKey(input.projectPath, input.sessionName);

  // Prevent double-start
  if (getActorRegistry().has(key)) {
    logger.warn("workflow-manager.already_running", {
      sessionName: input.sessionName,
    });
    return;
  }

  // Register runtime state (AbortController for cancellation)
  const abortController = new AbortController();
  registerRuntime(key, { abortController });

  const machine = createProvidedMachine();
  const actor = createActor(machine, { input });

  getActorRegistry().set(key, actor);

  // Clean up on terminal state
  actor.subscribe((snapshot) => {
    if (snapshot.status === "done") {
      const terminalStatus =
        snapshot.output?.status === "completed"
          ? ("completed" as const)
          : snapshot.output?.status === "stopped"
            ? ("stopped" as const)
            : ("halted" as const);

      logger.info("workflow-manager.workflow_terminal", {
        sessionName: input.sessionName,
        terminalStatus,
      });
      cleanupRuntime(key);
      getActorRegistry().delete(key);

      // Safety-net: ensure terminal status is persisted to state.json.
      // The entry action's broadcastWorkflowStatus may have raced against
      // this subscriber or failed — this guarantees the state file reflects
      // the terminal status so the UI doesn't show a stale "running".
      void import("@/lib/state")
        .then(({ mutateSession }) =>
          mutateSession(
            input.projectPath,
            input.sessionName,
            "workflow.terminalCleanup",
            (sess) => {
              if (!sess.workflow) return;
              sess.workflow.status = terminalStatus;
              sess.workflow.haltReason = snapshot.output?.haltReason ?? null;
              sess.workflow.completedAt ??= new Date().toISOString();
            },
          ),
        )
        .catch((err) => {
          logger.warn("workflow-manager.terminal_cleanup_failed", {
            sessionName: input.sessionName,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      // Close workflow streams
      void import("@/lib/ralph-loop/workflow-stream-registry").then((ws) => {
        ws.emit(input.projectPath, input.sessionName, {
          type: "done",
          reason:
            snapshot.output?.haltReason?.type ??
            (snapshot.output?.status === "completed"
              ? "plan_complete"
              : "unknown"),
        });
        ws.closeAll(input.projectPath, input.sessionName);
      });
    }
  });

  actor.start();

  // Transition from planning → running by confirming the plan
  actor.send({ type: "CONFIRM_PLAN" });

  logger.info("workflow-manager.workflow_started", {
    sessionName: input.sessionName,
  });
}

/**
 * Resume a stopped or halted workflow.
 *
 * Since stopped/halted are terminal states (no in-memory actor),
 * this always creates a new actor from the preserved state.
 */
export function resumeWorkflow(input: RalphLoopInput): void {
  // Always create a new actor — stopped and halted are terminal states,
  // so no in-memory actor exists. Start fresh with preserved state as input.
  startWorkflow(input);
}

/**
 * Send an event to a running workflow actor.
 * Returns false if no actor exists for the given session.
 */
export function sendEvent(
  projectPath: string,
  sessionName: string,
  event: RalphLoopEvent,
): boolean {
  const actor = getActorRegistry().get(workflowKey(projectPath, sessionName));
  if (!actor) return false;
  actor.send(event);
  return true;
}

/**
 * Check if an active actor exists for the given session.
 */
export function hasActiveWorkflow(
  projectPath: string,
  sessionName: string,
): boolean {
  return getActorRegistry().has(workflowKey(projectPath, sessionName));
}

/**
 * Get the current workflow actor (for diagnostics/testing).
 */
export function getWorkflowActor(
  projectPath: string,
  sessionName: string,
): RalphLoopActor | undefined {
  return getActorRegistry().get(workflowKey(projectPath, sessionName));
}

/** Reset for testing — clears all actors and runtime state. */
export function _resetForTesting(): void {
  for (const actor of getActorRegistry().values()) {
    actor.stop();
  }
  getActorRegistry().clear();
}
