import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { atomicWriteFile } from "@/lib/shared/atomic-write-json";

import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { stableStringify } from "../serialization";
import {
  FROZEN_CURSOR_MODEL_SNAPSHOT,
  FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS,
  type FrozenCursorModelSnapshotEntry,
} from "./0035-cursor-model-snapshot";
import type { MigrationContext, StateMigration } from "./types";

const logger = createLogger("state-store.migrations");

export const GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION = 12;
const MIGRATION_SCHEMA_DESCRIPTION = "generalized model selection";

type FrozenBackend = "claude" | "codex" | "cursor";

interface FrozenModelSelection {
  readonly modelId: string;
  readonly parameters: Readonly<Record<string, string>>;
}

interface FileMutation {
  readonly filePath: string;
  readonly before: string;
  readonly after: string;
}

interface DatabaseMutation {
  readonly table: string;
  readonly column: string;
  readonly rowid: number;
  readonly before: string;
  readonly after: string;
}

export interface GeneralizedModelSelectionPreflightCounts {
  readonly configCount: number;
  readonly snapshotCount: number;
  readonly transcriptCount: number;
  readonly workflowCount: number;
  readonly contextArtifactCount: number;
}

interface LegacyContextArtifactWitness {
  readonly id: string;
  readonly backend: FrozenBackend;
  readonly model: string;
  readonly effort: string | null;
  readonly modelSelection: FrozenModelSelection;
}

interface AtomicContextArtifactWitness {
  readonly id: string;
  readonly backend: FrozenBackend;
  readonly before: string;
  readonly after: string;
}

type ContextArtifactsMigrationPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "normalize_atomic_rows";
      readonly rows: readonly AtomicContextArtifactWitness[];
    }
  | {
      readonly kind: "rebuild_legacy_table";
      readonly rows: readonly LegacyContextArtifactWitness[];
    };

interface MigrationPlan {
  readonly files: readonly FileMutation[];
  readonly database: readonly DatabaseMutation[];
  readonly contextArtifacts: ContextArtifactsMigrationPlan;
  readonly counts: GeneralizedModelSelectionPreflightCounts;
}

const FROZEN_DEFAULT_MODEL: Record<FrozenBackend, string> = {
  claude: "opus",
  codex: "gpt-5.4",
  cursor: "composer-2.5",
};

const FROZEN_COMPACTION_DEFAULTS = {
  backend: "claude",
  conversationModel: "sonnet",
  messageModel: "sonnet",
  effort: "medium",
} as const;

const FROZEN_CONVERSATION_NAMING_DEFAULTS = {
  backend: "claude",
  model: "haiku",
  effort: "low",
} as const;

interface FrozenSelectionDefaults {
  readonly modelId?: string;
  readonly effort?: string;
  readonly omitUnsupportedEffort?: boolean;
}

type FrozenNonCursorBackend = Exclude<FrozenBackend, "cursor">;

const FROZEN_EFFORT_PARAMETER_ID: Record<
  FrozenNonCursorBackend,
  "effort" | "reasoning"
> = {
  claude: "effort",
  codex: "reasoning",
};

const FROZEN_FAST_PARAMETER_VALUE: Record<
  FrozenNonCursorBackend,
  (parameters: Readonly<Record<string, unknown>>) => boolean | undefined
> = {
  claude: () => undefined,
  codex: (parameters) => parameters.fast === "true",
};

const FROZEN_CLAUDE_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  fable: ["low", "medium", "high", "xhigh", "max"],
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high"],
  haiku: [],
};

const FROZEN_CODEX_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
};

const FROZEN_CODEX_GENERIC_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const FROZEN_CURSOR_MODELS: Readonly<
  Record<string, FrozenCursorModelSnapshotEntry>
> = FROZEN_CURSOR_MODEL_SNAPSHOT;

const LEGACY_MODEL_KEYS = ["model", "modelId"] as const;
const LEGACY_EFFORT_KEYS = ["reasoningEffort", "effort"] as const;
const LEGACY_FAST_KEYS = ["fastMode", "codexFastMode"] as const;
const LEGACY_SELECTION_KEYS = [
  ...LEGACY_MODEL_KEYS,
  ...LEGACY_EFFORT_KEYS,
  ...LEGACY_FAST_KEYS,
] as const;

export type GeneralizedModelSelectionRefusalCode =
  | "ambiguous_legacy_fields"
  | "invalid_json"
  | "invalid_model_selection"
  | "mixed_selection_shapes"
  | "unknown_backend"
  | "unknown_model"
  | "unsupported_parameter_value";

export class GeneralizedModelSelectionMigrationError extends Error {
  constructor(
    readonly holder: string,
    readonly reasonCode: GeneralizedModelSelectionRefusalCode,
    detail: string,
  ) {
    super(
      `0035-generalized-model-selection cannot migrate ${holder}: ${detail} ` +
        "Correct the named holder and restart; no migration ledger entry has been written.",
    );
    this.name = "GeneralizedModelSelectionMigrationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function backendFrom(value: unknown): FrozenBackend | null {
  if (value === "claude" || value === "codex" || value === "cursor") {
    return value;
  }
  return null;
}

function presentKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => Object.hasOwn(value, key));
}

function optionalString(
  value: unknown,
  holder: string,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new GeneralizedModelSelectionMigrationError(
    holder,
    "unsupported_parameter_value",
    `${field} must be a non-empty string when present.`,
  );
}

function optionalBoolean(
  value: unknown,
  holder: string,
  field: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  throw new GeneralizedModelSelectionMigrationError(
    holder,
    "unsupported_parameter_value",
    `${field} must be a boolean when present.`,
  );
}

function singleLegacyValue(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  holder: string,
): { key: string; value: unknown } | null {
  const present = presentKeys(value, keys);
  if (present.length > 1) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "ambiguous_legacy_fields",
      `both ${present.map((key) => JSON.stringify(key)).join(" and ")} are present.`,
    );
  }
  const key = present[0];
  return key === undefined ? null : { key, value: value[key] };
}

function assertSupported(
  holder: string,
  parameterId: string,
  value: string,
  supported: readonly string[],
): void {
  if (supported.includes(value)) return;
  throw new GeneralizedModelSelectionMigrationError(
    holder,
    "unsupported_parameter_value",
    `${parameterId}=${JSON.stringify(value)} is not one of ${supported.join(", ")}.`,
  );
}

function frozenCursorModel(modelId: string): {
  readonly modelId: string;
  readonly entry: FrozenCursorModelSnapshotEntry;
} | null {
  const direct = FROZEN_CURSOR_MODELS[modelId];
  if (direct !== undefined) return { modelId, entry: direct };
  for (const [canonicalModelId, entry] of Object.entries(
    FROZEN_CURSOR_MODELS,
  )) {
    if (entry.aliases.includes(modelId)) {
      return { modelId: canonicalModelId, entry };
    }
  }
  return null;
}

interface FrozenSelectionInput {
  readonly modelId: string;
  readonly effort: string | undefined;
  readonly fast: boolean | undefined;
  readonly holder: string;
  readonly defaults: FrozenSelectionDefaults;
}

function frozenClaudeSelection(
  input: FrozenSelectionInput,
): FrozenModelSelection {
  const supported = FROZEN_CLAUDE_EFFORTS[input.modelId];
  if (supported === undefined) {
    throw new GeneralizedModelSelectionMigrationError(
      input.holder,
      "unknown_model",
      `Claude model ${JSON.stringify(input.modelId)} is not in the frozen cutover catalog.`,
    );
  }
  if (input.fast !== undefined) {
    throw new GeneralizedModelSelectionMigrationError(
      input.holder,
      "unsupported_parameter_value",
      "Claude has no frozen fast parameter.",
    );
  }
  if (supported.length === 0) {
    if (input.effort !== undefined && !input.defaults.omitUnsupportedEffort) {
      throw new GeneralizedModelSelectionMigrationError(
        input.holder,
        "unsupported_parameter_value",
        `Claude model ${JSON.stringify(input.modelId)} has no effort parameter.`,
      );
    }
    return { modelId: input.modelId, parameters: {} };
  }
  const effectiveEffort = input.effort ?? input.defaults.effort ?? "high";
  assertSupported(input.holder, "effort", effectiveEffort, supported);
  return {
    modelId: input.modelId,
    parameters: { effort: effectiveEffort },
  };
}

