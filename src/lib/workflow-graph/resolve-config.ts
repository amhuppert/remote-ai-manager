import type {
  GlobalConfig,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
  WorkflowConfigOverride,
  WorkflowDefaults,
  WorkflowSemanticDefinition,
} from "@/types";

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
};

function coerceGlobalDefaults(
  globalDefaults: WorkflowDefaults | undefined,
): WorkflowDefaults {
  if (!globalDefaults) return SEEDED_DEFAULTS;
  return {
    implementer: globalDefaults.implementer ?? SEEDED_DEFAULTS.implementer,
    contextValidator:
      globalDefaults.contextValidator ?? SEEDED_DEFAULTS.contextValidator,
    iterationPolicy:
      globalDefaults.iterationPolicy ?? SEEDED_DEFAULTS.iterationPolicy,
    circuitBreaker:
      globalDefaults.circuitBreaker ?? SEEDED_DEFAULTS.circuitBreaker,
    mutability: globalDefaults.mutability ?? SEEDED_DEFAULTS.mutability,
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
    iterationPolicy: override.iterationPolicy ?? defaults.iterationPolicy,
    circuitBreaker: override.circuitBreaker ?? defaults.circuitBreaker,
    mutability: override.mutability ?? defaults.mutability,
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

  return {
    id: context.id,
    title: context.title,
    ...(context.description !== undefined
      ? { description: context.description }
      : {}),
    acceptanceCriteria: context.acceptanceCriteria,
    implementer,
    contextValidator,
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
