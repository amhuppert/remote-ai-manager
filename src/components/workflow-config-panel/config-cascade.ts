import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  CollaborationConfigSource,
  WorkflowCollaborationConfig,
  WorkflowCollaborationConfigOverride,
} from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowAgentValidationOverride,
  GraphWorkflowCommandSelector,
  GraphWorkflowLaneMergeValidationConfig,
  GraphWorkflowLaneMergeValidationOverride,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import {
  resolveContextAgentValidation,
  resolveWorkflowLaneMergeValidation,
  type AgentValidationRoleSource,
} from "@/features/workflows-builder/components/validation-cascade";
import {
  coerceGlobalDefaults,
  resolveCollaborationConfigWithProvenance,
  resolveContext,
} from "@/lib/workflow-graph/resolve-config";
import type { ConfigRowProvenance } from "./row-provenance";
import type { ConfigGranularity, ConfigScope, ConfigTier } from "./types";

/**
 * The cascade and provenance adapter every config screen reads.
 *
 * Resolution itself is never restated here: block and per-field values come
 * back from `resolveContext`, the canonical runtime resolver, and lane-merge
 * validation from the builder's own two-tier helper. What this module adds is
 * the panel's view of that cascade — the three granularities an override is
 * stored and cleared at (README §7), so that resetting one role or one field
 * can never take its siblings with it.
 */

export interface ConfigPathValues {
  implementer: NonNullable<WorkflowDefaults["implementer"]>;
  contextValidator: NonNullable<WorkflowDefaults["contextValidator"]>;
  scriptValidator: NonNullable<WorkflowDefaults["scriptValidator"]>;
  humanApprovalGate: NonNullable<WorkflowDefaults["humanApprovalGate"]>;
  askUserQuestions: NonNullable<WorkflowDefaults["askUserQuestions"]>;
  iterationPolicy: NonNullable<WorkflowDefaults["iterationPolicy"]>;
  circuitBreaker: NonNullable<WorkflowDefaults["circuitBreaker"]>;
  planRepair: NonNullable<WorkflowDefaults["planRepair"]>;
  mutability: NonNullable<WorkflowDefaults["mutability"]>;
  "collaboration.enabled": WorkflowCollaborationConfig["enabled"];
  "collaboration.secondAgent": WorkflowCollaborationConfig["secondAgent"];
  "collaboration.negotiationRounds": WorkflowCollaborationConfig["negotiationRounds"];
  "collaboration.autonomousResolutionThreshold": WorkflowCollaborationConfig["autonomousResolutionThreshold"];
  "agentValidation.implementer": GraphWorkflowCommandSelector;
  "agentValidation.contextValidator": GraphWorkflowCommandSelector;
  "laneMergeValidation.strategy": GraphWorkflowLaneMergeValidationConfig["strategy"];
  "laneMergeValidation.commands": GraphWorkflowLaneMergeValidationConfig["commands"];
}

export type ConfigPath = keyof ConfigPathValues;

export interface ConfigResolution<T> {
  value: T;
  sourceTier: ConfigTier;
}

export interface ConfigOverrideCounts {
  block: number;
  role: number;
  field: number;
}

/**
 * What an edit asks for. The panel emits the intent; the host that owns the
 * draft applies it with the appliers below, so no screen has to know how an
 * override is stored.
 *
 * A write carries the path's WHOLE resolved value, not a patch of the field the
 * author touched: a block is stored and inherited as one unit, so promoting it
 * to this tier means writing everything it holds — the fields no screen exposes
 * included (README §6).
 */
export type ConfigSetPathIntent = {
  [P in ConfigPath]: {
    kind: "set-path";
    tier: ConfigScope;
    path: P;
    value: ConfigPathValues[P];
    granularity: ConfigGranularity;
  };
}[ConfigPath];

export interface ConfigResetPathIntent {
  kind: "reset-path";
  tier: ConfigScope;
  path: ConfigPath;
  granularity: ConfigGranularity;
}

export interface ConfigResetAllIntent {
  kind: "reset-all";
  tier: ConfigScope;
}

export type ConfigEditIntent =
  | ConfigSetPathIntent
  | ConfigResetPathIntent
  | ConfigResetAllIntent;

const BLOCK_KEYS = [
  "implementer",
  "contextValidator",
  "scriptValidator",
  "humanApprovalGate",
  "askUserQuestions",
  "iterationPolicy",
  "circuitBreaker",
  "planRepair",
  "mutability",
] as const;
type BlockKey = (typeof BLOCK_KEYS)[number];

