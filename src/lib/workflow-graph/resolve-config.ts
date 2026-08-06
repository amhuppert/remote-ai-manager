import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  CollaborationConfigSource,
  ResolvedCollaborationConfig,
  WorkflowCollaborationConfig,
  WorkflowCollaborationConfigOverride,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  DEFAULT_AGENT_VALIDATION_CONFIG,
  DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
  DEFAULT_PLAN_REPAIR_POLICY,
  type GraphWorkflowCommandSelector,
} from "@/lib/workflow-graph/config-schemas";
import type {
  CascadeWorkflowSemanticDefinition,
  GraphWorkflowCascadeContext,
  GraphWorkflowExecutionContextDefinition,
  ResolvedAgentValidationConfig,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
export type ResolvedWorkflowConfig = WorkflowDefaults;

/**
 * The canonical "no config anywhere" workflow defaults — the cascade
 * resolver's global-layer fallback. UI surfaces that need a pre-load or
 * loading-state fallback import THIS object (see form-state,
 * use-global-defaults, the builder inspector); duplicating the literal lets a
 * surface silently drift from what absent config actually means.
 */
export const SEEDED_WORKFLOW_DEFAULTS: WorkflowDefaults = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    },
  },
  // Exactly one reviewer: the cohort is an ordered set, but the seeded default
  // stays a single general reviewer so an unconfigured workflow keeps today's
  // one-invocation-per-round cost profile (R2).
  contextValidator: {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        continuity: { enabled: true },
      },
    ],
  },
  scriptValidator: { commands: [] },
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
  planRepair: DEFAULT_PLAN_REPAIR_POLICY,
  collaboration: {
    enabled: false,
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
  agentValidation: DEFAULT_AGENT_VALIDATION_CONFIG,
  laneMergeValidation: DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
};

export function coerceGlobalDefaults(
  globalDefaults: WorkflowDefaults | undefined,
): WorkflowDefaults {
  if (!globalDefaults) return SEEDED_WORKFLOW_DEFAULTS;
  return {
    implementer:
      globalDefaults.implementer ?? SEEDED_WORKFLOW_DEFAULTS.implementer,
    contextValidator:
      globalDefaults.contextValidator ??
      SEEDED_WORKFLOW_DEFAULTS.contextValidator,
    scriptValidator:
      globalDefaults.scriptValidator ??
      SEEDED_WORKFLOW_DEFAULTS.scriptValidator,
    humanApprovalGate:
      globalDefaults.humanApprovalGate ??
      SEEDED_WORKFLOW_DEFAULTS.humanApprovalGate,
    askUserQuestions:
      globalDefaults.askUserQuestions ??
      SEEDED_WORKFLOW_DEFAULTS.askUserQuestions,
    iterationPolicy:
      globalDefaults.iterationPolicy ??
      SEEDED_WORKFLOW_DEFAULTS.iterationPolicy,
    circuitBreaker:
      globalDefaults.circuitBreaker ?? SEEDED_WORKFLOW_DEFAULTS.circuitBreaker,
    mutability:
      globalDefaults.mutability ?? SEEDED_WORKFLOW_DEFAULTS.mutability,
    planRepair:
      globalDefaults.planRepair ?? SEEDED_WORKFLOW_DEFAULTS.planRepair,
    collaboration:
      globalDefaults.collaboration ?? SEEDED_WORKFLOW_DEFAULTS.collaboration,
    agentValidation:
      globalDefaults.agentValidation ??
      SEEDED_WORKFLOW_DEFAULTS.agentValidation,
    laneMergeValidation:
      globalDefaults.laneMergeValidation ??
      SEEDED_WORKFLOW_DEFAULTS.laneMergeValidation,
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
    planRepair: override.planRepair ?? defaults.planRepair,
    collaboration: mergeCollaborationOverWithDefaults(
      override.collaboration,
      defaults.collaboration,
    ),
    // Per-leaf, mirroring the context-tier cascade: each provided role
    // selector replaces only its inherited counterpart, never the block.
    agentValidation: {
      implementer:
        override.agentValidation?.implementer ??
        defaults.agentValidation.implementer,
      contextValidator:
        override.agentValidation?.contextValidator ??
        defaults.agentValidation.contextValidator,
    },
    // Global → workflow only — a deliberate two-tier deviation from the
    // three-tier cascade: the lane-merge gate guards the shared fan-in
    // target and, under final-only, validates the integration of many
    // contexts at once, so resolving it from any single context would be
    // ambiguous.
    laneMergeValidation: {
      strategy:
        override.laneMergeValidation?.strategy ??
        defaults.laneMergeValidation.strategy,
      commands:
        override.laneMergeValidation?.commands ??
        defaults.laneMergeValidation.commands,
    },
  };
}

