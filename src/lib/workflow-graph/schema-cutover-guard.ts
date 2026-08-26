import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { workflowDefinitionRecordSchema } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import { normalizeRawDefinitionEdgeIds } from "./edge-identity";
import {
  migrateRawDefinitionPlacement,
  migrateRawExecutionPlacement,
} from "./placement-migration";
const UNCONDITIONAL_REMOVED_FIELDS = [
  "contextSoftLimitTokens",
  "contextHardLimitTokens",
  "taskValidation",
] as const;

const CONTEXT_LEVEL_REMOVED_FIELDS = ["agent", "contextValidation"] as const;

const REMOVED_FIELDS = [
  ...UNCONDITIONAL_REMOVED_FIELDS,
  ...CONTEXT_LEVEL_REMOVED_FIELDS,
] as const;

const REMOVED_LANE_VALUES = ["task_validator"] as const;
const REMOVED_VALIDATOR_TYPES = ["task"] as const;

const REMOVED_FIELD_LIST = REMOVED_FIELDS.join(", ");

const OPERATOR_INSTRUCTIONS =
  "These fields were removed in the workflow configuration cascade refactor. " +
  "AcceptanceCriteria is now a required context-level field. Run the graph workflow cleanup command " +
  "(same as the execution-context validator cutover) to delete stale definitions and executions, then recreate workflows.";

/**
 * The agent-assignment cutover needs its own recovery advice: the shapes were
 * rewritten in place by migration 0011, so there is nothing to delete — the
 * caller simply has to write the current form the message already spells out.
 */
const ASSIGNMENT_CUTOVER_INSTRUCTIONS =
  "Persisted configuration was migrated to assignments once, by migration " +
  "0011-workflow-agent-assignments; no compatibility parser accepts the old " +
  "shapes. Write the form named above at each location listed.";

export class LegacyWorkflowSchemaError extends Error {
  constructor(context: string, detail?: string, instruction?: string) {
    const body = detail ?? `contains removed fields (${REMOVED_FIELD_LIST})`;
    super(`${context} ${body}. ${instruction ?? OPERATOR_INSTRUCTIONS}`);
    this.name = "LegacyWorkflowSchemaError";
  }
}

/**
 * Keys whose VALUE is content in a foreign vocabulary, not CC configuration.
 * These detectors scan by field name across the whole tree, so such a subtree
 * must be opaque: a declared output schema names the agent's output fields, and
 * a property legitimately called `taskValidation` (or a nested node carrying
 * `id` + `title`) is not a pre-cutover definition. Without this, an arbitrary
 * word collision makes a valid workflow unsavable AND unloadable — the guard
 * sits on the read path too. `contextOutputs` carries the same hazard one step
 * further removed: its values are what the agent actually emitted under that
 * declared schema, so nobody even hand-picked the colliding word.
 */
const OPAQUE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "outputSchema",
  "contextOutputs",
]);

/** Recurse into the members a detector should still inspect. */
function someNestedValue(
  obj: Record<string, unknown>,
  predicate: (value: unknown) => boolean,
): boolean {
  return Object.entries(obj).some(
    ([key, value]) => !OPAQUE_CONTENT_KEYS.has(key) && predicate(value),
  );
}

function looksLikeContext(obj: Record<string, unknown>): boolean {
  return typeof obj.id === "string" && typeof obj.title === "string";
}

function hasLegacyFields(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(hasLegacyFields);
  const obj = value as Record<string, unknown>;
  for (const field of UNCONDITIONAL_REMOVED_FIELDS) {
    if (field in obj) return true;
  }
  if (looksLikeContext(obj)) {
    for (const field of CONTEXT_LEVEL_REMOVED_FIELDS) {
      if (field in obj) return true;
    }
  }
  if (
    obj.lane &&
    typeof obj.lane === "string" &&
    REMOVED_LANE_VALUES.includes(
      obj.lane as (typeof REMOVED_LANE_VALUES)[number],
    )
  ) {
    return true;
  }
  if (
    obj.validatorType &&
    typeof obj.validatorType === "string" &&
    REMOVED_VALIDATOR_TYPES.includes(
      obj.validatorType as (typeof REMOVED_VALIDATOR_TYPES)[number],
    )
  ) {
    return true;
  }
  return someNestedValue(obj, hasLegacyFields);
}