function frozenCodexSelection(
  input: FrozenSelectionInput,
): FrozenModelSelection {
  const supported =
    FROZEN_CODEX_EFFORTS[input.modelId] ?? FROZEN_CODEX_GENERIC_EFFORTS;
  const effectiveEffort = input.effort ?? input.defaults.effort ?? "high";
  assertSupported(input.holder, "reasoning", effectiveEffort, supported);
  return {
    modelId: input.modelId,
    parameters: {
      fast: String(input.fast ?? false),
      reasoning: effectiveEffort,
    },
  };
}

function frozenCursorSelection(
  input: FrozenSelectionInput,
): FrozenModelSelection {
  const { modelId, effort, fast, holder, defaults } = input;
  const cursorModel = frozenCursorModel(modelId);
  if (cursorModel === null) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "unknown_model",
      `Cursor model ${JSON.stringify(modelId)} is not in the frozen cutover catalog.`,
    );
  }
  if (fast !== undefined) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "unsupported_parameter_value",
      `Cursor model ${JSON.stringify(modelId)} has no frozen legacy fast mapping.`,
    );
  }
  const effectiveEffort = effort ?? defaults.effort;
  if (effectiveEffort === undefined) return cursorModel.entry.defaultSelection;
  const effortSelection =
    cursorModel.entry.legacyReasoningEffort?.selections[effectiveEffort];
  if (effortSelection !== undefined) return effortSelection;
  throw new GeneralizedModelSelectionMigrationError(
    holder,
    "unsupported_parameter_value",
    `Cursor model ${JSON.stringify(modelId)} has no frozen legacy effort mapping for ${JSON.stringify(effectiveEffort)}.`,
  );
}

const FROZEN_SELECTION_BUILDERS: Record<
  FrozenBackend,
  (input: FrozenSelectionInput) => FrozenModelSelection
> = {
  claude: frozenClaudeSelection,
  codex: frozenCodexSelection,
  cursor: frozenCursorSelection,
};

function frozenSelection(
  backend: FrozenBackend,
  rawModel: unknown,
  rawEffort: unknown,
  rawFast: unknown,
  holder: string,
  defaults: FrozenSelectionDefaults = {},
): FrozenModelSelection {
  return FROZEN_SELECTION_BUILDERS[backend]({
    modelId:
      optionalString(rawModel, holder, "model") ??
      defaults.modelId ??
      FROZEN_DEFAULT_MODEL[backend],
    effort: optionalString(rawEffort, holder, "reasoning effort"),
    fast: optionalBoolean(rawFast, holder, "fast mode"),
    holder,
    defaults,
  });
}

function assertCanonicalSelection(
  value: unknown,
  backend: FrozenBackend | null,
  holder: string,
  acceptAlias = false,
): string {
  if (!isRecord(value)) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_model_selection",
      "modelSelection must be an object.",
    );
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify(["modelId", "parameters"])
  ) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_model_selection",
      "modelSelection must contain exactly modelId and parameters.",
    );
  }
  const modelId = optionalString(
    value.modelId,
    holder,
    "modelSelection.modelId",
  );
  if (modelId === undefined || !isRecord(value.parameters)) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_model_selection",
      "modelSelection requires modelId and a parameters object.",
    );
  }
  for (const [parameterId, parameterValue] of Object.entries(
    value.parameters,
  )) {
    if (
      parameterId.trim().length === 0 ||
      typeof parameterValue !== "string" ||
      parameterValue.length === 0
    ) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "invalid_model_selection",
        "modelSelection parameter IDs and values must be non-empty strings.",
      );
    }
  }
  if (backend === null) return modelId;

  if (backend === "cursor") {
    const cursorModel = frozenCursorModel(modelId);
    if (cursorModel === null) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "unknown_model",
        `Cursor model ${JSON.stringify(modelId)} is not in the frozen cutover catalog.`,
      );
    }
    const parameterKey = JSON.stringify(
      Object.entries(value.parameters).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    const variants: readonly string[] | undefined =
      FROZEN_CURSOR_MODEL_VARIANT_PARAMETER_KEYS[cursorModel.modelId];
    if (
      (acceptAlias || cursorModel.modelId === modelId) &&
      variants?.includes(parameterKey)
    ) {
      return cursorModel.modelId;
    }
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_model_selection",
      "modelSelection does not match exactly one frozen model variant.",
    );
  }

  const providerBackend: FrozenNonCursorBackend = backend;
  const effortParameterId = FROZEN_EFFORT_PARAMETER_ID[providerBackend];
  const expected = frozenSelection(
    providerBackend,
    modelId,
    value.parameters[effortParameterId],
    FROZEN_FAST_PARAMETER_VALUE[providerBackend](value.parameters),
    holder,
  );
  const actualEntries = Object.entries(value.parameters).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected.parameters).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (
    expected.modelId !== modelId ||
    JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)
  ) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_model_selection",
      "modelSelection does not match exactly one frozen model variant.",
    );
  }
  return expected.modelId;
}

function transformSelectionHolder(
  value: Record<string, unknown>,
  holder: string,
  backend: FrozenBackend | null,
  defaults: FrozenSelectionDefaults = {},
): { value: Record<string, unknown>; changed: boolean } {
  const legacyKeys = presentKeys(value, LEGACY_SELECTION_KEYS);
  const hasCanonical = Object.hasOwn(value, "modelSelection");
  let canonicalModelId: string | null = null;
  if (hasCanonical) {
    if (legacyKeys.length > 0) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "mixed_selection_shapes",
        `modelSelection is mixed with legacy field(s) ${legacyKeys.join(", ")}.`,
      );
    }
    canonicalModelId = assertCanonicalSelection(
      value.modelSelection,
      backend,
      holder,
      true,
    );
  }

  const model = singleLegacyValue(value, LEGACY_MODEL_KEYS, holder);
  const effort = singleLegacyValue(value, LEGACY_EFFORT_KEYS, holder);
  const fast = singleLegacyValue(value, LEGACY_FAST_KEYS, holder);
  const hasLegacySelection = model !== null || effort !== null || fast !== null;
  if (!hasLegacySelection) {
    if (
      canonicalModelId !== null &&
      isRecord(value.modelSelection) &&
      value.modelSelection.modelId !== canonicalModelId
    ) {
      return {
        value: {
          ...value,
          modelSelection: {
            ...value.modelSelection,
            modelId: canonicalModelId,
          },
        },
        changed: true,
      };
    }
    return { value, changed: false };
  }
  if (backend === null) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "unknown_backend",
      `legacy field(s) ${legacyKeys.join(", ")} have no backend identity.`,
    );
  }

  const next = { ...value };
  for (const key of LEGACY_SELECTION_KEYS) delete next[key];
  next.modelSelection = frozenSelection(
    backend,
    model?.value,
    effort?.value,
    fast?.value,
    holder,
    defaults,
  );
  return { value: next, changed: true };
}

type TransformResult = { value: unknown; changed: boolean };

function holderBackend(
  value: Readonly<Record<string, unknown>>,
  inheritedBackend: FrozenBackend | null,
): FrozenBackend | null {
  if (Object.hasOwn(value, "backend")) return backendFrom(value.backend);
  if (Object.hasOwn(value, "agentBackend")) {
    return backendFrom(value.agentBackend);
  }
  return inheritedBackend;
}

function transformAgentConfig(
  value: unknown,
  holder: string,
  inheritedBackend: FrozenBackend | null = "claude",
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  return transformSelectionHolder(
    value,
    holder,
    holderBackend(value, inheritedBackend),
  );
}

function transformAgentAssignment(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  if (!isRecord(value.agent)) return transformAgentConfig(value, holder);

  const transformed = transformAgentConfig(value.agent, `${holder}.agent`);
  return transformed.changed
    ? { value: { ...value, agent: transformed.value }, changed: true }
    : { value, changed: false };
}

