import {
  type GraphWorkflowExecution,
  type GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";

import { type ResumeUserInputContext } from "@/lib/workflow-graph/user-input-gate";

import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { ToolResultBlock } from "./tool-dispatcher";

export type ContextDecision =
  | {
      kind: "continue";
      reason:
        | "tasks_remaining"
        | "output_capture_retry"
        | "recertification_required";
    }
  | { kind: "await_approval" }
  | { kind: "await_user_input" }
  | { kind: "deliver_validator_answers"; laneKeys: string[] }
  | { kind: "await_collaboration"; workflowId: string }
  | { kind: "yield"; reason: "rescheduled" | "superseded" }
  | { kind: "halted"; haltReason: GraphWorkflowHaltReason }
  | { kind: "execution_stopped" }
  | { kind: "ready_to_land" };

export interface GraphWorkflowIterationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  contextId: string;
  /**
   * Resolved per-context execution target supplied by the loop's
   * ExecutionTargetResolver. When omitted (e.g., legacy callers), the
   * orchestrator threads `undefined` through and the implementer runner falls
   * back to the session worktree/branch.
   */
  executionTarget?: ExecutionTarget;
  /**
   * Set when the loop resumes a context after its parked questions were
   * answered. Each entry names the lane that asked: the asking conversation is
   * pinned (rotation still outranks) and the answers block is embedded in that
   * lane's resumed prompt — the follow-up (pinned) or seed (rotated)
   * implementer prompt, or the asking validator's prompt (5.1, 5.3, 5.5).
   *
   * A list because a cohort's validators park independently and may be answered
   * together; each lane sees only its own answers.
   */
  resumeUserInputs?: readonly ResumeUserInputContext[];
  signal?: AbortSignal;
}

export interface GraphWorkflowIterationResult {
  conversationId: string;
  execution: GraphWorkflowExecution;
  decision: ContextDecision;
}

export class IterationHaltedError extends Error {
  readonly haltReason: GraphWorkflowHaltReason;
  readonly syntheticToolResults?: readonly ToolResultBlock[];
  constructor(
    haltReason: GraphWorkflowHaltReason,
    syntheticToolResults?: readonly ToolResultBlock[],
  ) {
    super(`Iteration halted: ${haltReason.type}`);
    this.name = "IterationHaltedError";
    this.haltReason = haltReason;
    if (syntheticToolResults && syntheticToolResults.length > 0) {
      this.syntheticToolResults = syntheticToolResults;
    }
  }
}

export interface GraphWorkflowSignalHaltInput {
  projectPath: string;
  sessionName: string;
  contextId?: string;
  reason: GraphWorkflowHaltReason;
}
