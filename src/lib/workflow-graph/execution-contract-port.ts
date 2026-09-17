import type { AuthoredAccountabilityCoverageGroup } from "@/lib/workflow-graph/authored-accountability-coverage-core";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { GraphRolePromptProjection } from "./prompt-composer";

export type GraphExecutionContractDecision =
  | { ok: true }
  | {
      ok: false;
      code: string;
      issues: WorkflowGraphValidationError[];
      instruction: string;
    };

export type GraphExecutionContractDerivation =
  | {
      ok: true;
      acceptanceCriteriaByContextId: Record<string, string>;
    }
  | Exclude<GraphExecutionContractDecision, { ok: true }>;

export type GraphExecutionContractDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

/**
 * The execution-scoped contract value consumed by the pure live-edit core.
 * Persistence-backed authority is resolved before this value is created, so
 * edit and frontier evaluation cannot perform repository lookups or bypass a
 * failed binding read.
 */
export interface LoadedGraphExecutionLiveEditContract {
  validateOperation(
    execution: GraphWorkflowExecution,
    operation: WorkflowLiveEditOperation,
  ): GraphExecutionContractDecision;
  readonly accountabilityCoverageGroups: readonly AuthoredAccountabilityCoverageGroup[];
}

export interface GraphExecutionContract {
  validateDefinition(
    definition: GraphExecutionContractDefinition,
  ): GraphExecutionContractDecision;
  loadLiveEdit(
    execution: GraphWorkflowExecution,
  ): LoadedGraphExecutionLiveEditContract;
  validateTaskCompletion(
    execution: GraphWorkflowExecution,
    taskId: string,
  ): GraphExecutionContractDecision;
  deriveContextAcceptanceCriteria(
    definition: GraphExecutionContractDefinition,
  ): GraphExecutionContractDerivation;
  loadPromptProjection(
    execution: GraphWorkflowExecution,
    contextId?: string,
  ): Promise<GraphRolePromptProjection | null>;
}

export class GraphExecutionContractViolationError extends Error {
  readonly code: string;
  readonly issues: WorkflowGraphValidationError[];
  readonly instruction: string;

  constructor(refusal: Exclude<GraphExecutionContractDecision, { ok: true }>) {
    super(refusal.issues.map((issue) => issue.message).join(" "));
    this.name = "GraphExecutionContractViolationError";
    this.code = refusal.code;
    this.issues = refusal.issues;
    this.instruction = refusal.instruction;
  }
}

export function assertGraphExecutionContractAccepted(
  decision: GraphExecutionContractDecision,
): asserts decision is { ok: true } {
  if (!decision.ok) {
    throw new GraphExecutionContractViolationError(decision);
  }
}