function transformValidatorCohort(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value) || !Array.isArray(value.assignments)) {
    return { value, changed: false };
  }
  let changed = false;
  const assignments = value.assignments.map((assignment, index) => {
    const transformed = transformAgentAssignment(
      assignment,
      `${holder}.assignments[${index}]`,
    );
    changed ||= transformed.changed;
    return transformed.value;
  });
  return changed
    ? { value: { ...value, assignments }, changed: true }
    : { value, changed: false };
}

function transformPlanRepairPolicy(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  const transformed = transformAgentConfig(value.agent, `${holder}.agent`);
  return transformed.changed
    ? { value: { ...value, agent: transformed.value }, changed: true }
    : { value, changed: false };
}

function transformWorkflowCollaboration(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value) || !isRecord(value.secondAgent)) {
    return { value, changed: false };
  }
  const secondAgent = value.secondAgent;
  const transformed = isRecord(secondAgent.value)
    ? transformAgentConfig(secondAgent.value, `${holder}.secondAgent.value`)
    : transformAgentConfig(secondAgent, `${holder}.secondAgent`);
  if (!transformed.changed) return { value, changed: false };
  return isRecord(secondAgent.value)
    ? {
        value: {
          ...value,
          secondAgent: { ...secondAgent, value: transformed.value },
        },
        changed: true,
      }
    : { value: { ...value, secondAgent: transformed.value }, changed: true };
}

function transformWorkflowSettings(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  let next = value;
  let changed = false;
  const replace = (key: string, transformed: TransformResult): void => {
    if (!transformed.changed) return;
    if (!changed) next = { ...value };
    next[key] = transformed.value;
    changed = true;
  };

  replace(
    "implementer",
    transformAgentAssignment(value.implementer, `${holder}.implementer`),
  );
  replace(
    "contextValidator",
    transformValidatorCohort(
      value.contextValidator,
      `${holder}.contextValidator`,
    ),
  );
  replace(
    "planRepair",
    transformPlanRepairPolicy(value.planRepair, `${holder}.planRepair`),
  );
  replace(
    "collaboration",
    transformWorkflowCollaboration(
      value.collaboration,
      `${holder}.collaboration`,
    ),
  );
  return { value: next, changed };
}

function transformLoopGroup(value: unknown, holder: string): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  let next = value;
  let changed = false;

  const planRepair = transformPlanRepairPolicy(
    value.planRepair,
    `${holder}.planRepair`,
  );
  if (planRepair.changed) {
    next = { ...next, planRepair: planRepair.value };
    changed = true;
  }

  if (isRecord(value.template) && Array.isArray(value.template.contexts)) {
    let contextsChanged = false;
    const contexts = value.template.contexts.map((context, index) => {
      const transformed = transformWorkflowSettings(
        context,
        `${holder}.template.contexts[${index}]`,
      );
      contextsChanged ||= transformed.changed;
      return transformed.value;
    });
    if (contextsChanged) {
      next = {
        ...next,
        template: { ...value.template, contexts },
      };
      changed = true;
    }
  }

  return { value: next, changed };
}

function transformWorkflowDefinition(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  let next = value;
  let changed = false;

  const workflowConfig = transformWorkflowSettings(
    value.workflowConfig,
    `${holder}.workflowConfig`,
  );
  if (workflowConfig.changed) {
    next = { ...next, workflowConfig: workflowConfig.value };
    changed = true;
  }

  if (Array.isArray(value.executionContexts)) {
    let contextsChanged = false;
    const contexts = value.executionContexts.map((context, index) => {
      const transformed = transformWorkflowSettings(
        context,
        `${holder}.executionContexts[${index}]`,
      );
      contextsChanged ||= transformed.changed;
      return transformed.value;
    });
    if (contextsChanged) {
      next = { ...next, executionContexts: contexts };
      changed = true;
    }
  }

  if (Array.isArray(value.loopGroups)) {
    let groupsChanged = false;
    const loopGroups = value.loopGroups.map((group, index) => {
      const transformed = transformLoopGroup(
        group,
        `${holder}.loopGroups[${index}]`,
      );
      groupsChanged ||= transformed.changed;
      return transformed.value;
    });
    if (groupsChanged) {
      next = { ...next, loopGroups };
      changed = true;
    }
  }

  return { value: next, changed };
}

function transformWorkflowDocument(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  const next = structuredClone(value);
  let changed = false;

  const replaceDefinition = (key: "definition" | "workingDefinition"): void => {
    const transformed = transformWorkflowDefinition(
      next[key],
      `${holder}.${key}`,
    );
    if (!transformed.changed) return;
    next[key] = transformed.value;
    changed = true;
  };
  replaceDefinition("definition");
  replaceDefinition("workingDefinition");

  if (isRecord(next.launchDocument)) {
    const transformed = transformWorkflowDefinition(
      next.launchDocument.definition,
      `${holder}.launchDocument.definition`,
    );
    if (transformed.changed) {
      next.launchDocument = {
        ...next.launchDocument,
        definition: transformed.value,
      };
      changed = true;
    }
  }

  return { value: next, changed };
}

function transformDeliveryPlanDocument(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value) || !isRecord(value.launch)) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_json",
      "a live delivery-plan document must contain a launch object.",
    );
  }
  const launch = value.launch;
  if (!isRecord(launch.definition)) {
    throw new GeneralizedModelSelectionMigrationError(
      `${holder}.launch`,
      "invalid_json",
      "a live delivery-plan launch must contain a definition object.",
    );
  }
  const transformed = transformWorkflowDefinition(
    launch.definition,
    `${holder}.launch.definition`,
  );
  return transformed.changed
    ? {
        value: {
          ...value,
          launch: { ...launch, definition: transformed.value },
        },
        changed: true,
      }
    : { value, changed: false };
}

function transformCompaction(
  config: Record<string, unknown>,
  holder: string,
): boolean {
  const compaction = config.compaction;
  if (!isRecord(compaction)) return false;
  const backend =
    backendFrom(compaction.backend) ?? FROZEN_COMPACTION_DEFAULTS.backend;
  const oldKeys = ["conversationModel", "messageModel", "effort"].filter(
    (key) => Object.hasOwn(compaction, key),
  );
  const hasNew =
    Object.hasOwn(compaction, "conversationModelSelection") ||
    Object.hasOwn(compaction, "messageModelSelection");
  if (hasNew && oldKeys.length > 0) {
    throw new GeneralizedModelSelectionMigrationError(
      `${holder}.compaction`,
      "mixed_selection_shapes",
      `atomic compaction selections are mixed with ${oldKeys.join(", ")}.`,
    );
  }
  if (oldKeys.length === 0) {
    let changed = false;
    if (Object.hasOwn(compaction, "conversationModelSelection")) {
      const canonicalModelId = assertCanonicalSelection(
        compaction.conversationModelSelection,
        backend,
        `${holder}.compaction.conversationModelSelection`,
        true,
      );
      if (
        isRecord(compaction.conversationModelSelection) &&
        compaction.conversationModelSelection.modelId !== canonicalModelId
      ) {
        compaction.conversationModelSelection = {
          ...compaction.conversationModelSelection,
          modelId: canonicalModelId,
        };
        changed = true;
      }
    }
    if (Object.hasOwn(compaction, "messageModelSelection")) {
      const canonicalModelId = assertCanonicalSelection(
        compaction.messageModelSelection,
        backend,
        `${holder}.compaction.messageModelSelection`,
        true,
      );
      if (
        isRecord(compaction.messageModelSelection) &&
        compaction.messageModelSelection.modelId !== canonicalModelId
      ) {
        compaction.messageModelSelection = {
          ...compaction.messageModelSelection,
          modelId: canonicalModelId,
        };
        changed = true;
      }
    }
    return changed;
  }

  const effort = compaction.effort;
  const conversationModel = compaction.conversationModel;
  const messageModel = compaction.messageModel;
  delete compaction.conversationModel;
  delete compaction.messageModel;
  delete compaction.effort;
  compaction.conversationModelSelection = frozenSelection(
    backend,
    conversationModel,
    effort,
    undefined,
    `${holder}.compaction.conversationModelSelection`,
    {
      modelId: FROZEN_COMPACTION_DEFAULTS.conversationModel,
      effort: FROZEN_COMPACTION_DEFAULTS.effort,
    },
  );
  compaction.messageModelSelection = frozenSelection(
    backend,
    messageModel,
    effort,
    undefined,
    `${holder}.compaction.messageModelSelection`,
    {
      modelId: FROZEN_COMPACTION_DEFAULTS.messageModel,
      effort: FROZEN_COMPACTION_DEFAULTS.effort,
    },
  );
  return true;
}

