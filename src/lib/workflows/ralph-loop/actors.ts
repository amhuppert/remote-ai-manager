/**
 * Ralph Loop XState actors (fromPromise wrappers).
 *
 * Each actor wraps an async operation that the machine invokes:
 *   - generatePlan: Runs SDK query to produce a task plan
 *   - runIteration: Executes a single iteration of the Ralph Loop
 *
 * The real implementations call into existing modules (plan-generator,
 * orchestrator). In tests, these are replaced via machine.provide().
 */

import { fromPromise } from "xstate";
import type {
  GeneratePlanInput,
  GeneratePlanOutput,
  RunIterationInput,
  RunIterationOutput,
} from "./types";

// ============================================================
// Plan Generation Actor
// ============================================================

/**
 * Generate a task plan for the workflow objective.
 *
 * Wraps the plan generation logic from plan-generator.ts:
 * - Reads session context (recent conversation transcripts)
 * - Runs SDK query with submit_plan MCP tool
 * - Returns structured tasks
 *
 * In production, the real implementation is provided via machine.provide().
 * The default implementation is a no-op placeholder that tests override.
 */
export const generatePlanActor = fromPromise<
  GeneratePlanOutput,
  GeneratePlanInput
>(async ({ input }) => {
  // Default placeholder — overridden via .provide() in production and tests.
  // This import pattern avoids circular dependencies at module load time.
  const { generatePlanForMachine } = await import("./actor-implementations");
  return generatePlanForMachine(input);
});

// ============================================================
// Iteration Execution Actor
// ============================================================

/**
 * Execute a single Ralph Loop iteration.
 *
 * Wraps the iteration lifecycle from orchestrator.ts:
 * - Create managed conversation
 * - Capture pre-iteration git snapshot
 * - Build prompt from objective + fix plan
 * - Set up MCP tools (status report, fix plan update)
 * - Execute SDK query
 * - Capture post-iteration git diff
 * - Classify progress
 * - Process circuit breaker
 *
 * Returns iteration metadata plus updated workflow state.
 *
 * In production, the real implementation is provided via machine.provide().
 */
export const runIterationActor = fromPromise<
  RunIterationOutput,
  RunIterationInput
>(async ({ input }) => {
  // Default placeholder — overridden via .provide() in production and tests.
  const { runIterationForMachine } = await import("./actor-implementations");
  return runIterationForMachine(input);
});
