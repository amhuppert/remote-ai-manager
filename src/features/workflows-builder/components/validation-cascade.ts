import type {
  GraphWorkflowAgentValidationConfig,
  GraphWorkflowAgentValidationOverride,
  GraphWorkflowCommandSelector,
  GraphWorkflowLaneMergeValidationConfig,
  GraphWorkflowLaneMergeValidationOverride,
} from "@/lib/workflow-graph/config-schemas";
/**
 * Which tier supplied the block-level override. It named the retired
 * inspector's block chrome; it lives here now that the chrome is gone, because
 * the resolution below is what decides it.
 */
export type AgentValidationBlockSource =
  | "global"
  | "workflow"
  | "context-override";

// Per-leaf validation cascade resolution for the workflow-builder inspector —
// the validation counterpart of collaboration-cascade.ts. The leaves here are
// the two ROLE selectors: a provided role selector replaces only its inherited
// counterpart (the override schemas keep omitted roles absent), so provenance
// is computed per role and one block can display two different sources. The
// block-level `source` is still decided by which layer supplied an override
// object — it drives the shared block chrome (badge, reset affordance) exactly
// like the collaboration blocks.

export type AgentValidationRoleSource =
  | "global"
  | "workflow"
  | "context-override";

export interface ResolvedAgentValidationRole {
  value: GraphWorkflowCommandSelector;
  source: AgentValidationRoleSource;
}

export interface ContextAgentValidationCascade {
  implementer: ResolvedAgentValidationRole;
  contextValidator: ResolvedAgentValidationRole;
  blockSource: AgentValidationBlockSource;
}

type AgentValidationRoleKey = "implementer" | "contextValidator";

function resolveRole(
  role: AgentValidationRoleKey,
  contextOverride: GraphWorkflowAgentValidationOverride | undefined,
  workflowOverride: GraphWorkflowAgentValidationOverride | undefined,
  globalConfig: GraphWorkflowAgentValidationConfig,
): ResolvedAgentValidationRole {
  const fromContext = contextOverride?.[role];
  if (fromContext !== undefined) {
    return { value: fromContext, source: "context-override" };
  }
  const fromWorkflow = workflowOverride?.[role];
  if (fromWorkflow !== undefined) {
    return { value: fromWorkflow, source: "workflow" };
  }
  return { value: globalConfig[role], source: "global" };
}

export function resolveContextAgentValidation(
  contextOverride: GraphWorkflowAgentValidationOverride | undefined,
  workflowOverride: GraphWorkflowAgentValidationOverride | undefined,
  globalConfig: GraphWorkflowAgentValidationConfig,
): ContextAgentValidationCascade {
  return {
    implementer: resolveRole(
      "implementer",
      contextOverride,
      workflowOverride,
      globalConfig,
    ),
    contextValidator: resolveRole(
      "contextValidator",
      contextOverride,
      workflowOverride,
      globalConfig,
    ),
    blockSource:
      contextOverride !== undefined
        ? "context-override"
        : workflowOverride !== undefined
          ? "workflow"
          : "global",
  };
}

// The workflow tab's two-layer variant. Role sources stay honest ("global" |
// "workflow") while the block-level source follows that tab's convention that
// an override AT THIS TIER reads "context-override" (badge: Overridden).
export interface WorkflowAgentValidationCascade {
  implementer: {
    value: GraphWorkflowCommandSelector;
    source: "global" | "workflow";
  };
  contextValidator: {
    value: GraphWorkflowCommandSelector;
    source: "global" | "workflow";
  };
  blockSource: "global" | "context-override";
}

export function resolveWorkflowAgentValidation(
  workflowOverride: GraphWorkflowAgentValidationOverride | undefined,
  globalConfig: GraphWorkflowAgentValidationConfig,
): WorkflowAgentValidationCascade {
  const role = (name: AgentValidationRoleKey) => {
    const fromWorkflow = workflowOverride?.[name];
    return fromWorkflow !== undefined
      ? { value: fromWorkflow, source: "workflow" as const }
      : { value: globalConfig[name], source: "global" as const };
  };
  return {
    implementer: role("implementer"),
    contextValidator: role("contextValidator"),
    blockSource: workflowOverride !== undefined ? "context-override" : "global",
  };
}

// Lane-merge validation cascades global → workflow ONLY (the gate guards the
// shared fan-in target, so a per-context tier would be ambiguous), merged per
// leaf like the runtime resolver in resolve-config.ts.
export function resolveWorkflowLaneMergeValidation(
  workflowOverride: GraphWorkflowLaneMergeValidationOverride | undefined,
  globalConfig: GraphWorkflowLaneMergeValidationConfig,
): {
  value: GraphWorkflowLaneMergeValidationConfig;
  source: "global" | "context-override";
} {
  return {
    value: {
      strategy: workflowOverride?.strategy ?? globalConfig.strategy,
      commands: workflowOverride?.commands ?? globalConfig.commands,
    },
    source: workflowOverride !== undefined ? "context-override" : "global",
  };
}