function transformConversationNaming(
  config: Record<string, unknown>,
  holder: string,
): boolean {
  const naming = config.conversationNaming;
  if (!isRecord(naming)) return false;

  const namingHolder = `${holder}.conversationNaming`;
  const explicitBackend = backendFrom(naming.backend);
  const backend =
    explicitBackend ??
    (Object.hasOwn(naming, "backend")
      ? null
      : FROZEN_CONVERSATION_NAMING_DEFAULTS.backend);
  const transformed = transformSelectionHolder(naming, namingHolder, backend, {
    modelId: FROZEN_CONVERSATION_NAMING_DEFAULTS.model,
    effort: FROZEN_CONVERSATION_NAMING_DEFAULTS.effort,
    omitUnsupportedEffort: true,
  });
  if (!transformed.changed) return false;
  config.conversationNaming = transformed.value;
  return transformed.changed;
}

function transformGlobalConfig(
  value: unknown,
  holder: string,
): { value: unknown; changed: boolean } {
  if (!isRecord(value)) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_json",
      "the root value must be an object.",
    );
  }
  const copy = structuredClone(value);
  const compactionChanged = transformCompaction(copy, holder);
  const namingChanged = transformConversationNaming(copy, holder);

  let backendChanged = false;
  if (isRecord(copy.agentBackends)) {
    for (const backend of ["claude", "codex", "cursor"] as const) {
      const transformed = transformAgentConfig(
        copy.agentBackends[backend],
        `${holder}.agentBackends.${backend}`,
        backend,
      );
      if (!transformed.changed) continue;
      copy.agentBackends[backend] = transformed.value;
      backendChanged = true;
    }
  }

  const workflowDefaults = transformWorkflowSettings(
    copy.workflowDefaults,
    `${holder}.workflowDefaults`,
  );
  if (workflowDefaults.changed) {
    copy.workflowDefaults = workflowDefaults.value;
  }

  return {
    value: copy,
    changed:
      compactionChanged ||
      namingChanged ||
      backendChanged ||
      workflowDefaults.changed,
  };
}

function transformProjectConfig(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_json",
      "the root value must be an object.",
    );
  }
  const copy = structuredClone(value);
  return {
    value: copy,
    changed: transformCompaction(copy, holder),
  };
}

function transformActiveTurn(
  value: unknown,
  holder: string,
  inheritedBackend: FrozenBackend | null,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  if (value.modelSelection === null) {
    const legacyKeys = presentKeys(value, LEGACY_SELECTION_KEYS);
    if (legacyKeys.length > 0) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "mixed_selection_shapes",
        `modelSelection is mixed with legacy field(s) ${legacyKeys.join(", ")}.`,
      );
    }
    return { value, changed: false };
  }
  const legacyKeys = presentKeys(value, LEGACY_SELECTION_KEYS);
  if (
    !Object.hasOwn(value, "modelSelection") &&
    legacyKeys.length > 0 &&
    legacyKeys.every((key) => value[key] === null)
  ) {
    singleLegacyValue(value, LEGACY_MODEL_KEYS, holder);
    singleLegacyValue(value, LEGACY_EFFORT_KEYS, holder);
    singleLegacyValue(value, LEGACY_FAST_KEYS, holder);
    const next = { ...value };
    for (const key of LEGACY_SELECTION_KEYS) delete next[key];
    next.modelSelection = null;
    return { value: next, changed: true };
  }
  return transformSelectionHolder(
    value,
    holder,
    holderBackend(value, inheritedBackend),
  );
}

function transformConversationSnapshot(
  value: unknown,
  holder: string,
  inheritedBackend: FrozenBackend | null = null,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  const context = value.context;
  if (!isRecord(context)) return { value, changed: false };
  const backend = holderBackend(context, inheritedBackend);
  const transformed = transformActiveTurn(
    context.activeTurn,
    `${holder}.context.activeTurn`,
    backend,
  );
  return transformed.changed
    ? {
        value: {
          ...value,
          context: { ...context, activeTurn: transformed.value },
        },
        changed: true,
      }
    : { value, changed: false };
}

function transformPendingQueue(
  value: unknown,
  holder: string,
  inheritedBackend: FrozenBackend | null = null,
): TransformResult {
  if (!Array.isArray(value)) return { value, changed: false };
  let changed = false;
  const entries = value.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const transformed = transformSelectionHolder(
      entry,
      `${holder}[${index}]`,
      holderBackend(entry, inheritedBackend),
    );
    changed ||= transformed.changed;
    return transformed.value;
  });
  return changed
    ? { value: entries, changed: true }
    : { value, changed: false };
}

function transformCollaborationFeatureSnapshot(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  let next = value;
  let changed = false;

  const legacySettingsPresent = Object.hasOwn(value, "agentModelSettings");
  const legacyFastPresent = Object.hasOwn(value, "codexFastMode");
  if (
    Object.hasOwn(value, "agents") &&
    (legacySettingsPresent || legacyFastPresent)
  ) {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "mixed_selection_shapes",
      "agents is mixed with legacy collaboration model settings.",
    );
  }
  if (!legacySettingsPresent && legacyFastPresent) {
    throw new GeneralizedModelSelectionMigrationError(
      `${holder}.codexFastMode`,
      "invalid_model_selection",
      "codexFastMode cannot be converted without agentModelSettings.",
    );
  }
  if (legacySettingsPresent) {
    const settingsHolder = `${holder}.agentModelSettings`;
    if (!isRecord(value.agentModelSettings)) {
      throw new GeneralizedModelSelectionMigrationError(
        settingsHolder,
        "invalid_model_selection",
        "agentModelSettings must be an object keyed by claude and codex.",
      );
    }
    const settings = value.agentModelSettings;
    const unexpectedBackends = Object.keys(settings).filter(
      (backend) => backend !== "claude" && backend !== "codex",
    );
    if (unexpectedBackends.length > 0) {
      throw new GeneralizedModelSelectionMigrationError(
        settingsHolder,
        "unknown_backend",
        `agentModelSettings contains unsupported backend(s) ${unexpectedBackends.join(", ")}.`,
      );
    }
    const primary = backendFrom(value.primaryAgentBackend);
    if (primary !== "claude" && primary !== "codex") {
      throw new GeneralizedModelSelectionMigrationError(
        `${holder}.primaryAgentBackend`,
        "unknown_backend",
        "primaryAgentBackend must identify claude or codex.",
      );
    }
    const secondary = primary === "claude" ? "codex" : "claude";
    const fast = optionalBoolean(
      value.codexFastMode,
      `${holder}.codexFastMode`,
      "codexFastMode",
    );
    const fastByBackend: Record<"claude" | "codex", boolean | undefined> = {
      claude: undefined,
      codex: fast,
    };
    const resolvedAgent = (
      backend: "claude" | "codex",
    ): Record<string, unknown> => {
      const agentHolder = `${settingsHolder}.${backend}`;
      const raw = settings[backend];
      if (!isRecord(raw)) {
        throw new GeneralizedModelSelectionMigrationError(
          agentHolder,
          "invalid_model_selection",
          `${backend} settings must contain model and optional effort fields.`,
        );
      }
      const unexpectedFields = Object.keys(raw).filter(
        (key) => key !== "model" && key !== "effort",
      );
      if (unexpectedFields.length > 0) {
        throw new GeneralizedModelSelectionMigrationError(
          agentHolder,
          "invalid_model_selection",
          `${backend} settings contain unsupported field(s) ${unexpectedFields.join(", ")}.`,
        );
      }
      const model = optionalString(raw.model, agentHolder, "model");
      if (model === undefined) {
        throw new GeneralizedModelSelectionMigrationError(
          agentHolder,
          "unknown_model",
          "model must be a non-empty string.",
        );
      }
      return {
        backend,
        modelSelection: frozenSelection(
          backend,
          model,
          raw.effort,
          fastByBackend[backend],
          agentHolder,
        ),
      };
    };
    next = {
      ...next,
      agents: {
        agent_one: resolvedAgent(primary),
        agent_two: resolvedAgent(secondary),
      },
    };
    delete next.agentModelSettings;
    delete next.codexFastMode;
    changed = true;
  }

  if (isRecord(value.agents)) {
    let agents = value.agents;
    let agentsChanged = false;
    for (const agentId of ["agent_one", "agent_two"] as const) {
      const transformed = transformAgentConfig(
        value.agents[agentId],
        `${holder}.agents.${agentId}`,
        null,
      );
      if (!transformed.changed) continue;
      if (!agentsChanged) agents = { ...value.agents };
      agents[agentId] = transformed.value;
      agentsChanged = true;
    }
    if (agentsChanged) {
      next = { ...next, agents };
      changed = true;
    }
  }

  const resolvedConfig = transformWorkflowCollaboration(
    value.resolvedConfig,
    `${holder}.resolvedConfig`,
  );
  if (resolvedConfig.changed) {
    next = { ...next, resolvedConfig: resolvedConfig.value };
    changed = true;
  }

  return { value: next, changed };
}

