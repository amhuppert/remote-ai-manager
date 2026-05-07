import {
  graphWorkflowExecutionSchema,
  workflowDefinitionRecordSchema,
} from "@/lib/schemas";
import type { GraphWorkflowExecution, WorkflowDefinitionRecord } from "@/types";

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

export class LegacyWorkflowSchemaError extends Error {
  constructor(context: string, detail?: string) {
    const body = detail ?? `contains removed fields (${REMOVED_FIELD_LIST})`;
    super(`${context} ${body}. ${OPERATOR_INSTRUCTIONS}`);
    this.name = "LegacyWorkflowSchemaError";
  }
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
  return Object.values(obj).some(hasLegacyFields);
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
  return Object.values(obj).some(hasValidatorWithAcceptanceCriteria);
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
  return Object.values(obj).some(hasContextMissingAcceptanceCriteria);
}

function detectLegacyShape(value: unknown): string | null {
  if (hasLegacyFields(value)) {
    return `contains removed fields (${REMOVED_FIELD_LIST})`;
  }
  if (hasValidatorWithAcceptanceCriteria(value)) {
    return "contains a validator carrying acceptanceCriteria (AC now lives on the context, not the validator)";
  }
  if (hasContextMissingAcceptanceCriteria(value)) {
    return "has an execution context missing the required top-level acceptanceCriteria";
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
  const detail = detectLegacyShape(value);
  if (detail) {
    throw new LegacyWorkflowSchemaError(context, detail);
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
  const detail = detectLegacyShape(rawRecord);
  if (detail) {
    throw new LegacyWorkflowSchemaError("Workflow definition", detail);
  }
  return workflowDefinitionRecordSchema.parse(rawRecord);
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
  const detail = detectLegacyShape(rawExecution);
  if (detail) {
    throw new LegacyWorkflowSchemaError(
      "Graph workflow execution (workingDefinition)",
      detail,
    );
  }
  return graphWorkflowExecutionSchema.parse(rawExecution);
}
