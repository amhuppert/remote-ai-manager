import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  CollaborationConfigSource,
  ResolvedCollaborationConfig,
  WorkflowCollaborationConfig,
  WorkflowCollaborationConfigOverride,
} from "@/lib/workflow-graph/collaboration-schemas";
import type { GraphWorkflowAgentValidatorConfig } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
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
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
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
    humanApprovalGate:
      globalDefaults.humanApprovalGate ?? SEEDED_DEFAULTS.humanApprovalGate,
    askUserQuestions:
      globalDefaults.askUserQuestions ?? SEEDED_DEFAULTS.askUserQuestions,
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
    humanApprovalGate: override.humanApprovalGate ?? defaults.humanApprovalGate,
    askUserQuestions: override.askUserQuestions ?? defaults.askUserQuestions,
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

  const humanApprovalGate =
    context.humanApprovalGate ??
    workflow.humanApprovalGate ??
    defaults.humanApprovalGate;

  const askUserQuestions =
    context.askUserQuestions ??
    workflow.askUserQuestions ??
    defaults.askUserQuestions;

  const collaboration = resolveCollaborationConfigWithProvenance(
    defaults,
    workflow,
    context,
  );

  return {
    id: context.id,
    title: context.title,
    ...(context.description !== undefined
      ? { description: context.description }
      : {}),
    acceptanceCriteria: context.acceptanceCriteria,
    ...(context.origin !== undefined ? { origin: context.origin } : {}),
    implementer,
    contextValidator,
    scriptValidator,
    humanApprovalGate,
    askUserQuestions,
    mutability,
    circuitBreaker,
    iterationPolicy,
    collaboration,
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
    ...(definition.approvalRequired !== undefined
      ? { approvalRequired: definition.approvalRequired }
      : {}),
    ...(definition.origin !== undefined ? { origin: definition.origin } : {}),
    ...(definition.lockedRegions !== undefined
      ? { lockedRegions: definition.lockedRegions }
      : {}),
    // The charter is workflow-global semantic content, attached identically to
    // every resolved context by passthrough — never routed through the
    // operational config cascade and with no per-context override (1.5, 4.5).
    executionContexts: definition.executionContexts.map((context) => ({
      ...resolveContext(defaults, workflowConfig, context),
      charter: definition.charter,
    })),
    tasks: definition.tasks,
    edges: definition.edges,
  };
}

// The backend a (resolved, enabled) context-validator runs on: a `codex`
// validator is fixed to the codex backend; a `claude` validator carries an
// explicit `agent.backend`.
function validatorBackend(
  validator: GraphWorkflowAgentValidatorConfig,
): AgentBackendId {
  return validator.type === "codex" ? "codex" : validator.agent.backend;
}

/**
 * The distinct set of agent backends the resolved workflow actually uses
 * (R5.2a). For every execution context, resolve it through the same config
 * cascade the run uses (per-context → workflow → global) and collect the
 * implementer's backend (always present) plus the context-validator's backend
 * when that validator is non-null AND enabled. A disabled validator does not
 * run, so its backend is NOT "used"; a `disabled`/null validator and a script
 * validator contribute no backend.
 *
 * Backends are not a parameterizable field, so this set is computed from the
 * RAW resolved definition before any `{{...}}` substitution — substitution only
 * touches content/charter text, never the operational config that selects a
 * backend. The start gate hands this set to the pre-flight service so an
 * unscoped skill prerequisite is checked on every backend the launch will run,
 * not a single assumed launch backend.
 */
export function computeUsedBackends(
  global: GlobalConfig,
  definition: WorkflowSemanticDefinition,
): Set<AgentBackendId> {
  const defaults = coerceGlobalDefaults(global.workflowDefaults);
  const workflowConfig = definition.workflowConfig ?? {};
  const backends = new Set<AgentBackendId>();

  for (const context of definition.executionContexts) {
    const resolved = resolveContext(defaults, workflowConfig, context);
    backends.add(resolved.implementer.backend);
    if (resolved.contextValidator && resolved.contextValidator.enabled) {
      backends.add(validatorBackend(resolved.contextValidator));
    }
  }

  return backends;
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