function transformWorkflowEnvelopes(
  value: unknown,
  holder: string,
): TransformResult {
  if (!isRecord(value)) return { value, changed: false };
  let next = value;
  let changed = false;
  for (const [workflowId, envelope] of Object.entries(value)) {
    if (!isRecord(envelope)) continue;
    if (envelope.workflowType !== "collaboration") continue;
    if (envelope.status === "completed") continue;
    if (
      envelope.status !== "running" &&
      envelope.status !== "paused" &&
      envelope.status !== "failed"
    ) {
      const snapshot = envelope.featureSnapshot;
      if (
        isRecord(snapshot) &&
        (Object.hasOwn(snapshot, "agentModelSettings") ||
          Object.hasOwn(snapshot, "codexFastMode"))
      ) {
        throw new GeneralizedModelSelectionMigrationError(
          `${holder}.${workflowId}.status`,
          "invalid_json",
          "a collaboration envelope with legacy model settings must have a recognized live status.",
        );
      }
      continue;
    }
    const transformed = transformCollaborationFeatureSnapshot(
      envelope.featureSnapshot,
      `${holder}.${workflowId}.featureSnapshot`,
    );
    if (!transformed.changed) continue;
    if (!changed) next = { ...value };
    next[workflowId] = {
      ...envelope,
      featureSnapshot: transformed.value,
    };
    changed = true;
  }
  return { value: next, changed };
}

function preserveJson(value: unknown): TransformResult {
  return { value, changed: false };
}

function parseJson(contents: string, holder: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new GeneralizedModelSelectionMigrationError(
      holder,
      "invalid_json",
      "the persisted value is not valid JSON.",
    );
  }
}

async function collectFilesRecursively(
  root: string,
  extension: string,
): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFilesRecursively(entryPath, extension)));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      found.push(entryPath);
    }
  }
  return found.sort();
}

async function planJsonFile(
  filePath: string,
  transform: (
    value: unknown,
    holder: string,
  ) => {
    value: unknown;
    changed: boolean;
  },
): Promise<FileMutation | null> {
  const raw = await readFile(filePath, "utf8");
  const transformed = transform(parseJson(raw, filePath), filePath);
  return transformed.changed
    ? {
        filePath,
        before: raw,
        after: JSON.stringify(transformed.value, null, 2),
      }
    : null;
}

function inferTranscriptBackend(
  entry: Record<string, unknown>,
  holder: string,
  configuredBackend: FrozenBackend | null,
): FrozenBackend | null {
  if (configuredBackend !== null) return configuredBackend;
  const direct = backendFrom(entry.backend);
  if (direct !== null) return direct;
  const model = optionalString(entry.model, holder, "model");
  if (model === undefined) return null;
  if (FROZEN_CLAUDE_EFFORTS[model] !== undefined) return "claude";
  if (frozenCursorModel(model) !== null) return "cursor";
  if (FROZEN_CODEX_EFFORTS[model] !== undefined || model.startsWith("gpt-")) {
    return "codex";
  }
  return null;
}

