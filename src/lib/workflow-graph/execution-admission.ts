import { getBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import {
  backendExecutionRefusal,
  type ExecutionCatalogEntry,
  type ExecutionRequirements,
} from "@/lib/agent-backends/execution-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  PLAN_REPAIR_DEFAULT_AGENT,
  type GraphWorkflowPlanRepairPolicy,
} from "./config-schemas";
import type {
  ContextPlacement,
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
  WorkflowGraphValidationError,
} from "./definition-schemas";

interface Assignment {
  agent: { backend: AgentBackendId };
}
interface Roles {
  implementer?: Assignment;
  contextValidator?: { enabled: boolean; assignments: readonly Assignment[] };
  planRepair?: GraphWorkflowPlanRepairPolicy;
}
interface Site {
  backend: AgentBackendId;
  field: string;
  contextId?: string;
  requirements: ExecutionRequirements;
}

export function validateWorkflowExecutionAdmission(
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition,
  entryFor: (
    backend: AgentBackendId,
  ) => ExecutionCatalogEntry = getBackendCatalogEntry,
): WorkflowGraphValidationError[] {
  const sites: Site[] = [];
  function task(
    backend: AgentBackendId,
    field: string,
    operation: string,
    contextId?: string,
  ): void {
    sites.push({
      backend,
      field,
      contextId,
      requirements: {
        facet: "tasks",
        executionClass: "governed-execution",
        executionProfile: "standard",
        operation,
      },
    });
  }
  function implementer(
    assignment: Assignment | undefined,
    field: string,
    placement?: ContextPlacement,
    contextId?: string,
  ): void {
    if (!assignment) return;
    const backend = assignment.agent.backend;
    sites.push({
      backend,
      field,
      contextId,
      requirements: {
        facet: "conversation",
        executionClass: "governed-execution",
        operation: "workflow-implementer",
        requiresFsWriteRestriction:
          placement !== undefined && placement.mode !== "full",
      },
    });
    task(backend, field, "workflow-implementer-follow-up", contextId);
  }
  function repair(
    policy: GraphWorkflowPlanRepairPolicy | undefined,
    field: string,
    contextId?: string,
  ): void {
    if (policy?.enabled)
      task(
        (policy.agent ?? PLAN_REPAIR_DEFAULT_AGENT).backend,
        field,
        "workflow-plan-repair",
        contextId,
      );
  }
  function roles(
    holder: Roles,
    prefix: string,
    contextId?: string,
    placement?: ContextPlacement,
  ): void {
    implementer(
      holder.implementer,
      `${prefix}.implementer.agent.backend`,
      placement,
      contextId,
    );
    if (holder.contextValidator?.enabled)
      holder.contextValidator.assignments.forEach((assignment, index) =>
        task(
          assignment.agent.backend,
          `${prefix}.contextValidator.assignments.${index}.agent.backend`,
          "workflow-validator",
          contextId,
        ),
      );
    repair(holder.planRepair, `${prefix}.planRepair.agent.backend`, contextId);
  }
  function resolvedContext(
    context: GraphWorkflowResolvedContext,
    prefix: string,
  ): void {
    roles(context, prefix, context.id, context.placement);
    if (context.collaboration?.enabled.value)
      task(
        context.collaboration.secondAgent.value.backend,
        `${prefix}.collaboration.secondAgent.value.backend`,
        "workflow-collaboration",
        context.id,
      );
  }
  if ("workflowConfig" in definition) {
    const workflow = definition.workflowConfig;
    roles(workflow, "workflowConfig");
    if (workflow.collaboration?.enabled && workflow.collaboration.secondAgent)
      task(
        workflow.collaboration.secondAgent.backend,
        "workflowConfig.collaboration.secondAgent.backend",
        "workflow-collaboration",
      );
    definition.executionContexts.forEach((context, index) => {
      const prefix = `executionContexts.${index}`;
      roles(context, prefix, context.id, context.placement);
      if (!context.implementer && context.placement.mode !== "full")
        implementer(
          workflow.implementer,
          "workflowConfig.implementer.agent.backend",
          context.placement,
          context.id,
        );
      const collaboration = {
        ...workflow.collaboration,
        ...context.collaboration,
      };
      if (collaboration.enabled && collaboration.secondAgent)
        task(
          collaboration.secondAgent.backend,
          context.collaboration?.secondAgent
            ? `${prefix}.collaboration.secondAgent.backend`
            : "workflowConfig.collaboration.secondAgent.backend",
          "workflow-collaboration",
          context.id,
        );
    });
  } else {
    definition.executionContexts.forEach((context, index) =>
      resolvedContext(context, `executionContexts.${index}`),
    );
    definition.loopGroups?.forEach((group, index) => {
      const prefix = `loopGroups.${index}`;
      repair(group.planRepair, `${prefix}.planRepair.agent.backend`);
      group.template.contexts.forEach((context, contextIndex) =>
        resolvedContext(context, `${prefix}.template.contexts.${contextIndex}`),
      );
    });
  }
  const errors = new Map<string, WorkflowGraphValidationError>();
  for (const site of sites) {
    const refusal = backendExecutionRefusal(
      entryFor(site.backend),
      site.requirements,
    );
    const key = `${site.contextId ?? ""}:${site.field}`;
    if (refusal && !errors.has(key))
      errors.set(key, {
        code: refusal.code,
        message: `${site.requirements.operation}: ${refusal.message}`,
        field: site.field,
        ...(site.contextId === undefined ? {} : { contextId: site.contextId }),
      });
  }
  return [...errors.values()];
}