const COLLABORATION_FIELDS = [
  "enabled",
  "secondAgent",
  "negotiationRounds",
  "autonomousResolutionThreshold",
] as const;
type CollaborationField = (typeof COLLABORATION_FIELDS)[number];

const AGENT_VALIDATION_ROLES = ["implementer", "contextValidator"] as const;
type AgentValidationRole = (typeof AGENT_VALIDATION_ROLES)[number];

const LANE_MERGE_FIELDS = ["strategy", "commands"] as const;
type LaneMergeField = (typeof LANE_MERGE_FIELDS)[number];

export const CONFIG_PATH_GRANULARITY: Record<ConfigPath, ConfigGranularity> = {
  implementer: "block",
  contextValidator: "block",
  scriptValidator: "block",
  humanApprovalGate: "block",
  askUserQuestions: "block",
  iterationPolicy: "block",
  circuitBreaker: "block",
  planRepair: "block",
  mutability: "block",
  "collaboration.enabled": "field",
  "collaboration.secondAgent": "field",
  "collaboration.negotiationRounds": "field",
  "collaboration.autonomousResolutionThreshold": "field",
  "agentValidation.implementer": "role",
  "agentValidation.contextValidator": "role",
  // Workflow tier only: the lane-merge gate guards the shared fan-in target,
  // so a per-context override would be ambiguous.
  "laneMergeValidation.strategy": "field",
  "laneMergeValidation.commands": "field",
};

/**
 * One write intent per path, each naming its own path literally.
 *
 * The literal is what ties a path to the type of the value it carries. A single
 * generic constructor would hand back `path: ConfigPath` with a value of the
 * union of every path's type, and the applier could no longer prove that a
 * `mutability` intent holds a mutability policy — so the correlation is
 * established here, once, where the path is still a literal. The mapped type
 * makes the table exhaustive: a new cascade path fails to compile until it has
 * an entry.
 */
const SET_INTENT_BY_PATH: {
  [P in ConfigPath]: (
    tier: ConfigScope,
    value: ConfigPathValues[P],
  ) => ConfigSetPathIntent;
} = {
  implementer: (tier, value) => setIntent(tier, "implementer", value),
  contextValidator: (tier, value) => setIntent(tier, "contextValidator", value),
  scriptValidator: (tier, value) => setIntent(tier, "scriptValidator", value),
  humanApprovalGate: (tier, value) =>
    setIntent(tier, "humanApprovalGate", value),
  askUserQuestions: (tier, value) => setIntent(tier, "askUserQuestions", value),
  iterationPolicy: (tier, value) => setIntent(tier, "iterationPolicy", value),
  circuitBreaker: (tier, value) => setIntent(tier, "circuitBreaker", value),
  planRepair: (tier, value) => setIntent(tier, "planRepair", value),
  mutability: (tier, value) => setIntent(tier, "mutability", value),
  "collaboration.enabled": (tier, value) =>
    setIntent(tier, "collaboration.enabled", value),
  "collaboration.secondAgent": (tier, value) =>
    setIntent(tier, "collaboration.secondAgent", value),
  "collaboration.negotiationRounds": (tier, value) =>
    setIntent(tier, "collaboration.negotiationRounds", value),
  "collaboration.autonomousResolutionThreshold": (tier, value) =>
    setIntent(tier, "collaboration.autonomousResolutionThreshold", value),
  "agentValidation.implementer": (tier, value) =>
    setIntent(tier, "agentValidation.implementer", value),
  "agentValidation.contextValidator": (tier, value) =>
    setIntent(tier, "agentValidation.contextValidator", value),
  "laneMergeValidation.strategy": (tier, value) =>
    setIntent(tier, "laneMergeValidation.strategy", value),
  "laneMergeValidation.commands": (tier, value) =>
    setIntent(tier, "laneMergeValidation.commands", value),
};

function setIntent<P extends ConfigPath, V extends ConfigPathValues[P]>(
  tier: ConfigScope,
  path: P,
  value: V,
): {
  kind: "set-path";
  tier: ConfigScope;
  path: P;
  value: V;
  granularity: ConfigGranularity;
} {
  return {
    kind: "set-path",
    tier,
    path,
    value,
    granularity: CONFIG_PATH_GRANULARITY[path],
  };
}

