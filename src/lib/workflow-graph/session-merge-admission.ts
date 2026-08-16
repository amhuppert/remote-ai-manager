/**
 * The advisory half of the delivery gate: whether a session merge may START.
 *
 * The authoritative refusal lives in the publish actor, under the project lock
 * — but a merge surface that only learns the answer there has already paid for
 * conflict resolution, validation, and (for agent-driven surfaces) a generation
 * turn. Every surface that dispatches a session merge asks here first, and all
 * of them refuse with one code, one remedy, and one sentence.
 */

import { getActiveGraphWorkflowExecution } from "@/lib/state-store";
import { createLogger } from "@/lib/logging";
import { evaluateGraphWorkflowSessionDelivery } from "./lifecycle-classifier";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLeaseRemedy,
} from "./schemas";

const logger = createLogger("merge-admission");

/** The execution facts the lease question is decided from. */
export type SessionDeliveryExecution = Pick<
  GraphWorkflowExecution,
  "id" | "status" | "haltReason" | "abandonment" | "definitionApproval"
>;

export type ReadActiveSessionDeliveryExecution = (
  projectPath: string,
  sessionName: string,
) => Promise<SessionDeliveryExecution | null>;

/** Which merge surface asked, for log attribution only. */
export type SessionMergeSurface =
  | "merge-route"
  | "merge-command"
  | "optimistic";

export interface SessionMergeRefusal {
  code: "GRAPH_WORKFLOW_ACTIVE";
  executionId: string;
  status: GraphWorkflowExecution["status"];
  /** The act that clears the block, machine-readable beside the sentence. */
  remedy: GraphWorkflowLeaseRemedy;
  message: string;
}

export type SessionMergeAdmission =
  | { admitted: true }
  | { admitted: false; refusal: SessionMergeRefusal };

export async function evaluateSessionMergeAdmission(input: {
  projectPath: string;
  sessionName: string;
  surface: SessionMergeSurface;
  readActiveExecution?: ReadActiveSessionDeliveryExecution;
}): Promise<SessionMergeAdmission> {
  const readActiveExecution =
    input.readActiveExecution ?? getActiveGraphWorkflowExecution;
  const decision = evaluateGraphWorkflowSessionDelivery(
    await readActiveExecution(input.projectPath, input.sessionName),
  );
  if (decision.allowed) return { admitted: true };

  logger.warn("merge.active_graph_workflow_refused", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    surface: input.surface,
    executionId: decision.executionId,
    workflowStatus: decision.status,
    remedy: decision.remedy,
  });
  return {
    admitted: false,
    refusal: {
      code: "GRAPH_WORKFLOW_ACTIVE",
      executionId: decision.executionId,
      status: decision.status,
      remedy: decision.remedy,
      message: decision.message,
    },
  };
}
