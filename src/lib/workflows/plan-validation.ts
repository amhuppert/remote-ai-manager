import { z } from "zod";
import { validateAuthoredDefinition } from "@/lib/workflow-graph/validation";
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/storage";
import type {
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  graphWorkflowVisualLayoutSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";

/**
 * The create/replace request body: a named, laid-out workflow definition. This
 * is the single schema both the persisting routes (create/replace) and the
 * non-persisting `graph-workflow/validate` endpoint parse, so a plan that
 * validates is guaranteed to be acceptable to create.
 */
export const workflowDefinitionMutationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
});

export interface WorkflowPlanIssue {
  /** JSON-path location within the request body, e.g. `definition.tasks.0.contextId`. */
  path: string;
  message: string;
}

export type WorkflowPlanValidationResult =
  | { ok: true; draft: WorkflowDefinitionDraft }
  | { ok: false; issues: WorkflowPlanIssue[] };

/**
 * The field a structural error implicates, appended to the entity's JSON path so
 * the issue points at the exact offending property (e.g. a task's `contextId`).
 * Codes without an entry point at the entity itself.
 */
const STRUCTURAL_FIELD_BY_CODE: Record<string, string> = {
  "duplicate-context-id": "id",
  "empty-context-title": "title",
  "empty-context-acceptance-criteria": "acceptanceCriteria",
  "duplicate-task-id": "id",
  "unknown-task-context": "contextId",
  "empty-task-title": "title",
  "empty-task-instructions": "instructions",
  "duplicate-task-order": "order",
  "unknown-edge-source": "sourceContextId",
  "unknown-edge-target": "targetContextId",
};

/**
 * Map a structural (graph) validation error to a JSON path rooted at the request
 * body. Structural errors carry entity locators (`taskId`/`edgeId`/`contextId`)
 * or a positional `field` (prerequisites/parameters); we resolve those to array
 * indices so the CLI can print `definition.tasks.2.contextId`-style locations.
 * The graph-wide `cycle-detected` error has no entity, so it points at `edges`.
 */
function structuralIssuePath(
  error: WorkflowGraphValidationError,
  definition: WorkflowSemanticDefinition,
): string {
  const field = STRUCTURAL_FIELD_BY_CODE[error.code];
  const withField = (base: string): string =>
    field ? `${base}.${field}` : base;

  if (error.edgeId !== undefined) {
    const index = definition.edges.findIndex((e) => e.id === error.edgeId);
    return withField(
      index >= 0 ? `definition.edges.${index}` : "definition.edges",
    );
  }
  if (error.taskId !== undefined) {
    const index = definition.tasks.findIndex((t) => t.id === error.taskId);
    return withField(
      index >= 0 ? `definition.tasks.${index}` : "definition.tasks",
    );
  }
  if (error.contextId !== undefined) {
    const index = definition.executionContexts.findIndex(
      (c) => c.id === error.contextId,
    );
    return withField(
      index >= 0
        ? `definition.executionContexts.${index}`
        : "definition.executionContexts",
    );
  }
  if (error.field !== undefined) {
    return `definition.${error.field}`;
  }
  if (error.parameterName !== undefined) {
    return "definition.parameters";
  }
  // No entity locator (e.g. `cycle-detected`): the dependency graph is the edges.
  return "definition.edges";
}

/**
 * The shared create-path validation: the Zod parse of a workflow mutation body
 * plus the structural graph checks (dependency cycles, unknown context refs,
 * prerequisite/parameter sanity). Pure — persists nothing. Both the create/
 * replace routes and the `graph-workflow/validate` endpoint call this so a plan
 * that validates here is exactly a plan create will accept.
 *
 * Returns the normalized draft on success (so callers can persist it without a
 * second parse), or the collected issues with JSON-path locations on failure.
 */
export function validateWorkflowPlan(
  rawBody: unknown,
): WorkflowPlanValidationResult {
  const parsed = workflowDefinitionMutationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const structural = validateAuthoredDefinition(parsed.data.definition);
  if (!structural.ok) {
    return {
      ok: false,
      issues: structural.errors.map((error) => ({
        path: structuralIssuePath(error, parsed.data.definition),
        message: error.message,
      })),
    };
  }

  return {
    ok: true,
    draft: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      definition: parsed.data.definition,
      layout: parsed.data.layout,
    },
  };
}
