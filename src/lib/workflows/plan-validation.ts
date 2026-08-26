import { collectValidationCommandIssues } from "@/lib/workflow-graph/command-selector-validation";
import {
  VALIDATION_COST_EXCEEDS_LIMIT_CODE,
  type ValidationCommandPreflight,
} from "@/lib/validation/preflight";
import { lintGuardEnumCoverage } from "@/lib/workflow-graph/edge-guard-validation";
import { validateAuthoredDefinition } from "@/lib/workflow-graph/validation";
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/storage";
import type {
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { workflowDefinitionMutationSchema } from "@/lib/workflow-graph/definition-schemas";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import { escapeDiagnosticValue } from "@/lib/shared/diagnostic-text";
import {
  formatAssignmentUseSite,
  type AssignmentRoleLabel,
  type AssignmentTierLabel,
} from "@/lib/workflow-graph/assignment-reference-labels";
import { findLegacyAgentShapes } from "@/lib/workflow-graph/schema-cutover-guard";
import { lintPlanSemantics } from "./plan-lints";
import type { WorkflowPlanIssue } from "./plan-validation-schemas";

export {
  workflowPlanIssueSchema,
  type WorkflowPlanIssue,
} from "./plan-validation-schemas";

export interface WorkflowPlanCommandIssue extends WorkflowPlanIssue {
  code: string;
}

/**
 * `warnings` are located exactly like issues but never refuse the plan: the
 * guard enum-coverage lint (R3.2), which reports a source whose branches leave
 * declared values unrouted with no else edge, plus the semantic authoring
 * lints (#69 change 6).
 */
export type WorkflowPlanValidationResult =
  | {
      ok: true;
      draft: WorkflowDefinitionDraft;
      warnings: WorkflowPlanIssue[];
    }
  | {
      ok: false;
      issues: WorkflowPlanIssue[];
      commandIssues?: WorkflowPlanCommandIssue[];
      code?: typeof VALIDATION_COST_EXCEEDS_LIMIT_CODE;
    };

export interface WorkflowPlanValidationOptions {
  /**
   * The target project's command-cost snapshot and global capacity. Provided
   * at project-bound boundaries so unknown and oversized selections fail as
   * located configuration errors. Omitted at project-unbound callers, where no
   * project registry exists.
   */
  validationCommandPreflight?: ValidationCommandPreflight;
}

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
    // An error that carries BOTH a context id and a `field` already knows its
    // full definition-relative locator (an outputSchema declaration issue names
    // the context index and the offending schema path, e.g.
    // `executionContexts[1].outputSchema.properties.verdict.format`), which is
    // strictly richer than the index this branch would derive.
    if (error.field !== undefined) return `definition.${error.field}`;
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

// ============================================================
// Assignment use-site enrichment (R13.1)
// ============================================================

/**
 * A shape refusal comes from a schema mounted at four different places
 * (workflow tier and per context, implementer and cohort), so it can describe
 * WHAT is wrong but never WHERE — `Duplicate validator assignment id "security"`
 * is the same sentence wherever it was authored.
 *
 * The request body knows where. This layer is the only one holding both the
 * issue and the document, so it appends the use site the async reference layer
 * already names, in the same words: an author cannot tell which of the two
 * layers refused from how the refusal reads.
 *
 * Everything below reads the RAW body — the parse that produced these issues
 * failed, so there is no typed definition to consult and every read has to
 * tolerate whatever the author actually wrote.
 */
function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function readElement(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The qualified `tier:id` the raw assignment spells, when it spells one.
 *
 * Escaped for the same reason the use site is: a malformed profile id is one of
 * the things this diagnostic exists to report, and it reaches here unvalidated.
 * A well-formed ref renders bare (`builtin:general-reviewer`), matching the
 * async layer exactly.
 */
function readProfileRef(assignment: unknown): string | null {
  const profile = readField(assignment, "profile");
  const tier = readNonEmptyString(readField(profile, "tier"));
  const id = readNonEmptyString(readField(profile, "id"));
  return tier !== null && id !== null
    ? `${escapeDiagnosticValue(tier)}:${escapeDiagnosticValue(id)}`
    : null;
}

interface AssignmentSiteDescription {
  useSite: string;
  profile: string | null;
}

function describeAssignmentRole(
  container: unknown,
  tier: AssignmentTierLabel,
  slotPath: readonly PropertyKey[],
): AssignmentSiteDescription | null {
  const describe = (
    assignment: unknown,
    kind: "implementer" | "validator",
  ): AssignmentSiteDescription => ({
    useSite: formatAssignmentUseSite(tier, {
      kind,
      assignmentId: readNonEmptyString(readField(assignment, "id")),
    } satisfies AssignmentRoleLabel),
    profile: readProfileRef(assignment),
  });

  if (slotPath[0] === "implementer") {
    return describe(readField(container, "implementer"), "implementer");
  }
  if (slotPath[0] !== "contextValidator") return null;

  const cohort = readField(container, "contextValidator");
  const index = slotPath[2];
  if (slotPath[1] === "assignments" && typeof index === "number") {
    return describe(
      readElement(readField(cohort, "assignments"), index),
      "validator",
    );
  }
  // The cohort itself is the use site: an enabled-but-empty cohort has no
  // assignment to name, and naming one would be a fiction.
  return {
    useSite: formatAssignmentUseSite(tier, { kind: "cohort" }),
    profile: null,
  };
}

function describeIssueUseSite(
  body: unknown,
  path: readonly PropertyKey[],
): AssignmentSiteDescription | null {
  if (path[0] !== "definition") return null;
  const definition = readField(body, "definition");

  if (path[1] === "workflowConfig") {
    return describeAssignmentRole(
      readField(definition, "workflowConfig"),
      { kind: "workflow" },
      path.slice(2),
    );
  }
  const contextIndex = path[2];
  if (path[1] === "executionContexts" && typeof contextIndex === "number") {
    const context = readElement(
      readField(definition, "executionContexts"),
      contextIndex,
    );
    const contextId = readNonEmptyString(readField(context, "id"));
    if (contextId === null) return null;
    return (
      describeAssignmentRole(
        context,
        { kind: "context", contextId },
        path.slice(3),
      ) ?? {
        // Not an assignment field. The context itself is the use site: a shape
        // refusal mounted on the context — an absent `placement`, a malformed
        // routing policy — reads identically wherever it was authored, and an
        // array index is not what an author calls the context.
        useSite: `the context "${escapeDiagnosticValue(contextId)}"`,
        profile: null,
      }
    );
  }
  return null;
}

/** `<schema message> Use site: the context "x" validator assignment "y", agent profile builtin:z.` */
function withUseSite(
  message: string,
  body: unknown,
  path: readonly PropertyKey[],
): string {
  const site = describeIssueUseSite(body, path);
  if (!site) return message;
  const profile =
    site.profile !== null ? `, agent profile ${site.profile}` : "";
  return `${message} Use site: ${site.useSite}${profile}.`;
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
  options: WorkflowPlanValidationOptions = {},
): WorkflowPlanValidationResult {
  // Before the Zod parse: the strict assignment schema refuses a pre-cutover
  // singleton with "unrecognized keys", which names neither the use site nor
  // the shape to write. Running the located detector first turns that into the
  // actionable refusal R3.2 requires — and it is a refusal, never a rewrite.
  const legacyAgentShapes = findLegacyAgentShapes(rawBody);
  if (legacyAgentShapes.length > 0) {
    return { ok: false, issues: legacyAgentShapes };
  }

  const parsed = workflowDefinitionMutationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: withUseSite(issue.message, rawBody, issue.path),
      })),
    };
  }

  const structural = validateAuthoredDefinition(parsed.data.definition);
  const commandSelectionErrors = options.validationCommandPreflight
    ? collectValidationCommandIssues(
        parsed.data.definition,
        options.validationCommandPreflight,
      )
    : [];
  if (!structural.ok || commandSelectionErrors.length > 0) {
    const errors = [...structural.errors, ...commandSelectionErrors];
    const hasOversizedCommand = errors.some(
      (error) => error.code === VALIDATION_COST_EXCEEDS_LIMIT_CODE,
    );
    return {
      ok: false,
      ...(hasOversizedCommand
        ? { code: VALIDATION_COST_EXCEEDS_LIMIT_CODE }
        : {}),
      issues: errors.map((error) => ({
        path: structuralIssuePath(error, parsed.data.definition),
        message: error.message,
      })),
      ...(commandSelectionErrors.length === 0
        ? {}
        : {
            commandIssues: commandSelectionErrors.map((error) => ({
              code: error.code,
              path: structuralIssuePath(error, parsed.data.definition),
              message: error.message,
            })),
          }),
    };
  }

  // This is the ONE place prose acceptance criteria become records (#69
  // change 4 stage 1): the accepted draft is what create/replace persist and
  // what a launch seeds from, while stored/working-definition parses stay
  // tolerant unions so a reload never rewrites a stored shape
  // (no-read-renormalization). The semantic lints read THIS value rather than
  // the raw parse, so a prose criterion is judged as the single record the
  // context will actually run with.
  const canonicalDefinition = {
    ...parsed.data.definition,
    executionContexts: parsed.data.definition.executionContexts.map(
      (context) => ({
        ...context,
        acceptanceCriteria: criterionRecordsOf(context.acceptanceCriteria),
      }),
    ),
  };

  return {
    ok: true,
    draft: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      definition: canonicalDefinition,
      layout: parsed.data.layout,
    },
    warnings: [
      ...lintGuardEnumCoverage(
        parsed.data.definition.executionContexts,
        parsed.data.definition.edges,
      ).map((warning) => ({
        path: structuralIssuePath(warning, parsed.data.definition),
        message: warning.message,
      })),
      ...lintPlanSemantics(canonicalDefinition),
    ],
  };
}
