import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type {
  CollaborationConfigSource,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  ResolvedCollaborationConfig,
  ResolvedWorkflowSemanticDefinition,
  WorkflowCollaborationConfig,
  WorkflowCollaborationConfigOverride,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
export type ResolvedWorkflowConfig = WorkflowDefaults;

const SEEDED_DEFAULTS: WorkflowDefaults = {
  implementer: {
    backend: "claude",
    model: "opus",
    reasoningEffort: "medium",
  },
  contextValidator: {
    type: "claude",
    enabled: true,
    continuity: { enabled: true },
    agent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
  },
  scriptValidator: { enabled: false },
  iterationPolicy: {
    maxIterations: 20,
    continuity: { enabled: true },
  },
  circuitBreaker: {
    consecutiveFailureThreshold: 3,
  },
  mutability: {
    allowAgentTaskAdd: false,
  },
  collaboration: {
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
};

export function coerceGlobalDefaults(
  globalDefaults: WorkflowDefaults | undefined,
): WorkflowDefaults {
  if (!globalDefaults) return SEEDED_DEFAULTS;
  return {
    implementer: globalDefaults.implementer ?? SEEDED_DEFAULTS.implementer,
    contextValidator:
      globalDefaults.contextValidator ?? SEEDED_DEFAULTS.contextValidator,
    scriptValidator:
      globalDefaults.scriptValidator ?? SEEDED_DEFAULTS.scriptValidator,
    iterationPolicy:
      globalDefaults.iterationPolicy ?? SEEDED_DEFAULTS.iterationPolicy,
    circuitBreaker:
      globalDefaults.circuitBreaker ?? SEEDED_DEFAULTS.circuitBreaker,
    mutability: globalDefaults.mutability ?? SEEDED_DEFAULTS.mutability,
    collaboration:
      globalDefaults.collaboration ?? SEEDED_DEFAULTS.collaboration,
  };
}

export function resolveWorkflowConfig(
  global: GlobalConfig,
  definition: WorkflowSemanticDefinition,
): ResolvedWorkflowConfig {
  const defaults = coerceGlobalDefaults(global.workflowDefaults);
  const override = definition.workflowConfig ?? {};
  return {
    implementer: override.implementer ?? defaults.implementer,
    contextValidator: override.contextValidator ?? defaults.contextValidator,
    scriptValidator: override.scriptValidator ?? defaults.scriptValidator,
    iterationPolicy: override.iterationPolicy ?? defaults.iterationPolicy,
    circuitBreaker: override.circuitBreaker ?? defaults.circuitBreaker,
    mutability: override.mutability ?? defaults.mutability,
    collaboration: mergeCollaborationOverWithDefaults(
      override.collaboration,
      defaults.collaboration,
    ),
  };
}

export function mergeCollaborationOverWithDefaults(
  override: WorkflowCollaborationConfigOverride | undefined,
  base: WorkflowCollaborationConfig,
): WorkflowCollaborationConfig {
  if (!override) return base;
  return {
    secondAgent: override.secondAgent ?? base.secondAgent,
    negotiationRounds: override.negotiationRounds ?? base.negotiationRounds,
    autonomousResolutionThreshold:
      override.autonomousResolutionThreshold ??
      base.autonomousResolutionThreshold,
  };
}

export function resolveContext(
  globalDefaults: WorkflowDefaults,
  workflowConfig: WorkflowConfigOverride,
  context: GraphWorkflowExecutionContextDefinition,
): GraphWorkflowResolvedContext {
  const defaults = coerceGlobalDefaults(globalDefaults);
  const workflow: WorkflowConfigOverride = workflowConfig ?? {};

  const implementer =
    context.implementer ?? workflow.implementer ?? defaults.implementer;

  const mutability =
    context.mutability ?? workflow.mutability ?? defaults.mutability;

  const circuitBreaker =
    context.circuitBreaker ??
    workflow.circuitBreaker ??
    defaults.circuitBreaker;

  const iterationPolicy =
    context.iterationPolicy ??
    workflow.iterationPolicy ??
    defaults.iterationPolicy;

  const contextValidator = resolveContextValidator(
    defaults.contextValidator,
    workflow.contextValidator,
    context.contextValidator,
  );

  const scriptValidator =
    context.scriptValidator ??
    workflow.scriptValidator ??
    defaults.scriptValidator;

  return {
    id: context.id,
    title: context.title,
    ...(context.description !== undefined
      ? { description: context.description }
      : {}),
    acceptanceCriteria: context.acceptanceCriteria,
    implementer,
    contextValidator,
    scriptValidator,
    mutability,
    circuitBreaker,
    iterationPolicy,
  };
}

function resolveContextValidator(
  globalValidator: WorkflowDefaults["contextValidator"],
  workflowValidator: WorkflowConfigOverride["contextValidator"],
  contextOverride: GraphWorkflowExecutionContextDefinition["contextValidator"],
): GraphWorkflowResolvedContext["contextValidator"] {
  if (contextOverride) {
    if (contextOverride.kind === "disabled") return null;
    return contextOverride.value;
  }
  if (workflowValidator) return workflowValidator;
  return globalValidator;
}

export function resolveWorkflowDefinition(
  global: GlobalConfig,
  definition: WorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  const defaults = coerceGlobalDefaults(global.workflowDefaults);
  const workflowConfig = definition.workflowConfig ?? {};

  return {
    schemaVersion: definition.schemaVersion,
    executionContexts: definition.executionContexts.map((context) =>
      resolveContext(defaults, workflowConfig, context),
    ),
    tasks: definition.tasks,
    edges: definition.edges,
  };
}

// Per-field cascade: per-node → workflow → global. Each field is computed
// independently so a single resolved config can carry three distinct
// `source` values. Design §Collaboration Config Resolver, R2.1–R2.3, R2.5.
export function resolveCollaborationConfigWithProvenance(
  globalDefaults: WorkflowDefaults,
  workflowConfig: WorkflowConfigOverride,
  contextConfig: GraphWorkflowExecutionContextDefinition,
): ResolvedCollaborationConfig {
  const perNode: WorkflowCollaborationConfigOverride =
    contextConfig.collaboration ?? {};
  const workflow: WorkflowCollaborationConfigOverride =
    workflowConfig.collaboration ?? {};
  const global: WorkflowCollaborationConfig = globalDefaults.collaboration;

  return {
    secondAgent: pickProvenancedField(
      perNode.secondAgent,
      workflow.secondAgent,
      global.secondAgent,
    ),
    negotiationRounds: pickProvenancedField(
      perNode.negotiationRounds,
      workflow.negotiationRounds,
      global.negotiationRounds,
    ),
    autonomousResolutionThreshold: pickProvenancedField(
      perNode.autonomousResolutionThreshold,
      workflow.autonomousResolutionThreshold,
      global.autonomousResolutionThreshold,
    ),
  };
}

function pickProvenancedField<T>(
  perNode: T | undefined,
  workflow: T | undefined,
  global: T,
): { value: T; source: CollaborationConfigSource } {
  if (perNode !== undefined) return { value: perNode, source: "per-node" };
  if (workflow !== undefined) return { value: workflow, source: "workflow" };
  return { value: global, source: "global" };
}
