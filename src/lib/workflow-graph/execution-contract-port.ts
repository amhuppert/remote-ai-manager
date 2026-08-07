import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import type { CriterionContextCoverage } from "@/lib/workflow-graph/criterion-coverage";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";

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

export interface GraphExecutionContract {
  validateDefinition(
    definition: GraphExecutionContractDefinition,
  ): GraphExecutionContractDecision;
  validateLiveEdit(
    execution: GraphWorkflowExecution,
    operation: WorkflowLiveEditOperation,
  ): GraphExecutionContractDecision;
  validateTaskCompletion(
    execution: GraphWorkflowExecution,
    taskId: string,
  ): GraphExecutionContractDecision;
  deriveContextAcceptanceCriteria(
    definition: GraphExecutionContractDefinition,
  ): GraphExecutionContractDerivation;
  /**
   * Which contexts cover each linked acceptance criterion (D4 R5.2, decision
   * D11). The engine holds no notion of a criterion, so the criterion-protection
   * lock on the live-edit frontier reads coverage through this seam; an
   * execution with no registered consumer — or one that is not spec-linked —
   * derives an empty map and is never route-locked.
   */
  deriveCriterionContextCoverage(
    definition: GraphExecutionContractDefinition,
  ): CriterionContextCoverage;
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
    validateLiveEdit(execution, operation) {
      return (
        state().contract?.validateLiveEdit(execution, operation) ?? { ok: true }
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
    deriveCriterionContextCoverage(definition) {
      return state().contract?.deriveCriterionContextCoverage(definition) ?? {};
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
