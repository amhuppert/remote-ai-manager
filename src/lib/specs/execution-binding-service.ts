import type {
  LinkedSpecExecutionBindingV2,
  SpecExecutionBindingExpectedIdentity,
  SpecExecutionBindingReader,
} from "./execution-binding";
import type { GraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import type {
  AuthoredAccountabilityCoverageGroup,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/spec-bridge";
import type { SpecRevisionSnapshot } from "./schemas";
import { buildSpecOwnershipProjection } from "./spec-ownership-projection";

/**
 * A consumer can resolve an ordinary unbound graph execution to null, or state
 * the spec identity it expects and receive a fail-closed required lookup.
 */
export interface SpecExecutionBindingPort {
  resolveByWorkflowExecutionId(
    workflowExecutionId: string,
    expected?: SpecExecutionBindingExpectedIdentity,
  ): LinkedSpecExecutionBindingV2 | null;
}

export interface SpecExecutionBindingPorts {
  executionContract: SpecExecutionBindingPort;
  prompts: SpecExecutionBindingPort;
  liveEdits: SpecExecutionBindingPort;
  delivery: SpecExecutionBindingPort;
}

/**
 * Expose only execution-id reads to graph-facing adapters. All four adapters
 * share this one implementation so adding a consumer cannot create another
 * origin-prefix or graph-metadata discriminator.
 */
export function createSpecExecutionBindingPorts(
  reader: SpecExecutionBindingReader,
): SpecExecutionBindingPorts {
  const port: SpecExecutionBindingPort = {
    resolveByWorkflowExecutionId(workflowExecutionId, expected) {
      return expected === undefined
        ? reader.findByWorkflowExecutionId(workflowExecutionId)
        : reader.requireByWorkflowExecutionId(workflowExecutionId, expected);
    },
  };
  return {
    executionContract: port,
    prompts: port,
    liveEdits: port,
    delivery: port,
  };
}

function accountabilityCoverageGroups(
  linked: LinkedSpecExecutionBindingV2 | null,
): AuthoredAccountabilityCoverageGroup[] {
  if (linked === null) return [];
  const claimantIdsByCriterionId = new Map<string, string[]>();
  for (const claim of linked.binding.claims) {
    for (const criterionElementId of claim.criterionElementIds) {
      const contextIds = claimantIdsByCriterionId.get(criterionElementId) ?? [];
      if (!contextIds.includes(claim.contextId)) {
        contextIds.push(claim.contextId);
        claimantIdsByCriterionId.set(criterionElementId, contextIds);
      }
    }
  }
  return linked.binding.dispositions
    .filter((disposition) => disposition.disposition === "in_scope")
    .map((disposition) => ({
      bindingKey: disposition.criterionElementId,
      claimantContextIds: [
        ...(claimantIdsByCriterionId.get(disposition.criterionElementId) ?? []),
      ],
    }));
}

function resolveExecutionBinding(
  port: SpecExecutionBindingPort,
  execution: GraphWorkflowExecution,
): LinkedSpecExecutionBindingV2 | null {
  const linked = port.resolveByWorkflowExecutionId(execution.id);
  if (linked === null) return null;
  if (execution.origin.kind !== "spec_delivery") {
    throw new Error(
      `Workflow execution ${execution.id} has a native-SDD binding but is not a spec-delivery launch`,
    );
  }
  return port.resolveByWorkflowExecutionId(execution.id, {
    candidateId: execution.origin.candidateId,
  });
}

export function createSpecExecutionBindingGraphContract(
  ports: Pick<
    SpecExecutionBindingPorts,
    "executionContract" | "prompts" | "liveEdits"
  >,
  deps?: {
    loadRevisionSnapshot(
      revisionId: string,
    ): Promise<SpecRevisionSnapshot | null>;
  },
): GraphExecutionContract {
  return {
    validateDefinition() {
      return { ok: true };
    },
    loadLiveEdit(execution) {
      const linked = resolveExecutionBinding(ports.liveEdits, execution);
      return {
        validateOperation() {
          return { ok: true };
        },
        accountabilityCoverageGroups: accountabilityCoverageGroups(linked),
      };
    },
    validateTaskCompletion(execution) {
      resolveExecutionBinding(ports.executionContract, execution);
      return { ok: true };
    },
    deriveContextAcceptanceCriteria() {
      return { ok: true, acceptanceCriteriaByContextId: {} };
    },
    async loadPromptProjection(execution, contextId) {
      const linked = resolveExecutionBinding(ports.prompts, execution);
      if (linked === null) return null;
      if (deps === undefined) {
        throw new Error(
          "Spec ownership prompt projection requires a pinned revision loader",
        );
      }
      const snapshot = await deps.loadRevisionSnapshot(
        linked.binding.pinnedRevisionId,
      );
      if (snapshot === null) {
        throw new Error(
          `Pinned revision ${linked.binding.pinnedRevisionId} for workflow execution ${execution.id} was not found`,
        );
      }
      return buildSpecOwnershipProjection(
        linked.binding,
        snapshot,
        contextId,
        execution.launchDocument?.definition.executionContexts.map(
          (context) => context.id,
        ),
      );
    },
  };
}