function hasValidatorWithAcceptanceCriteria(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) {
    return value.some(hasValidatorWithAcceptanceCriteria);
  }
  const obj = value as Record<string, unknown>;
  if (
    (obj.type === "claude" || obj.type === "codex") &&
    "acceptanceCriteria" in obj
  ) {
    return true;
  }
  return someNestedValue(obj, hasValidatorWithAcceptanceCriteria);
}

function hasContextMissingAcceptanceCriteria(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) {
    return value.some(hasContextMissingAcceptanceCriteria);
  }
  const obj = value as Record<string, unknown>;
  if (looksLikeContext(obj)) {
    const hasImplementerOrValidatorField =
      "agent" in obj ||
      "implementer" in obj ||
      "contextValidation" in obj ||
      "contextValidator" in obj;
    if (hasImplementerOrValidatorField && !("acceptanceCriteria" in obj)) {
      return true;
    }
  }
  return someNestedValue(obj, hasContextMissingAcceptanceCriteria);
}

/**
 * Agent-assignment cutover (migration 0011). Both roles moved to library
 * assignments in one breaking migration, so a legacy singleton shape reaching a
 * parse boundary afterwards is a stale writer, never data to upgrade — there is
 * no inbound compatibility parser outside the archived-blob decode floor.
 *
 * Reported with a JSON-path location and the expected form, because the strict
 * assignment schema alone refuses with "unrecognized keys", which names neither
 * the use site nor what to write instead.
 */
const EXPECTED_IMPLEMENTER_FORM =
  "an implementer is now an assignment: " +
  "{ id, profile: { tier, id }, agent: { backend, modelSelection } }";

const EXPECTED_VALIDATOR_FORM =
  "a context validator is now a cohort: " +
  "{ enabled, assignments: [{ id, profile, strategy, agent, continuity }] }";

export interface LegacyAgentShapeIssue {
  /** JSON path of the offending field, relative to the value that was checked. */
  path: string;
  message: string;
}

/** The pre-cutover implementer: a bare per-backend runtime triple. */
function isLegacyImplementer(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return "model" in obj && !("profile" in obj);
}

/**
 * The pre-cutover validator: the provider-named singleton at the global and
 * workflow tiers, the `{kind}` override wrapper at the context tier, and the
 * resolved `null` that meant "validation off".
 */
function isLegacyContextValidator(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.type === "claude" || obj.type === "codex") return true;
  return obj.kind === "use" || obj.kind === "disabled";
}

function joinPath(base: string, segment: string): string {
  return base === "" ? segment : `${base}.${segment}`;
}

/**
 * Every legacy agent shape in `value`, located. Walks by field NAME rather than
 * by known holder positions, so the definition, a whole definition record, and
 * an execution's workingDefinition are all covered by one pass. Content
 * subtrees stay opaque for the same reason the other detectors skip them: a
 * declared output schema may legitimately name a property `contextValidator`.
 */
export function findLegacyAgentShapes(
  value: unknown,
  basePath = "",
): LegacyAgentShapeIssue[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findLegacyAgentShapes(entry, joinPath(basePath, String(index))),
    );
  }

  const obj = value as Record<string, unknown>;
  const issues: LegacyAgentShapeIssue[] = [];
  if ("implementer" in obj && isLegacyImplementer(obj.implementer)) {
    const path = joinPath(basePath, "implementer");
    issues.push({
      path,
      message: `Legacy implementer config at ${path} — ${EXPECTED_IMPLEMENTER_FORM}.`,
    });
  }
  if (
    "contextValidator" in obj &&
    isLegacyContextValidator(obj.contextValidator)
  ) {
    const path = joinPath(basePath, "contextValidator");
    issues.push({
      path,
      message: `Legacy singleton validator config at ${path} — ${EXPECTED_VALIDATOR_FORM}.`,
    });
  }

  for (const [key, nested] of Object.entries(obj)) {
    if (OPAQUE_CONTENT_KEYS.has(key)) continue;
    if (key === "implementer" || key === "contextValidator") continue;
    issues.push(...findLegacyAgentShapes(nested, joinPath(basePath, key)));
  }
  return issues;
}

