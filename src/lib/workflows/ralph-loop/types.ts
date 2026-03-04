/**
 * Types for the Ralph Loop XState machine.
 *
 * Models the full autonomous iteration workflow:
 *   planning → generatingPlan → awaitingConfirmation → running → completed/halted/aborted
 *
 * The running state is a compound state with sub-states:
 *   executingIteration → evaluatingExit → (continue | halt)
 */

import type { BaseWorkflowContext } from "../types";
import type {
  FixPlanTask,
  RalphLoopConfig,
  HaltReason,
  RalphLoopIterationMeta,
  CircuitBreakerState,
} from "@/types";

// ============================================================
// Machine Context
// ============================================================

/** Machine context for the Ralph Loop workflow. */
export interface RalphLoopContext extends BaseWorkflowContext {
  /** The high-level objective for the workflow. */
  objective: string;

  /** Workflow configuration (iteration cap, timeouts, context limits, etc.). */
  config: RalphLoopConfig;

  /** Task plan for the workflow. Updated after each iteration. */
  fixPlan: FixPlanTask[];

  /** History of completed iterations. */
  iterations: RalphLoopIterationMeta[];

  /** Circuit breaker state for detecting stalled iterations. */
  circuitBreaker: CircuitBreakerState;

  /** Reason the workflow halted (null while active). */
  haltReason: HaltReason | null;

  /** Whether plan generation is in progress. */
  generatingPlan: boolean;

  /** Accumulated cost across all iterations. */
  totalCostUsd: number;

  /** Accumulated duration across all iterations. */
  totalDurationMs: number;

  /** Path to the session worktree (needed by actors). */
  worktreePath: string;

  /** Peak context token usage seen across iterations. */
  peakContextTokens: number;

  /** Last iteration result (set after each iteration for exit evaluation). */
  lastIterationResult: RunIterationOutput | null;
}

// ============================================================
// Machine Input
// ============================================================

/** Input required to create a Ralph Loop workflow actor. */
export interface RalphLoopInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  objective: string;
  config: RalphLoopConfig;
  fixPlan: FixPlanTask[];
  worktreePath: string;
  /** Optional: restore from existing state. */
  circuitBreaker?: CircuitBreakerState;
  iterations?: RalphLoopIterationMeta[];
  totalCostUsd?: number;
  totalDurationMs?: number;
}

// ============================================================
// Machine Events
// ============================================================

export type RalphLoopEvent =
  | { type: "GENERATE_PLAN" }
  | { type: "PLAN_GENERATED"; tasks: FixPlanTask[] }
  | { type: "PLAN_GENERATION_FAILED"; error: string }
  | { type: "CONFIRM_PLAN" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "ABORT" };

// ============================================================
// Machine Output
// ============================================================

/** Output produced when the machine reaches a terminal state. */
export interface RalphLoopOutput {
  status: "completed" | "halted" | "aborted";
  haltReason: HaltReason | null;
  iterations: RalphLoopIterationMeta[];
  totalCostUsd: number;
  totalDurationMs: number;
}

// ============================================================
// Actor I/O Types
// ============================================================

/** Input for the plan generation actor. */
export interface GeneratePlanInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  objective: string;
  existingFixPlan: FixPlanTask[];
}

/** Output from the plan generation actor. */
export interface GeneratePlanOutput {
  tasks: FixPlanTask[];
}

/** Input for the iteration execution actor. */
export interface RunIterationInput {
  projectPath: string;
  sessionName: string;
  projectName: string;
  worktreePath: string;
  objective: string;
  fixPlan: FixPlanTask[];
  config: RalphLoopConfig;
  iterationNumber: number;
  previousIterations: RalphLoopIterationMeta[];
}

/** Output from the iteration execution actor. */
export interface RunIterationOutput {
  /** Metadata for the completed iteration. */
  iteration: RalphLoopIterationMeta;
  /** Updated fix plan (may have been mutated during iteration via MCP tools). */
  updatedFixPlan: FixPlanTask[];
  /** Updated circuit breaker state after processing the iteration. */
  updatedCircuitBreaker: CircuitBreakerState;
}