export const WORKFLOW_CONFIG_PATHS: readonly ConfigPath[] = [
  ...BLOCK_KEYS,
  ...COLLABORATION_FIELDS.map(
    (field) => `collaboration.${field}` as const satisfies ConfigPath,
  ),
  ...AGENT_VALIDATION_ROLES.map(
    (role) => `agentValidation.${role}` as const satisfies ConfigPath,
  ),
  ...LANE_MERGE_FIELDS.map(
    (field) => `laneMergeValidation.${field}` as const satisfies ConfigPath,
  ),
];

export const CONTEXT_CONFIG_PATHS: readonly ConfigPath[] =
  WORKFLOW_CONFIG_PATHS.filter(
    (path) => !path.startsWith("laneMergeValidation."),
  );

export interface ConfigCascadeInput {
  scope: ConfigScope;
  globalDefaults: WorkflowDefaults;
  workflowConfig: WorkflowConfigOverride;
  /** The context being edited. Required at context scope. */
  context?: GraphWorkflowExecutionContextDefinition;
}

export interface ConfigCascade {
  scope: ConfigScope;
  /** The paths this tier can override, in card order. */
  paths: readonly ConfigPath[];
  resolve<P extends ConfigPath>(path: P): ConfigResolution<ConfigPathValues[P]>;
  own(path: ConfigPath): boolean;
  counts(paths?: readonly ConfigPath[]): ConfigOverrideCounts;
  provenance(path: ConfigPath): ConfigRowProvenance;
  /** The provenance of a drill row standing in for several paths. */
  groupProvenance(paths: readonly ConfigPath[]): ConfigRowProvenance;
  /** Promote one path to the tier being edited, carrying its whole value. */
  set<P extends ConfigPath>(
    path: P,
    value: ConfigPathValues[P],
  ): ConfigSetPathIntent;
  reset(path: ConfigPath): ConfigResetPathIntent;
  resetAll(): ConfigResetAllIntent;
}

/**
 * A context that overrides nothing. Running the canonical resolver against it
 * yields exactly what a context inherits, which IS the workflow tier's own
 * effective configuration — so the workflow scope reads the same resolver as
 * the context scope rather than a second implementation of the same cascade.
 */
const WORKFLOW_TIER_PROBE: GraphWorkflowExecutionContextDefinition = {
  id: "__workflow-defaults__",
  title: "Workflow defaults",
  acceptanceCriteria: [
    { id: "probe", statement: "Resolves the workflow tier's inherited value." },
  ],
  placement: { lane: "workflow", mode: "readOnly" },
};

function tierOfSource(source: CollaborationConfigSource): ConfigTier {
  return source === "per-node" ? "context" : source;
}

function tierOfRoleSource(source: AgentValidationRoleSource): ConfigTier {
  return source === "context-override" ? "context" : source;
}

type ConfigResolutions = {
  [P in ConfigPath]: ConfigResolution<ConfigPathValues[P]>;
};

