import {
  graphWorkflowExecutionSchema,
  workflowDefinitionRecordSchema,
} from "@/lib/schemas";
import type { GraphWorkflowExecution, WorkflowDefinitionRecord } from "@/types";

const REMOVED_FIELDS = [
  "contextSoftLimitTokens",
  "contextHardLimitTokens",
] as const;

const REMOVED_FIELD_LIST = REMOVED_FIELDS.join(", ");

const OPERATOR_INSTRUCTIONS =
  "These fields were removed in the workflow continuity schema cutover. " +
  "Please recreate the workflow definition and clear any stale executions manually.";

export class LegacyWorkflowSchemaError extends Error {
  constructor(context: string) {
    super(
      `${context} contains removed fields (${REMOVED_FIELD_LIST}). ${OPERATOR_INSTRUCTIONS}`,
    );
    this.name = "LegacyWorkflowSchemaError";
  }
}

function hasLegacyFields(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(hasLegacyFields);
  const obj = value as Record<string, unknown>;
  for (const field of REMOVED_FIELDS) {
    if (field in obj) return true;
  }
  return Object.values(obj).some(hasLegacyFields);
}

/**
 * Throws LegacyWorkflowSchemaError if value contains any removed continuity fields.
 * Use at write boundaries where the data is already typed but may carry runtime
 * surprises (e.g., an `as unknown as` cast from older code).
 */
export function assertNoLegacyWorkflowFields(
  value: unknown,
  context: string,
): void {
  if (hasLegacyFields(value)) {
    throw new LegacyWorkflowSchemaError(context);
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
  if (hasLegacyFields(rawRecord)) {
    throw new LegacyWorkflowSchemaError("Workflow definition");
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
  if (hasLegacyFields(rawExecution)) {
    throw new LegacyWorkflowSchemaError(
      "Graph workflow execution (workingDefinition)",
    );
  }
  return graphWorkflowExecutionSchema.parse(rawExecution);
}

/**
 * Scans the raw manager state JSON for legacy continuity fields in any session's
 * active graph workflow execution. Throws before schema parsing so the operator
 * receives a targeted error.
 *
 * Called in readState() between JSON.parse() and managerStateSchema.safeParse()
 * to ensure legacy executions in state.json are detected before Zod strips the
 * removed fields.
 */
export function checkRawStateForLegacyWorkflowPayloads(
  rawState: unknown,
): void {
  if (typeof rawState !== "object" || rawState === null) return;
  const state = rawState as Record<string, unknown>;
  const projects = state.projects;
  if (typeof projects !== "object" || projects === null) return;
  for (const project of Object.values(projects as Record<string, unknown>)) {
    if (typeof project !== "object" || project === null) continue;
    const sessions = (project as Record<string, unknown>).sessions;
    if (typeof sessions !== "object" || sessions === null) continue;
    for (const session of Object.values(sessions as Record<string, unknown>)) {
      if (typeof session !== "object" || session === null) continue;
      const exec = (session as Record<string, unknown>).graphWorkflowExecution;
      if (exec != null && hasLegacyFields(exec)) {
        throw new LegacyWorkflowSchemaError(
          "Graph workflow execution in state",
        );
      }
    }
  }
}
