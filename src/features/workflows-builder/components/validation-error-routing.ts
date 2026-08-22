import { VALIDATOR_SCREEN_ID } from "@/components/workflow-config-panel/GatesScreens";
import { IMPLEMENTER_SCREEN_ID } from "@/components/workflow-config-panel/AgentsScreens";
import { taskScreenId } from "@/components/workflow-config-panel/navigation-ids";
import type { ConfigScope } from "@/components/workflow-config-panel/types";
import type { WorkflowGraphValidationError } from "@/lib/workflow-graph/definition-schemas";

/**
 * Where the config panel has to be standing for an author to fix one validation
 * error (README §5: every strip row deep-links to the screen and field that
 * raised it).
 *
 * This maps the validator's own codes onto the panel's screen ids; it neither
 * re-decides what is invalid nor restates a message. A code with no editor
 * behind it — graph shape, edges, loops — resolves to the panel root rather
 * than to a screen that cannot fix it, because a row that lands nowhere useful
 * is worse than a row that only selects.
 */
export interface ValidationErrorRoute {
  /** The context to select, or null to leave the canvas selection alone. */
  contextId: string | null;
  scope: ConfigScope;
  /** Screen ids to push, outermost first. Empty means the panel's root. */
  screenPath: readonly string[];
}

const WORKFLOW_ROOT: ValidationErrorRoute = {
  contextId: null,
  scope: "workflow",
  screenPath: [],
};

/**
 * The drill path to a context's output-schema editor. Exported because the
 * refused schema TEXT is not a validator error — it never reaches the store —
 * yet its strip row has to land on the same screen as the errors that are.
 */
export const OUTPUT_SCHEMA_SCREEN_PATH: readonly string[] = ["brief", "schema"];

/** Context-tier codes whose remedy is a fixed screen under Context scope. */
const CONTEXT_SCREEN_PATHS: Readonly<Record<string, readonly string[]>> = {
  "empty-context-title": ["brief"],
  "empty-context-acceptance-criteria": ["brief"],
  "duplicate-context-id": ["brief"],
  // The read-only contract is declared on the schema editor, not on Placement,
  // even though the placement check is what refuses the draft.
  "placement-readonly-missing-output-schema": OUTPUT_SCHEMA_SCREEN_PATH,
  "unsupported-output-schema": OUTPUT_SCHEMA_SCREEN_PATH,
  "placement-lane-name-invalid": ["placement"],
  "placement-reserved-lane-name": ["placement"],
  "placement-session-lane-write-capable": ["placement"],
  "placement-owned-paths-overlap": ["placement"],
  "placement-full-access-concurrency": ["placement"],
  "placement-lane-dependency-cycle": ["placement"],
  "implementer-effort-unsupported": ["agents", IMPLEMENTER_SCREEN_ID],
  "validator-effort-unsupported": ["gates", VALIDATOR_SCREEN_ID],
};

/** Task-tier codes: the list, then the offending task when the error names one. */
const TASK_CODES: ReadonlySet<string> = new Set([
  "empty-task-title",
  "empty-task-instructions",
  "duplicate-task-id",
  "duplicate-task-order",
  "unknown-task-context",
]);

/** Workflow-tier codes whose remedy is a fixed screen under Workflow scope. */
const WORKFLOW_SCREEN_PATHS: Readonly<Record<string, readonly string[]>> = {
  "duplicate-parameter-name": ["params"],
  "empty-enum-options": ["params"],
  "default-not-in-enum-options": ["params"],
  "default-length-out-of-bounds": ["params"],
  "unknown-invariant-scope-context": ["charter"],
  "unknown-source-scope-context": ["charter"],
  "retired-source-access-policy": ["charter"],
  "legacy-source-applies-to": ["charter"],
};

/**
 * Placeholder-lint codes fire over every substitutable text field, so the
 * screen follows the offending FIELD rather than the code: a bad token in
 * charter prose is fixed on the Charter screen, and everything else resolves
 * by declaring the parameter.
 */
const REFERENCE_LINT_CODES: ReadonlySet<string> = new Set([
  "invalid-placeholder-token",
  "undeclared-parameter-reference",
  "referenced-parameter-without-value",
]);

/** Codes raised at either tier; only the context tier's name a context. */
const DUAL_TIER_SCREEN_PATHS: Readonly<Record<string, readonly string[]>> = {
  "validator-write-restriction-unsupported": ["gates", VALIDATOR_SCREEN_ID],
};

export function routeValidationError(
  error: WorkflowGraphValidationError,
): ValidationErrorRoute {
  const contextId = error.contextId ?? null;

  const dualTier = DUAL_TIER_SCREEN_PATHS[error.code];
  if (dualTier !== undefined) {
    return contextId === null
      ? { contextId: null, scope: "workflow", screenPath: dualTier }
      : { contextId, scope: "context", screenPath: dualTier };
  }

  const workflowScreen = WORKFLOW_SCREEN_PATHS[error.code];
  if (workflowScreen !== undefined) {
    return { contextId: null, scope: "workflow", screenPath: workflowScreen };
  }

  if (REFERENCE_LINT_CODES.has(error.code)) {
    return {
      contextId: null,
      scope: "workflow",
      screenPath: error.field?.startsWith("charter.")
        ? ["charter"]
        : ["params"],
    };
  }

  // Everything below edits one context, so an error that names none has no
  // subject to select and stays at the workflow root.
  if (contextId === null) return WORKFLOW_ROOT;

  const contextScreen = CONTEXT_SCREEN_PATHS[error.code];
  if (contextScreen !== undefined) {
    return { contextId, scope: "context", screenPath: contextScreen };
  }

  if (TASK_CODES.has(error.code)) {
    return {
      contextId,
      scope: "context",
      screenPath:
        error.taskId === undefined
          ? ["tasks"]
          : ["tasks", taskScreenId(error.taskId)],
    };
  }

  // An unmapped code still knows whose draft is wrong, so the row selects the
  // context and opens its root rather than guessing a screen.
  return { contextId, scope: "context", screenPath: [] };
}

/** Collections whose element index carries no meaning for a reader. */
const COLLECTION_PREFIXES: ReadonlySet<string> = new Set([
  "executionContexts",
  "tasks",
  "edges",
  "parameters",
  "loopGroups",
  "workflowConfig",
]);

/**
 * The field name a strip row shows (`ctx_notes · placement.outputSchema — …`).
 * The validator's locators address array elements positionally; an index is
 * meaningless next to the context id the row already names, so it is dropped
 * along with the collection it indexed.
 */
export function validationErrorFieldLabel(
  error: WorkflowGraphValidationError,
): string {
  if (error.field === undefined) return error.code;
  const segments = error.field
    .replaceAll(/\[\d+\]/g, "")
    .split(".")
    .filter((segment) => segment !== "" && !/^\d+$/.test(segment));
  const [head, ...rest] = segments;
  if (head !== undefined && rest.length > 0 && COLLECTION_PREFIXES.has(head)) {
    return rest.join(".");
  }
  return segments.join(".");
}

/**
 * One strip row, in the design's own shape (`ctx_x · field — message`). The
 * message is the validator's verbatim; only the locator is rewritten for a
 * reader.
 */
export function validationErrorRowLabel(
  error: WorkflowGraphValidationError,
): string {
  const subject = error.contextId ?? "workflow";
  return `${subject} · ${validationErrorFieldLabel(error)} — ${error.message}`;
}