async function planTranscriptFile(
  filePath: string,
  configuredBackend: FrozenBackend | null,
): Promise<FileMutation | null> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let changed = false;
  const values = lines.map((line, index) => {
    const holder = `${filePath}:${index + 1}`;
    const parsed = parseJson(line, holder);
    if (!isRecord(parsed)) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "invalid_json",
        "a transcript line must be a JSON object.",
      );
    }
    const hasLegacy = presentKeys(parsed, LEGACY_SELECTION_KEYS).length > 0;
    const backend = hasLegacy
      ? inferTranscriptBackend(parsed, holder, configuredBackend)
      : configuredBackend;
    const localBackend =
      backendFrom(parsed.backend) ??
      backendFrom(parsed.agentBackend) ??
      backend;
    const transformed = transformSelectionHolder(parsed, holder, localBackend);
    changed ||= transformed.changed;
    return transformed.value;
  });
  return changed
    ? {
        filePath,
        before: raw,
        after: `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
      }
    : null;
}

function tableHasColumn(
  db: MigrationContext["db"],
  table: string,
  column: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((entry) => entry.name === column);
}

function tableColumns(
  db: MigrationContext["db"],
  table: string,
): ReadonlySet<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map(({ name }) => name),
  );
}

function planContextArtifactsMigration(
  db: MigrationContext["db"],
): ContextArtifactsMigrationPlan {
  const columns = tableColumns(db, "context_artifacts");
  if (columns.size === 0) return { kind: "none" };

  const legacyColumns = ["model_provider", "model", "effort"] as const;
  const atomicColumns = ["backend", "model_selection_json"] as const;
  const presentLegacy = legacyColumns.filter((column) => columns.has(column));
  const presentAtomic = atomicColumns.filter((column) => columns.has(column));

  if (presentLegacy.length > 0 && presentAtomic.length > 0) {
    throw new GeneralizedModelSelectionMigrationError(
      "context_artifacts",
      "mixed_selection_shapes",
      "the table contains both legacy and atomic model provenance columns.",
    );
  }

  if (presentAtomic.length > 0) {
    if (presentAtomic.length !== atomicColumns.length) {
      throw new GeneralizedModelSelectionMigrationError(
        "context_artifacts",
        "invalid_model_selection",
        "the table has an incomplete atomic model provenance shape.",
      );
    }
    const rows = db
      .prepare(
        `SELECT id, backend, model_selection_json
         FROM context_artifacts ORDER BY id`,
      )
      .all() as Array<{
      id: unknown;
      backend: unknown;
      model_selection_json: unknown;
    }>;
    const witnesses: AtomicContextArtifactWitness[] = [];
    for (const row of rows) {
      const id =
        optionalString(row.id, "context_artifacts", "id") ?? "<unknown>";
      const holder = `context_artifacts.id=${id}`;
      const backend = backendFrom(row.backend);
      if (backend === null) {
        throw new GeneralizedModelSelectionMigrationError(
          holder,
          "unknown_backend",
          "backend must identify claude, codex, or cursor.",
        );
      }
      if (typeof row.model_selection_json !== "string") {
        throw new GeneralizedModelSelectionMigrationError(
          holder,
          "invalid_model_selection",
          "model_selection_json must contain JSON text.",
        );
      }
      const selection = parseJson(row.model_selection_json, holder);
      const canonicalModelId = assertCanonicalSelection(
        selection,
        backend,
        holder,
        true,
      );
      if (isRecord(selection) && selection.modelId !== canonicalModelId) {
        witnesses.push({
          id,
          backend,
          before: row.model_selection_json,
          after: JSON.stringify({
            ...selection,
            modelId: canonicalModelId,
          }),
        });
      }
    }
    return witnesses.length === 0
      ? { kind: "none" }
      : { kind: "normalize_atomic_rows", rows: witnesses };
  }

  if (presentLegacy.length !== legacyColumns.length) {
    throw new GeneralizedModelSelectionMigrationError(
      "context_artifacts",
      "invalid_model_selection",
      "the table has an incomplete legacy model provenance shape.",
    );
  }

  const rows = db
    .prepare(
      `SELECT id, model_provider, model, effort
       FROM context_artifacts ORDER BY id`,
    )
    .all() as Array<{
    id: unknown;
    model_provider: unknown;
    model: unknown;
    effort: unknown;
  }>;
  const witnesses = rows.map((row): LegacyContextArtifactWitness => {
    const id = optionalString(row.id, "context_artifacts", "id") ?? "<unknown>";
    const holder = `context_artifacts.id=${id}`;
    const backend = backendFrom(row.model_provider);
    if (backend === null) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "unknown_backend",
        "model_provider must identify claude, codex, or cursor.",
      );
    }
    const model = optionalString(row.model, holder, "model");
    if (model === undefined) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "unknown_model",
        "model must be a non-empty string.",
      );
    }
    const effort = optionalString(row.effort, holder, "effort") ?? null;
    return {
      id,
      backend,
      model,
      effort,
      modelSelection: frozenSelection(
        backend,
        model,
        effort,
        undefined,
        holder,
      ),
    };
  });
  return { kind: "rebuild_legacy_table", rows: witnesses };
}

function planDatabaseColumn(
  db: MigrationContext["db"],
  table: string,
  column: string,
  transform: (
    value: unknown,
    holder: string,
    inheritedBackend: FrozenBackend | null,
  ) => TransformResult,
  backendColumn?: string,
): DatabaseMutation[] {
  if (!tableHasColumn(db, table, column)) return [];
  const backendProjection =
    backendColumn === undefined ? "" : `, ${backendColumn}`;
  const rows = db
    .prepare(
      `SELECT rowid AS rowid, ${column} AS value${backendProjection}
       FROM ${table}
       WHERE ${column} IS NOT NULL AND ${column} != ''
       ORDER BY rowid`,
    )
    .all() as Array<Record<string, unknown> & { rowid: number; value: string }>;
  const mutations: DatabaseMutation[] = [];
  for (const row of rows) {
    const holder = `${table}.rowid=${row.rowid}.${column}`;
    const backend =
      backendColumn === undefined ? null : backendFrom(row[backendColumn]);
    const parsed = parseJson(row.value, holder);
    const transformed = transform(parsed, holder, backend);
    if (!transformed.changed) continue;
    mutations.push({
      table,
      column,
      rowid: row.rowid,
      before: row.value,
      after: JSON.stringify(transformed.value),
    });
  }
  return mutations;
}

const LIVE_DELIVERY_PLAN_STATUS_SQL = `(
  attempts.status IN ('draft', 'proposed', 'approved', 'parked')
  OR (
    attempts.status = 'launched'
    AND (
      executions.state IS NULL
      OR executions.state NOT IN ('delivered', 'abandoned')
    )
  )
)`;

/**
 * The candidate identity a snapshot's frozen bytes are signed with, frozen
 * here rather than imported: the launch-time integrity check hashes the stored
 * bytes, so re-expressed bytes have to be re-signed with the algorithm that
 * was in force when they were proposed.
 */
function frozenCandidateHash(candidateBytes: string): string {
  return `sha256:${createHash("sha256").update(candidateBytes).digest("hex")}`;
}

/**
 * Every stored binding of a re-signed candidate's old hash. An approval or a
 * prelaunch hold left on the pre-migration hash names a candidate whose bytes
 * no longer hash to it, and the plan it already authorized would refuse to
 * launch.
 */
function planCandidateHashRebindings(
  db: MigrationContext["db"],
  input: {
    readonly attemptId: string;
    readonly candidateId: string;
    readonly previousHash: string;
    readonly nextHash: string;
  },
): DatabaseMutation[] {
  const columns = (["approval_json", "prelaunch_json"] as const).filter(
    (column) => tableHasColumn(db, "spec_delivery_plan_attempts", column),
  );
  if (columns.length === 0) return [];
  const attempt = db
    .prepare(
      `SELECT rowid AS rowid, ${columns.join(", ")}
       FROM spec_delivery_plan_attempts WHERE id = ?`,
    )
    .get(input.attemptId) as
    | ({ rowid: number } & Record<string, string | null>)
    | undefined;
  if (attempt === undefined) return [];

  const mutations: DatabaseMutation[] = [];
  for (const column of columns) {
    const before = attempt[column];
    if (before === null || before === undefined) continue;
    const holder = `spec_delivery_plan_attempts.id=${input.attemptId}.${column}`;
    const binding = parseJson(before, holder);
    if (!isRecord(binding)) continue;
    // An approval binds the identity directly; a prelaunch hold nests it.
    const identity = column === "approval_json" ? binding : binding.candidate;
    if (
      !isRecord(identity) ||
      identity.candidateId !== input.candidateId ||
      identity.candidateHash !== input.previousHash
    ) {
      continue;
    }
    const nextIdentity = { ...identity, candidateHash: input.nextHash };
    mutations.push({
      table: "spec_delivery_plan_attempts",
      column,
      rowid: attempt.rowid,
      before,
      after: stableStringify(
        column === "approval_json"
          ? nextIdentity
          : { ...binding, candidate: nextIdentity },
      ),
    });
  }
  return mutations;
}

function planDeliveryPlanDocuments(
  db: MigrationContext["db"],
): DatabaseMutation[] {
  if (
    !tableHasColumn(db, "spec_delivery_plan_attempts", "content_json") ||
    !tableHasColumn(db, "spec_delivery_plan_attempts", "status") ||
    !tableHasColumn(db, "spec_delivery_plan_snapshots", "content_json")
  ) {
    return [];
  }

  const attemptRows = db
    .prepare(
      `SELECT attempts.rowid AS rowid, attempts.id AS id,
              attempts.content_json AS value
       FROM spec_delivery_plan_attempts AS attempts
       LEFT JOIN spec_executions AS executions
         ON executions.id = attempts.launched_execution_id
       WHERE ${LIVE_DELIVERY_PLAN_STATUS_SQL}
       ORDER BY attempts.id`,
    )
    .all() as Array<{ rowid: number; id: string; value: string }>;
  const snapshotRows = db
    .prepare(
      `SELECT snapshots.rowid AS rowid, snapshots.id AS id,
              snapshots.attempt_id AS attemptId,
              snapshots.candidate_id AS candidateId,
              snapshots.candidate_hash AS candidateHash,
              snapshots.content_json AS value
       FROM spec_delivery_plan_snapshots AS snapshots
       JOIN spec_delivery_plan_attempts AS attempts
         ON attempts.id = snapshots.attempt_id
       LEFT JOIN spec_executions AS executions
         ON executions.id = attempts.launched_execution_id
       WHERE ${LIVE_DELIVERY_PLAN_STATUS_SQL}
       ORDER BY snapshots.id`,
    )
    .all() as Array<{
    rowid: number;
    id: string;
    attemptId: string;
    candidateId: string | null;
    candidateHash: string | null;
    value: string;
  }>;

  const mutations: DatabaseMutation[] = [];
  // An attempt's `content_json` is the authored draft document itself.
  for (const row of attemptRows) {
    const holder = `spec_delivery_plan_attempts.id=${row.id}.content_json`;
    const transformed = transformDeliveryPlanDocument(
      parseJson(row.value, holder),
      holder,
    );
    if (!transformed.changed) continue;
    mutations.push({
      table: "spec_delivery_plan_attempts",
      column: "content_json",
      rowid: row.rowid,
      before: row.value,
      after: JSON.stringify(transformed.value),
    });
  }

  // A snapshot's `content_json` is the frozen candidate record; the plan
  // document it signs is nested under `document`.
  for (const row of snapshotRows) {
    const holder = `spec_delivery_plan_snapshots.id=${row.id}.content_json`;
    const record = parseJson(row.value, holder);
    if (!isRecord(record) || !isRecord(record.document)) {
      throw new GeneralizedModelSelectionMigrationError(
        holder,
        "invalid_json",
        "a live delivery-plan snapshot must contain a candidate record with a document object.",
      );
    }
    const transformed = transformDeliveryPlanDocument(
      record.document,
      `${holder}.document`,
    );
    if (!transformed.changed) continue;
    // Canonical bytes, because the stored bytes are what the hash covers.
    const after = stableStringify({ ...record, document: transformed.value });
    mutations.push({
      table: "spec_delivery_plan_snapshots",
      column: "content_json",
      rowid: row.rowid,
      before: row.value,
      after,
    });
    const nextHash = frozenCandidateHash(after);
    if (
      row.candidateHash === null ||
      row.candidateId === null ||
      row.candidateHash === nextHash ||
      !tableHasColumn(db, "spec_delivery_plan_snapshots", "candidate_hash")
    ) {
      continue;
    }
    mutations.push({
      table: "spec_delivery_plan_snapshots",
      column: "candidate_hash",
      rowid: row.rowid,
      before: row.candidateHash,
      after: nextHash,
    });
    mutations.push(
      ...planCandidateHashRebindings(db, {
        attemptId: row.attemptId,
        candidateId: row.candidateId,
        previousHash: row.candidateHash,
        nextHash,
      }),
    );
  }

  return mutations;
}

function transcriptBackends(
  db: MigrationContext["db"],
): ReadonlyMap<string, FrozenBackend> {
  const result = new Map<string, FrozenBackend>();
  for (const table of ["conversations", "project_conversations"] as const) {
    if (!tableHasColumn(db, table, "transcript_path")) continue;
    const rows = db
      .prepare(
        `SELECT transcript_path, agent_backend FROM ${table}
         WHERE transcript_path IS NOT NULL AND transcript_path != ''`,
      )
      .all() as Array<{ transcript_path: string; agent_backend: unknown }>;
    for (const row of rows) {
      const backend = backendFrom(row.agent_backend);
      if (backend !== null)
        result.set(path.resolve(row.transcript_path), backend);
    }
  }
  return result;
}

async function discoverGitProjectPaths(
  baseDir: string,
  ignorePatterns: ReadonlySet<string>,
): Promise<string[]> {
  if (!existsSync(baseDir)) return [];
  const projects: string[] = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || ignorePatterns.has(entry.name)) continue;
    const projectPath = path.join(baseDir, entry.name);
    if (!existsSync(path.join(projectPath, ".git"))) continue;
    projects.push(projectPath);
  }
  return projects.sort();
}

async function buildMigrationPlan(
  context: MigrationContext,
): Promise<MigrationPlan> {
  const files: FileMutation[] = [];
  let configCount = 0;
  let transcriptCount = 0;
  let workflowCount = 0;

  if (context.configDir !== null) {
    const plannedConfigPaths = new Set<string>();
    const projectPaths = new Set<string>();
    const configPath = path.join(context.configDir, "config.json");
    if (existsSync(configPath)) {
      const raw = await readFile(configPath, "utf8");
      const value = parseJson(raw, configPath);
      const transformed = transformGlobalConfig(value, configPath);
      plannedConfigPaths.add(path.resolve(configPath));
      if (transformed.changed) {
        files.push({
          filePath: configPath,
          before: raw,
          after: JSON.stringify(transformed.value, null, 2),
        });
        configCount++;
      }
      if (isRecord(value) && typeof value.baseDir === "string") {
        const ignorePatterns = new Set(
          Array.isArray(value.ignorePatterns)
            ? value.ignorePatterns.filter(
                (pattern): pattern is string => typeof pattern === "string",
              )
            : [],
        );
        for (const projectPath of await discoverGitProjectPaths(
          value.baseDir,
          ignorePatterns,
        )) {
          projectPaths.add(projectPath);
        }
      }
    }

    if (tableHasColumn(context.db, "projects", "root_path")) {
      const projects = context.db
        .prepare("SELECT root_path FROM projects ORDER BY root_path")
        .all() as Array<{ root_path: string }>;
      for (const project of projects) projectPaths.add(project.root_path);
    }

    for (const projectPath of [...projectPaths].sort()) {
      const projectConfigPath = path.join(projectPath, "CommandCenter.json");
      const resolvedPath = path.resolve(projectConfigPath);
      if (
        plannedConfigPaths.has(resolvedPath) ||
        !existsSync(projectConfigPath)
      ) {
        continue;
      }
      plannedConfigPaths.add(resolvedPath);
      const mutation = await planJsonFile(
        projectConfigPath,
        transformProjectConfig,
      );
      if (mutation !== null) {
        files.push(mutation);
        configCount++;
      }
    }

    for (const workflowPath of await collectFilesRecursively(
      path.join(context.configDir, "workflows"),
      ".json",
    )) {
      const mutation = await planJsonFile(
        workflowPath,
        transformWorkflowDocument,
      );
      if (mutation !== null) {
        files.push(mutation);
        workflowCount++;
      }
    }

    const backends = transcriptBackends(context.db);
    for (const transcriptPath of await collectFilesRecursively(
      path.join(context.configDir, "transcripts"),
      ".jsonl",
    )) {
      const mutation = await planTranscriptFile(
        transcriptPath,
        backends.get(path.resolve(transcriptPath)) ?? null,
      );
      if (mutation !== null) {
        files.push(mutation);
        transcriptCount++;
      }
    }
  }

  const contextArtifacts = planContextArtifactsMigration(context.db);
  const database = [
    ...planDatabaseColumn(
      context.db,
      "conversation_machine_snapshots",
      "snapshot_json",
      transformConversationSnapshot,
    ),
    ...planDatabaseColumn(
      context.db,
      "conversations",
      "machine_snapshot",
      transformConversationSnapshot,
      "agent_backend",
    ),
    ...planDatabaseColumn(
      context.db,
      "project_conversations",
      "machine_snapshot",
      transformConversationSnapshot,
      "agent_backend",
    ),
    ...planDatabaseColumn(
      context.db,
      "conversations",
      "pending_queue",
      transformPendingQueue,
      "agent_backend",
    ),
    ...planDatabaseColumn(
      context.db,
      "project_conversations",
      "pending_queue",
      transformPendingQueue,
      "agent_backend",
    ),
    ...planDatabaseColumn(
      context.db,
      "sessions",
      "workflow_envelopes",
      transformWorkflowEnvelopes,
    ),
    ...planDatabaseColumn(
      context.db,
      "sessions",
      "workflow_lanes",
      preserveJson,
    ),
    ...planDeliveryPlanDocuments(context.db),
    ...planDatabaseColumn(
      context.db,
      "graph_workflow_executions",
      "definition_json",
      transformWorkflowDocument,
    ),
    ...planDatabaseColumn(
      context.db,
      "graph_workflow_executions",
      "runtime_json",
      preserveJson,
    ),
  ];

  return {
    files,
    database,
    contextArtifacts,
    counts: {
      configCount,
      snapshotCount: database.filter(
        (entry) =>
          entry.table === "conversation_machine_snapshots" ||
          entry.column === "machine_snapshot",
      ).length,
      transcriptCount,
      workflowCount:
        workflowCount +
        database.filter(
          (entry) =>
            // Documents migrated, not columns written: the candidate hash and
            // the bindings that move with it are bookkeeping on a document
            // this count already reports.
            entry.column !== "candidate_hash" &&
            entry.column !== "approval_json" &&
            entry.column !== "prelaunch_json" &&
            (entry.table === "sessions" ||
              entry.table === "spec_delivery_plan_attempts" ||
              entry.table === "spec_delivery_plan_snapshots" ||
              entry.table === "graph_workflow_executions"),
        ).length,
      contextArtifactCount:
        contextArtifacts.kind === "none" ? 0 : contextArtifacts.rows.length,
    },
  };
}

export async function preflightGeneralizedModelSelection(
  context: MigrationContext,
): Promise<GeneralizedModelSelectionPreflightCounts> {
  const plan = await buildMigrationPlan(context);
  return { ...plan.counts };
}

async function applyFileMutations(
  mutations: readonly FileMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    // The cutover runbook excludes old application writers; overlapping
    // cutover workers compute identical after bytes. This witness read refuses
    // any out-of-band edit observed before the crash-atomic replacement.
    const current = await readFile(mutation.filePath, "utf8");
    if (current === mutation.after) continue;
    if (current !== mutation.before) {
      throw new Error(
        `0035-generalized-model-selection lost its preflight witness for ${mutation.filePath}.`,
      );
    }
    await atomicWriteFile(mutation.filePath, mutation.after);
  }
}

const CONTEXT_ARTIFACTS_ATOMIC_TABLE = "context_artifacts_atomic_0035";

function applyContextArtifactsMigration(
  db: MigrationContext["db"],
  plan: ContextArtifactsMigrationPlan,
): void {
  if (plan.kind === "none") return;

  if (plan.kind === "normalize_atomic_rows") {
    for (const row of plan.rows) {
      const result = db
        .prepare(
          `UPDATE context_artifacts
           SET model_selection_json = ?
           WHERE id = ? AND backend = ? AND model_selection_json = ?`,
        )
        .run(row.after, row.id, row.backend, row.before);
      if (result.changes === 1) continue;
      const applied = db
        .prepare(
          `SELECT backend, model_selection_json
           FROM context_artifacts WHERE id = ?`,
        )
        .get(row.id) as
        | { backend: string; model_selection_json: string }
        | undefined;
      if (
        applied?.backend === row.backend &&
        applied.model_selection_json === row.after
      ) {
        continue;
      }
      throw new Error(
        `0035-generalized-model-selection lost its preflight witness for context_artifacts.id=${row.id}.`,
      );
    }
    return;
  }

  const columns = tableColumns(db, "context_artifacts");
  const hasAtomicColumns =
    columns.has("backend") && columns.has("model_selection_json");
  const hasLegacyColumns =
    columns.has("model_provider") ||
    columns.has("model") ||
    columns.has("effort");
  if (hasAtomicColumns && !hasLegacyColumns) {
    const readAppliedRow = db.prepare(
      `SELECT backend, model_selection_json
       FROM context_artifacts WHERE id = ?`,
    );
    for (const row of plan.rows) {
      const applied = readAppliedRow.get(row.id) as
        | { backend: string; model_selection_json: string }
        | undefined;
      if (
        applied?.backend !== row.backend ||
        applied.model_selection_json !== JSON.stringify(row.modelSelection)
      ) {
        throw new Error(
          `0035-generalized-model-selection lost its preflight witness for context_artifacts.id=${row.id}.`,
        );
      }
    }
    return;
  }

  db.exec(`
    CREATE TABLE ${CONTEXT_ARTIFACTS_ATOMIC_TABLE} (
      id                         TEXT PRIMARY KEY,
      kind                       TEXT NOT NULL,
      scope                      TEXT NOT NULL,
      project_path               TEXT NOT NULL,
      session_name               TEXT,
      conversation_id            TEXT NOT NULL,
      message_id                 TEXT,
      message_index              INTEGER,
      covered_start_seq          INTEGER NOT NULL,
      covered_end_seq            INTEGER NOT NULL,
      source_hash                TEXT NOT NULL,
      status                     TEXT NOT NULL,
      error                      TEXT,
      backend                    TEXT NOT NULL,
      model_selection_json       TEXT NOT NULL CHECK (
        json_valid(model_selection_json)
      ),
      schema_version             INTEGER NOT NULL,
      prompt_version             TEXT NOT NULL,
      normalizer_version         TEXT NOT NULL,
      created_by                 TEXT NOT NULL,
      created_by_conversation_id TEXT,
      payload_json               TEXT,
      created_at                 TEXT NOT NULL,
      updated_at                 TEXT NOT NULL
    )
  `);

  const copyRow = db.prepare(`
    INSERT INTO ${CONTEXT_ARTIFACTS_ATOMIC_TABLE} (
      id, kind, scope, project_path, session_name, conversation_id,
      message_id, message_index, covered_start_seq, covered_end_seq,
      source_hash, status, error, backend, model_selection_json,
      schema_version, prompt_version, normalizer_version, created_by,
      created_by_conversation_id, payload_json, created_at, updated_at
    )
    SELECT
      id, kind, scope, project_path, session_name, conversation_id,
      message_id, message_index, covered_start_seq, covered_end_seq,
      source_hash, status, error, model_provider, ?,
      schema_version, prompt_version, normalizer_version, created_by,
      created_by_conversation_id, payload_json, created_at, updated_at
    FROM context_artifacts
    WHERE id = ? AND model_provider = ? AND model = ? AND effort IS ?
  `);
  for (const row of plan.rows) {
    const result = copyRow.run(
      JSON.stringify(row.modelSelection),
      row.id,
      row.backend,
      row.model,
      row.effort,
    );
    if (result.changes !== 1) {
      throw new Error(
        `0035-generalized-model-selection lost its preflight witness for context_artifacts.id=${row.id}.`,
      );
    }
  }

  db.exec(`
    DROP TABLE context_artifacts;
    ALTER TABLE ${CONTEXT_ARTIFACTS_ATOMIC_TABLE}
      RENAME TO context_artifacts;
    CREATE INDEX idx_context_artifacts_conversation
      ON context_artifacts (conversation_id, kind);
    CREATE INDEX idx_context_artifacts_scope
      ON context_artifacts (project_path, session_name);
    CREATE UNIQUE INDEX uq_context_artifacts_conversation_kind
      ON context_artifacts (conversation_id)
      WHERE kind = 'conversation_compaction';
    CREATE UNIQUE INDEX uq_context_artifacts_message
      ON context_artifacts (conversation_id, message_index)
      WHERE kind = 'message_compaction';
  `);
}

function applyDatabaseMutations(
  context: MigrationContext,
  mutations: readonly DatabaseMutation[],
  contextArtifacts: ContextArtifactsMigrationPlan,
): void {
  enforceCurrentSchemaCompatibility(
    context.db,
    context.db.name,
    GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
  );
  applyContextArtifactsMigration(context.db, contextArtifacts);
  for (const mutation of mutations) {
    const result = context.db
      .prepare(
        `UPDATE ${mutation.table}
         SET ${mutation.column} = ?
         WHERE rowid = ? AND ${mutation.column} = ?`,
      )
      .run(mutation.after, mutation.rowid, mutation.before);
    if (result.changes !== 1) {
      const applied = context.db
        .prepare(
          `SELECT ${mutation.column} AS value
           FROM ${mutation.table} WHERE rowid = ?`,
        )
        .get(mutation.rowid) as { value: unknown } | undefined;
      if (applied?.value === mutation.after) continue;
      throw new Error(
        `0035-generalized-model-selection lost its preflight witness for ${mutation.table}.rowid=${mutation.rowid}.${mutation.column}.`,
      );
    }
  }
  context.db
    .prepare(
      `INSERT OR IGNORE INTO schema_migrations (version, description)
       VALUES (?, ?)`,
    )
    .run(
      GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
      MIGRATION_SCHEMA_DESCRIPTION,
    );
}

export const generalizedModelSelection: StateMigration = {
  name: "0035-generalized-model-selection",
  up: async ({ context }) => {
    const startedAt = Date.now();
    let plan: MigrationPlan;
    try {
      plan = await buildMigrationPlan(context);
    } catch (error) {
      const refusal =
        error instanceof GeneralizedModelSelectionMigrationError ? error : null;
      logger.error("model_selection.migration_refused", {
        holder: refusal?.holder ?? "unknown",
        reasonCode: refusal?.reasonCode ?? "preflight_failed",
      });
      throw error;
    }

    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
      );
    }
    await applyFileMutations(plan.files);
    context.db
      .transaction(() =>
        applyDatabaseMutations(context, plan.database, plan.contextArtifacts),
      )
      .immediate();

    logger.info("model_selection.migration_completed", {
      ...plan.counts,
      durationMs: Date.now() - startedAt,
    });
  },
};