interface LegacyShapeDetection {
  detail: string;
  instruction?: string;
}

function detectLegacyShape(value: unknown): LegacyShapeDetection | null {
  if (hasLegacyFields(value)) {
    return { detail: `contains removed fields (${REMOVED_FIELD_LIST})` };
  }
  if (hasValidatorWithAcceptanceCriteria(value)) {
    return {
      detail:
        "contains a validator carrying acceptanceCriteria (AC now lives on the context, not the validator)",
    };
  }
  if (hasContextMissingAcceptanceCriteria(value)) {
    return {
      detail:
        "has an execution context missing the required top-level acceptanceCriteria",
    };
  }
  const agentShapes = findLegacyAgentShapes(value);
  if (agentShapes.length > 0) {
    return {
      detail: agentShapes.map((issue) => issue.message).join(" "),
      instruction: ASSIGNMENT_CUTOVER_INSTRUCTIONS,
    };
  }
  return null;
}

/**
 * Throws LegacyWorkflowSchemaError if value contains any removed continuity fields
 * or any pre-cutover shape (validator carrying AC, context missing top-level AC).
 * Use at write boundaries where the data is already typed but may carry runtime
 * surprises (e.g., an `as unknown as` cast from older code).
 */
export function assertNoLegacyWorkflowFields(
  value: unknown,
  context: string,
): void {
  const detected = detectLegacyShape(value);
  if (detected) {
    throw new LegacyWorkflowSchemaError(
      context,
      detected.detail,
      detected.instruction,
    );
  }
}

/**
 * Checks the raw workflow definition record for legacy continuity fields and
 * parses it with the current schema.
 *
 * Must be called before workflowDefinitionRecordSchema.parse() so the operator
 * gets a targeted error instead of an opaque schema failure or silent normalization.
 */
export function assertDefinitionRecordSupported(
  rawRecord: unknown,
): WorkflowDefinitionRecord {
  const detected = detectLegacyShape(rawRecord);
  if (detected) {
    throw new LegacyWorkflowSchemaError(
      "Workflow definition",
      detected.detail,
      detected.instruction,
    );
  }
  // The inflate boundary for a stored definition (D4 decision D2): edge ids are
  // required unique for new authoring, so a document written before that rule is
  // repaired deterministically here rather than refused. Runs before the parse
  // because the parse already requires `id`. Lane placement (D5 decision D13)
  // is repaired at the same point — this is the load path for saved templates
  // in both scope tiers, so a pre-placement template stays startable.
  if (isRecordValue(rawRecord)) {
    normalizeRawDefinitionEdgeIds(rawRecord.definition);
    migrateRawDefinitionPlacement(rawRecord.definition);
  }
  return workflowDefinitionRecordSchema.parse(rawRecord);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the raw graph workflow execution for legacy continuity fields in its
 * workingDefinition and parses it with the current schema.
 *
 * Must be called before graphWorkflowExecutionSchema.parse() so the operator
 * gets a targeted error instead of silent normalization.
 */
export function assertExecutionSupported(
  rawExecution: unknown,
): GraphWorkflowExecution {
  const detected = detectLegacyShape(rawExecution);
  if (detected) {
    throw new LegacyWorkflowSchemaError(
      "Graph workflow execution (workingDefinition)",
      detected.detail,
      detected.instruction,
    );
  }
  if (isRecordValue(rawExecution)) {
    normalizeRawDefinitionEdgeIds(rawExecution.workingDefinition);
    migrateRawExecutionPlacement(rawExecution);
  }
  return graphWorkflowExecutionSchema.parse(rawExecution);
}