export function mergeCollaborationOverWithDefaults(
  override: WorkflowCollaborationConfigOverride | undefined,
  base: WorkflowCollaborationConfig,
): WorkflowCollaborationConfig {
  if (!override) return base;
  return {
    enabled: override.enabled ?? base.enabled,
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
): GraphWorkflowCascadeContext {
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

  const planRepair =
    context.planRepair ?? workflow.planRepair ?? defaults.planRepair;

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
  const scriptValidatorSource: CollaborationConfigSource =
    context.scriptValidator !== undefined
      ? "per-node"
      : workflow.scriptValidator !== undefined
        ? "workflow"
        : "global";

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

  const agentValidation = resolveAgentValidationWithProvenance(
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
    // Identity passthrough: no cascade tier contributes an output schema, so an
    // undeclared field stays absent rather than resolving to a default shape.
    ...(context.outputSchema !== undefined
      ? { outputSchema: context.outputSchema }
      : {}),
    implementer,
    contextValidator,
    scriptValidator,
    scriptValidatorSource,
    humanApprovalGate,
    askUserQuestions,
    mutability,
    circuitBreaker,
    iterationPolicy,
    planRepair,
    collaboration,
    agentValidation,
  };
}

/**
 * Whole-cohort selection: the nearest tier that declares a cohort supplies it
 * entire. Nothing is merged across tiers — a context that names one reviewer
 * replaces the workflow's three rather than adding a fourth — and "off" is a
 * cohort with `enabled: false`, not an absent one, so the dormant assignments
 * survive the cascade.
 */
function resolveContextValidator(
  globalValidator: WorkflowDefaults["contextValidator"],
  workflowValidator: WorkflowConfigOverride["contextValidator"],
  contextOverride: GraphWorkflowExecutionContextDefinition["contextValidator"],
): GraphWorkflowCascadeContext["contextValidator"] {
  return contextOverride ?? workflowValidator ?? globalValidator;
}

export function resolveWorkflowDefinition(
  global: GlobalConfig,
  definition: WorkflowSemanticDefinition,
): CascadeWorkflowSemanticDefinition {
  const defaults = coerceGlobalDefaults(global.workflowDefaults);
  const workflowConfig = definition.workflowConfig ?? {};
  const resolvedWorkflowConfig = resolveWorkflowConfig(global, definition);

  return {
    schemaVersion: definition.schemaVersion,
    ...(definition.approvalRequired !== undefined
      ? { approvalRequired: definition.approvalRequired }
      : {}),
    ...(definition.origin !== undefined ? { origin: definition.origin } : {}),
    ...(definition.lockedRegions !== undefined
      ? { lockedRegions: definition.lockedRegions }
      : {}),
    // Canonical global → workflow resolution, snapshotted at its only tier so
    // merge submissions read the execution's own record.
    laneMergeValidation: resolvedWorkflowConfig.laneMergeValidation,
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

/**
 * The distinct set of agent backends the resolved workflow actually uses
 * (R5.2a). For every execution context, resolve it through the same config
 * cascade the run uses (per-context → workflow → global) and collect the
 * implementer's backend (always present) plus the backend of every assignment
 * in an ENABLED validator cohort. A disabled cohort does not run, so its
 * dormant assignments' backends are NOT "used"; a script validator contributes
 * no backend.
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
    backends.add(resolved.implementer.agent.backend);
    if (resolved.contextValidator.enabled) {
      for (const assignment of resolved.contextValidator.assignments) {
        backends.add(assignment.agent.backend);
      }
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
    enabled: pickProvenancedField(
      perNode.enabled,
      workflow.enabled,
      global.enabled,
    ),
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

/**
 * Per-leaf agent-validation cascade (per-node → workflow → global), modeled
 * on the collaboration resolver: each ROLE selector resolves independently,
 * so a context override of `implementer` can never erase a workflow-level
 * `contextValidator` override. A provided selector replaces its inherited
 * counterpart as a unit — lists are never unioned.
 */
export function resolveAgentValidationWithProvenance(
  globalDefaults: WorkflowDefaults,
  workflowConfig: WorkflowConfigOverride,
  contextConfig: GraphWorkflowExecutionContextDefinition,
): ResolvedAgentValidationConfig {
  const perNode = contextConfig.agentValidation ?? {};
  const workflow = workflowConfig.agentValidation ?? {};
  const global =
    globalDefaults.agentValidation ?? DEFAULT_AGENT_VALIDATION_CONFIG;

  return {
    implementer: pickProvenancedField(
      perNode.implementer,
      workflow.implementer,
      global.implementer,
    ),
    contextValidator: pickProvenancedField(
      perNode.contextValidator,
      workflow.contextValidator,
      global.contextValidator,
    ),
  };
}

export interface CommandSelectorExpansion {
  commands: string[];
  /**
   * Selector names absent from the registry. Reported, never silently
   * dropped: unknown names must fail at the earliest project-bound boundary
   * (create/replace/start/live-edit) as located configuration errors.
   */
  unknownCommands: string[];
}

/**
 * Seed-time expansion of a command selector into an explicit command-name
 * snapshot against a registry's names. Both selector modes expand to
 * explicit names when an execution is seeded, so later registry edits never
 * broaden a running execution's permissions.
 */
export function expandCommandSelector(
  selector: GraphWorkflowCommandSelector,
  registryNames: readonly string[],
): CommandSelectorExpansion {
  if (selector.mode === "only") {
    const known = new Set(registryNames);
    return {
      commands: [...selector.commands],
      unknownCommands: selector.commands.filter((name) => !known.has(name)),
    };
  }
  const excluded = new Set(selector.except);
  const known = new Set(registryNames);
  return {
    commands: registryNames.filter((name) => !excluded.has(name)),
    unknownCommands: selector.except.filter((name) => !known.has(name)),
  };
}
