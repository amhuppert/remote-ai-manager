/**
 * Production actor implementations for the Ralph Loop XState machine.
 *
 * These wrap the existing modules from src/lib/ralph-loop/ to be used as
 * fromPromise actors. Lazily imported to avoid circular dependencies.
 */

import type { GeneratePlanInput, GeneratePlanOutput } from "./types";
import type { RunIterationInput, RunIterationOutput } from "./types";
import { workflowKey, getRuntime } from "../runtime-state";

/**
 * Production plan generation implementation.
 * Wraps plan-generator.ts logic for use as an XState actor.
 *
 * Note: In the current integration, plan generation during the planning
 * phase is still handled by the existing dispatchPlanGeneration() fire-and-forget
 * function. This actor is invoked by the machine if GENERATE_PLAN is sent
 * while a live actor exists.
 */
export async function generatePlanForMachine(
  input: GeneratePlanInput,
): Promise<GeneratePlanOutput> {
  const { generatePlanTasks } = await import("@/lib/ralph-loop/plan-generator");

  const tasks = await generatePlanTasks({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    objective: input.objective,
  });

  return { tasks };
}

/**
 * Production iteration execution implementation.
 * Wraps orchestrator.ts iteration logic for use as an XState actor.
 *
 * Reads the current session state from the state file, runs the iteration
 * using the existing runIteration function, persists results, and returns
 * the updated state for the machine to assign to context.
 */
export async function runIterationForMachine(
  input: RunIterationInput,
): Promise<RunIterationOutput> {
  const { getSession } = await import("@/lib/state");
  const { runIteration, persistIterationResults } =
    await import("@/lib/ralph-loop/orchestrator");

  // Get runtime state for abort controller
  const key = workflowKey(input.projectPath, input.sessionName);
  const runtime = getRuntime(key);
  if (!runtime) {
    throw new Error(
      `No runtime state registered for workflow ${key}. Was the workflow started via the workflow manager?`,
    );
  }

  // Get session state (needed by runIteration for conversation creation)
  const session = await getSession(input.projectPath, input.sessionName);
  if (!session) {
    throw new Error(
      `Session not found: ${input.projectPath}/${input.sessionName}`,
    );
  }
  if (!session.workflow) {
    throw new Error(
      `No workflow on session: ${input.projectPath}/${input.sessionName}`,
    );
  }

  // Run the iteration using existing orchestrator logic
  const iterationMeta = await runIteration({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    projectName: input.projectName,
    session,
    workflow: session.workflow,
    iterationNumber: input.iterationNumber,
    abortController: runtime.abortController,
  });

  // Persist iteration results to state file (updates iterations, circuit breaker)
  // Also broadcasts workflow-iteration-complete and workflow-circuit-breaker SSE events
  await persistIterationResults(
    input.projectPath,
    input.sessionName,
    input.projectName,
    iterationMeta,
  );

  // Read final state after persistence to get updated fix plan and circuit breaker
  const finalSession = await getSession(input.projectPath, input.sessionName);
  const finalWorkflow = finalSession?.workflow;

  return {
    iteration: iterationMeta,
    updatedFixPlan: finalWorkflow?.fixPlan ?? input.fixPlan,
    updatedCircuitBreaker: finalWorkflow?.circuitBreaker ?? {
      state: "closed",
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
  };
}
