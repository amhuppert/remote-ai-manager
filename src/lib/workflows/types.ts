/**
 * Shared types for XState workflow machines.
 *
 * All workflow machines extend BaseWorkflowContext for common fields.
 * Non-serializable runtime data (AbortControllers, stream controllers, etc.)
 * is stored in the external runtime-state registry, NOT in machine context.
 */

/** Common context fields shared by all workflow machines. */
export interface BaseWorkflowContext {
  /** Schema version for snapshot migration (bump when context shape changes). */
  _schemaVersion: number;

  /** Absolute path to the project root. */
  projectPath: string;

  /** Human-friendly project name (derived from path). */
  projectName: string;

  /** Session name within the project. */
  sessionName: string;

  /** ISO 8601 timestamp when the workflow started. */
  startedAt: string;

  /** ISO 8601 timestamp when the workflow reached a terminal state (null while active). */
  completedAt: string | null;
}

/** Shared events that any workflow machine may handle. */
export type BaseWorkflowEvent = { type: "ABORT" };