export function createConfigCascade(input: ConfigCascadeInput): ConfigCascade {
  const { scope, workflowConfig } = input;
  const globalDefaults = coerceGlobalDefaults(input.globalDefaults);
  const context =
    scope === "context"
      ? (input.context ?? WORKFLOW_TIER_PROBE)
      : WORKFLOW_TIER_PROBE;

  const resolved = resolveContext(globalDefaults, workflowConfig, context);

  const blockTier = (key: BlockKey): ConfigTier => {
    if (scope === "context" && context[key] !== undefined) return "context";
    if (workflowConfig[key] !== undefined) return "workflow";
    return "global";
  };

  // The per-field and per-role resolvers are read directly rather than off the
  // resolved context, whose two provenanced blocks are optional there: these
  // always report every field and role.
  const collaboration = resolveCollaborationConfigWithProvenance(
    globalDefaults,
    workflowConfig,
    context,
  );

  const agentValidation = resolveContextAgentValidation(
    context.agentValidation,
    workflowConfig.agentValidation,
    globalDefaults.agentValidation,
  );

  const laneMerge = resolveWorkflowLaneMergeValidation(
    workflowConfig.laneMergeValidation,
    globalDefaults.laneMergeValidation,
  );
  const laneMergeTier = (field: LaneMergeField): ConfigTier =>
    workflowConfig.laneMergeValidation?.[field] !== undefined
      ? "workflow"
      : "global";

  const resolutions: ConfigResolutions = {
    implementer: {
      value: resolved.implementer,
      sourceTier: blockTier("implementer"),
    },
    contextValidator: {
      value: resolved.contextValidator,
      sourceTier: blockTier("contextValidator"),
    },
    scriptValidator: {
      value: resolved.scriptValidator,
      sourceTier: blockTier("scriptValidator"),
    },
    humanApprovalGate: {
      value: resolved.humanApprovalGate,
      sourceTier: blockTier("humanApprovalGate"),
    },
    askUserQuestions: {
      value: resolved.askUserQuestions,
      sourceTier: blockTier("askUserQuestions"),
    },
    iterationPolicy: {
      value: resolved.iterationPolicy,
      sourceTier: blockTier("iterationPolicy"),
    },
    circuitBreaker: {
      value: resolved.circuitBreaker,
      sourceTier: blockTier("circuitBreaker"),
    },
    planRepair: {
      value: resolved.planRepair,
      sourceTier: blockTier("planRepair"),
    },
    mutability: {
      value: resolved.mutability,
      sourceTier: blockTier("mutability"),
    },
    "collaboration.enabled": {
      value: collaboration.enabled.value,
      sourceTier: tierOfSource(collaboration.enabled.source),
    },
    "collaboration.secondAgent": {
      value: collaboration.secondAgent.value,
      sourceTier: tierOfSource(collaboration.secondAgent.source),
    },
    "collaboration.negotiationRounds": {
      value: collaboration.negotiationRounds.value,
      sourceTier: tierOfSource(collaboration.negotiationRounds.source),
    },
    "collaboration.autonomousResolutionThreshold": {
      value: collaboration.autonomousResolutionThreshold.value,
      sourceTier: tierOfSource(
        collaboration.autonomousResolutionThreshold.source,
      ),
    },
    "agentValidation.implementer": {
      value: agentValidation.implementer.value,
      sourceTier: tierOfRoleSource(agentValidation.implementer.source),
    },
    "agentValidation.contextValidator": {
      value: agentValidation.contextValidator.value,
      sourceTier: tierOfRoleSource(agentValidation.contextValidator.source),
    },
    "laneMergeValidation.strategy": {
      value: laneMerge.value.strategy,
      sourceTier: laneMergeTier("strategy"),
    },
    "laneMergeValidation.commands": {
      value: laneMerge.value.commands,
      sourceTier: laneMergeTier("commands"),
    },
  };

  const paths =
    scope === "context" ? CONTEXT_CONFIG_PATHS : WORKFLOW_CONFIG_PATHS;

  const own = (path: ConfigPath): boolean =>
    resolutions[path].sourceTier === scope;

  const provenance = (path: ConfigPath): ConfigRowProvenance => ({
    sourceTier: resolutions[path].sourceTier,
    scopeTier: scope,
    granularity: CONFIG_PATH_GRANULARITY[path],
  });

  return {
    scope,
    paths,
    resolve: (path) => resolutions[path],
    own,
    counts(subset) {
      const counted: ConfigOverrideCounts = { block: 0, role: 0, field: 0 };
      for (const path of subset ?? paths) {
        if (own(path)) counted[CONFIG_PATH_GRANULARITY[path]] += 1;
      }
      return counted;
    },
    provenance,
    groupProvenance(group) {
      const first = group[0];
      if (first === undefined) {
        return {
          sourceTier: "global",
          scopeTier: scope,
          granularity: "block",
          setHere: false,
        };
      }
      return { ...provenance(first), setHere: group.some(own) };
    },
    set: (path, value) => SET_INTENT_BY_PATH[path](scope, value),
    reset: (path) => ({
      kind: "reset-path",
      tier: scope,
      path,
      granularity: CONFIG_PATH_GRANULARITY[path],
    }),
    resetAll: () => ({ kind: "reset-all", tier: scope }),
  };
}

const KIND_NOUN: Record<ConfigGranularity, [string, string]> = {
  block: ["block", "blocks"],
  role: ["role", "roles"],
  field: ["field", "fields"],
};

export function overrideCountLabel(counts: ConfigOverrideCounts): string {
  const parts: string[] = [];
  for (const kind of ["block", "role", "field"] as const) {
    const count = counts[kind];
    if (count === 0) continue;
    const [one, many] = KIND_NOUN[kind];
    parts.push(`${count} ${count === 1 ? one : many}`);
  }
  return parts.length > 0 ? `${parts.join(" · ")} set here` : "all inherited";
}

// ---------------------------------------------------------------------------
// Appliers
//
// Every applier copies its container and removes exactly what the intent named,
// so a field the panel never authored — `mutability.allowAgentContextAdd` is the
// worked example — survives verbatim.
// ---------------------------------------------------------------------------

