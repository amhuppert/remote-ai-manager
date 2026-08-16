import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import type { AuthoredAccountabilityCoverageGroup } from "@/lib/workflow-graph/authored-accountability-coverage-core";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { GraphRolePromptProjection } from "./prompt-composer";

const EXECUTION_CONTRACT_PORT_KEY =
  "__cc_graph_execution_contract_port" as const;

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
  loadPromptProjection?(
    execution: GraphWorkflowExecution,
  ): Promise<GraphRolePromptProjection | null>;
}

interface GraphExecutionContractPortState {
  contract: GraphExecutionContract | null;
}

function state(): GraphExecutionContractPortState {
  return getGlobalSingleton(EXECUTION_CONTRACT_PORT_KEY, () => ({
    contract: null,
  }));
}

export function registerGraphExecutionContract(
  contract: GraphExecutionContract,
): void {
  state().contract = contract;
}

export function createRegisteredGraphExecutionContract(): GraphExecutionContract {
  return {
    validateDefinition(definition) {
      return state().contract?.validateDefinition(definition) ?? { ok: true };
    },
    loadLiveEdit(execution) {
      return (
        state().contract?.loadLiveEdit(execution) ?? {
          validateOperation: () => ({ ok: true }),
          accountabilityCoverageGroups: [],
        }
      );
    },
    validateTaskCompletion(execution, taskId) {
      return (
        state().contract?.validateTaskCompletion(execution, taskId) ?? {
          ok: true,
        }
      );
    },
    deriveContextAcceptanceCriteria(definition) {
      return (
        state().contract?.deriveContextAcceptanceCriteria(definition) ?? {
          ok: true,
          acceptanceCriteriaByContextId: {},
        }
      );
    },
    async loadPromptProjection(execution) {
      return (
        (await state().contract?.loadPromptProjection?.(execution)) ?? null
      );
    },
  };
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

export function resetGraphExecutionContractForTesting(): void {
  state().contract = null;
}
