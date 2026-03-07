/**
 * Shared types for XState workflow machines.
 *
 * All workflow machines extend BaseWorkflowContext for common fields.
 * Non-serializable runtime data (AbortControllers, stream controllers, etc.)
 * is stored in the external runtime-state registry, NOT in machine context.
 */

import type { ActorRefFrom, AnyStateMachine, SnapshotFrom } from "xstate";

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

/**
 * Common fields required as input to create any workflow machine.
 * Workflow-specific inputs extend this with additional fields.
 */
export interface BaseWorkflowInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
}

/**
 * Common fields in the output of any workflow machine.
 * Workflow-specific outputs extend this with additional fields.
 */
export interface BaseWorkflowOutput {
  /** Terminal status of the workflow. */
  status: string;
  /** Error message if the workflow failed (null on success). */
  error: string | null;
}

/**
 * Type utility: extract the actor ref type from a workflow machine.
 * Usage: `WorkflowActorRef<typeof myMachine>`
 */
export type WorkflowActorRef<T extends AnyStateMachine> = ActorRefFrom<T>;

/**
 * Type utility: extract the snapshot type from a workflow machine.
 * Usage: `WorkflowSnapshot<typeof myMachine>`
 */
export type WorkflowSnapshot<T extends AnyStateMachine> = SnapshotFrom<T>;