/**
 * An override sub-block with its last surviving field removed is not an empty
 * object but an absent one: the cascade decides block-level provenance by
 * presence, so an emptied `{}` would keep reading as set at this tier.
 */
function collaborationWithout(
  block: WorkflowCollaborationConfigOverride | undefined,
  field: CollaborationField,
): WorkflowCollaborationConfigOverride | undefined {
  if (block === undefined) return undefined;
  const next: WorkflowCollaborationConfigOverride = {
    ...(field !== "enabled" && block.enabled !== undefined
      ? { enabled: block.enabled }
      : {}),
    ...(field !== "secondAgent" && block.secondAgent !== undefined
      ? { secondAgent: block.secondAgent }
      : {}),
    ...(field !== "negotiationRounds" && block.negotiationRounds !== undefined
      ? { negotiationRounds: block.negotiationRounds }
      : {}),
    ...(field !== "autonomousResolutionThreshold" &&
    block.autonomousResolutionThreshold !== undefined
      ? { autonomousResolutionThreshold: block.autonomousResolutionThreshold }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function agentValidationWithout(
  block: GraphWorkflowAgentValidationOverride | undefined,
  role: AgentValidationRole,
): GraphWorkflowAgentValidationOverride | undefined {
  if (block === undefined) return undefined;
  const next: GraphWorkflowAgentValidationOverride = {
    ...(role !== "implementer" && block.implementer !== undefined
      ? { implementer: block.implementer }
      : {}),
    ...(role !== "contextValidator" && block.contextValidator !== undefined
      ? { contextValidator: block.contextValidator }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function laneMergeWithout(
  block: GraphWorkflowLaneMergeValidationOverride | undefined,
  field: LaneMergeField,
): GraphWorkflowLaneMergeValidationOverride | undefined {
  if (block === undefined) return undefined;
  const next: GraphWorkflowLaneMergeValidationOverride = {
    ...(field !== "strategy" && block.strategy !== undefined
      ? { strategy: block.strategy }
      : {}),
    ...(field !== "commands" && block.commands !== undefined
      ? { commands: block.commands }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function assignOrDelete<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function subPath(path: ConfigPath, prefix: string): string | null {
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function isCollaborationField(field: string): field is CollaborationField {
  return (COLLABORATION_FIELDS as readonly string[]).includes(field);
}

function isAgentValidationRole(role: string): role is AgentValidationRole {
  return (AGENT_VALIDATION_ROLES as readonly string[]).includes(role);
}

function isLaneMergeField(field: string): field is LaneMergeField {
  return (LANE_MERGE_FIELDS as readonly string[]).includes(field);
}

function isBlockKey(path: ConfigPath): path is BlockKey {
  return (BLOCK_KEYS as readonly string[]).includes(path);
}

/**
 * The override keys BOTH tiers carry. A workflow config and a context
 * definition store the same eleven blocks under the same names, so one writer
 * serves both — and the twelfth, lane-merge validation, is absent here exactly
 * because only one of them has it.
 */
interface ConfigOverrideContainer {
  implementer?: ConfigPathValues["implementer"];
  contextValidator?: ConfigPathValues["contextValidator"];
  scriptValidator?: ConfigPathValues["scriptValidator"];
  humanApprovalGate?: ConfigPathValues["humanApprovalGate"];
  askUserQuestions?: ConfigPathValues["askUserQuestions"];
  iterationPolicy?: ConfigPathValues["iterationPolicy"];
  circuitBreaker?: ConfigPathValues["circuitBreaker"];
  planRepair?: ConfigPathValues["planRepair"];
  mutability?: ConfigPathValues["mutability"];
  collaboration?: WorkflowCollaborationConfigOverride;
  agentValidation?: GraphWorkflowAgentValidationOverride;
}

/**
 * Land one write on the tier's container.
 *
 * Spelled out per path rather than indexed: the value's type is correlated with
 * the path, and only a switch proves that correlation to the compiler. A new
 * cascade path therefore fails to compile here until it says where it is
 * stored — which is the point.
 */
function writeToContainer(
  intent: ConfigSetPathIntent,
  target: ConfigOverrideContainer,
): void {
  switch (intent.path) {
    case "implementer":
      target.implementer = intent.value;
      return;
    case "contextValidator":
      target.contextValidator = intent.value;
      return;
    case "scriptValidator":
      target.scriptValidator = intent.value;
      return;
    case "humanApprovalGate":
      target.humanApprovalGate = intent.value;
      return;
    case "askUserQuestions":
      target.askUserQuestions = intent.value;
      return;
    case "iterationPolicy":
      target.iterationPolicy = intent.value;
      return;
    case "circuitBreaker":
      target.circuitBreaker = intent.value;
      return;
    case "planRepair":
      target.planRepair = intent.value;
      return;
    case "mutability":
      target.mutability = intent.value;
      return;
    case "collaboration.enabled":
      target.collaboration = { ...target.collaboration, enabled: intent.value };
      return;
    case "collaboration.secondAgent":
      target.collaboration = {
        ...target.collaboration,
        secondAgent: intent.value,
      };
      return;
    case "collaboration.negotiationRounds":
      target.collaboration = {
        ...target.collaboration,
        negotiationRounds: intent.value,
      };
      return;
    case "collaboration.autonomousResolutionThreshold":
      target.collaboration = {
        ...target.collaboration,
        autonomousResolutionThreshold: intent.value,
      };
      return;
    case "agentValidation.implementer":
      target.agentValidation = {
        ...target.agentValidation,
        implementer: intent.value,
      };
      return;
    case "agentValidation.contextValidator":
      target.agentValidation = {
        ...target.agentValidation,
        contextValidator: intent.value,
      };
      return;
    case "laneMergeValidation.strategy":
    case "laneMergeValidation.commands":
      // Not a container key: the workflow applier writes these itself, and a
      // context has no tier for them to land on.
      return;
  }
}

export function applyConfigEditToWorkflowConfig(
  intent: ConfigEditIntent,
  config: WorkflowConfigOverride,
): WorkflowConfigOverride {
  const next: WorkflowConfigOverride = { ...config };

  if (intent.kind === "set-path") {
    if (intent.path === "laneMergeValidation.strategy") {
      next.laneMergeValidation = {
        ...next.laneMergeValidation,
        strategy: intent.value,
      };
      return next;
    }
    if (intent.path === "laneMergeValidation.commands") {
      next.laneMergeValidation = {
        ...next.laneMergeValidation,
        commands: intent.value,
      };
      return next;
    }
    writeToContainer(intent, next);
    return next;
  }

  if (intent.kind === "reset-all") {
    for (const key of BLOCK_KEYS) delete next[key];
    delete next.collaboration;
    delete next.agentValidation;
    delete next.laneMergeValidation;
    return next;
  }

  if (isBlockKey(intent.path)) {
    delete next[intent.path];
    return next;
  }

  const collaborationField = subPath(intent.path, "collaboration.");
  if (collaborationField !== null && isCollaborationField(collaborationField)) {
    assignOrDelete(
      next,
      "collaboration",
      collaborationWithout(next.collaboration, collaborationField),
    );
    return next;
  }

  const role = subPath(intent.path, "agentValidation.");
  if (role !== null && isAgentValidationRole(role)) {
    assignOrDelete(
      next,
      "agentValidation",
      agentValidationWithout(next.agentValidation, role),
    );
    return next;
  }

  const laneMergeField = subPath(intent.path, "laneMergeValidation.");
  if (laneMergeField !== null && isLaneMergeField(laneMergeField)) {
    assignOrDelete(
      next,
      "laneMergeValidation",
      laneMergeWithout(next.laneMergeValidation, laneMergeField),
    );
  }
  return next;
}

export function applyConfigEditToContext(
  intent: ConfigEditIntent,
  context: GraphWorkflowExecutionContextDefinition,
): GraphWorkflowExecutionContextDefinition {
  const next: GraphWorkflowExecutionContextDefinition = { ...context };

  if (intent.kind === "set-path") {
    writeToContainer(intent, next);
    return next;
  }

  if (intent.kind === "reset-all") {
    for (const key of BLOCK_KEYS) delete next[key];
    delete next.collaboration;
    delete next.agentValidation;
    return next;
  }

  if (isBlockKey(intent.path)) {
    delete next[intent.path];
    return next;
  }

  const collaborationField = subPath(intent.path, "collaboration.");
  if (collaborationField !== null && isCollaborationField(collaborationField)) {
    assignOrDelete(
      next,
      "collaboration",
      collaborationWithout(next.collaboration, collaborationField),
    );
    return next;
  }

  const role = subPath(intent.path, "agentValidation.");
  if (role !== null && isAgentValidationRole(role)) {
    assignOrDelete(
      next,
      "agentValidation",
      agentValidationWithout(next.agentValidation, role),
    );
  }
  // Lane-merge validation has no context tier, so its intents are a no-op here.
  return next;
}
