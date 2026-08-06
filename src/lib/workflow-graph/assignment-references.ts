/**
 * The one assignment-reference check every authored surface runs.
 *
 * Assignment errors split across the two validation layers by what they need to
 * answer them. Shape and grammar (malformed id, empty enabled cohort, duplicate
 * ids, bad strategy) are answerable from the value alone and stay in the
 * synchronous schema/structural layer. Reference EXISTENCE and the tier-scope
 * rule need the profile library and the project the document belongs to, so
 * they run here — async, project-scope-aware, and shared by all four surfaces
 * that can accept an assignment:
 *
 *   1. `storage.ts` accept-time validation (project definitions AND global
 *      templates, each with its own scope),
 *   2. the `graph-workflow/validate` route the planning CLI calls,
 *   3. execution start, which re-checks immediately before seeding so a profile
 *      deleted after validate still fails closed rather than seeding a hole,
 *   4. the global config PUT path, whose `workflowDefaults` are a global-scope
 *      document and are otherwise never checked against the library at all.
 *
 * Surfaces 2 and 3 run BOTH checks — the authored document and the current
 * `workflowDefaults`. A definition inherits staffing it never mentions, so a
 * profile deleted out from under the defaults is invisible to
 * {@link AssignmentReferenceChecker.checkDefinition} and would otherwise
 * surface as an unlocated resolve failure inside snapshot seeding, naming no
 * field to fix (R15).
 *
 * Every one of them gets the same located {@link WorkflowPlanIssue}, so a
 * planning agent sees one uniform contract regardless of which surface refused.
 */

import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import {
  formatAgentProfileRef,
  type AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { escapeDiagnosticValue } from "@/lib/shared/diagnostic-text";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import type { AgentAssignment, ValidatorCohort } from "./config-schemas";
import type { WorkflowSemanticDefinition } from "./definition-schemas";

/**
 * Which tier of document is being checked. The project scope carries the
 * opaque project path the library resolves the project tier against; the
 * global scope has no project, which is exactly why it cannot reference one.
 */
export type AssignmentDocumentScope =
  | { kind: "project"; projectPath: string }
  | { kind: "global" };

/**
 * One reference and where it was authored. `path` is the JSON location an
 * editor can jump to; `useSite` is the human phrasing the message carries so a
 * refusal reads the same whether it arrives from the CLI, a route, or a log.
 *
 * `tier` and `dormant` are structured rather than folded into `useSite` because
 * the deletion-preview reporter consumes the SAME traversal this checker does
 * and has to answer "which context" and "is this dormant" as data. One
 * traversal, two consumers: what validation refuses and what a delete preview
 * enumerates cannot drift apart.
 */
export interface AssignmentReferenceSite {
  path: string;
  useSite: string;
  ref: AgentProfileRef;
  tier: AssignmentTierLabel;
  /** Held by an assignment inside a DISABLED cohort — persisted, not invoked. */
  dormant: boolean;
}

/** The cascade tier an assignment was authored at. */
export type AssignmentTierLabel =
  | { kind: "workflow" }
  | { kind: "global-defaults" }
  | { kind: "context"; contextId: string };

/**
 * Which staffing slot within that tier — or the cohort itself.
 *
 * `assignmentId` is nullable because the shape layer can be describing an
 * assignment whose id is the very thing that is missing or malformed. The JSON
 * path still locates it; the phrasing simply drops the quoted id rather than
 * inventing one.
 */
export type AssignmentRoleLabel =
  | { kind: "implementer"; assignmentId: string | null }
  | { kind: "validator"; assignmentId: string | null }
  | { kind: "cohort" };

/**
 * The one phrasing of an assignment use site.
 *
 * Shared with the SYNCHRONOUS shape layer (`plan-validation.ts`) on purpose:
 * an author must not be able to tell which of the two validation layers refused
 * from how the refusal reads. Every message that names a use site — dangling
 * reference, scope violation, duplicate id, malformed grammar — routes through
 * here, so the vocabulary cannot drift between them.
 *
 * Quoted values are escaped here rather than at the call sites: the shape layer
 * is fed unvalidated ids by definition, and an escape that has to be remembered
 * is one that will eventually be forgotten.
 */
export function formatAssignmentUseSite(
  tier: AssignmentTierLabel,
  role: AssignmentRoleLabel,
): string {
  const tierText =
    tier.kind === "context"
      ? `context "${escapeDiagnosticValue(tier.contextId)}"`
      : tier.kind === "workflow"
        ? "workflow-tier"
        : "global-defaults";
  const roleText =
    role.kind === "cohort"
      ? "validator cohort"
      : role.assignmentId === null
        ? `${role.kind} assignment`
        : `${role.kind} assignment "${escapeDiagnosticValue(role.assignmentId)}"`;
  return `the ${tierText} ${roleText}`;
}

export interface AssignmentReferenceCheckerDeps {
  library?: AgentProfileLibraryService;
}

export interface AssignmentReferenceChecker {
  /**
   * Every assignment reference in an authored workflow definition — workflow
   * tier and per-context, implementer and cohort — checked against `scope`.
   */
  checkDefinition(
    definition: WorkflowSemanticDefinition,
    scope: AssignmentDocumentScope,
    basePath?: string,
  ): Promise<WorkflowPlanIssue[]>;
  /**
   * The global `workflowDefaults` block. Always global scope: these defaults
   * apply to every project, so a project-tier reference in them would be
   * unresolvable in all but one.
   */
  checkWorkflowDefaults(
    defaults: Partial<WorkflowDefaults> | undefined,
    basePath?: string,
  ): Promise<WorkflowPlanIssue[]>;
}

export function createAssignmentReferenceChecker(
  deps: AssignmentReferenceCheckerDeps = {},
): AssignmentReferenceChecker {
  const library = deps.library ?? createAgentProfileLibraryService();

  async function check(
    sites: readonly AssignmentReferenceSite[],
    scope: AssignmentDocumentScope,
  ): Promise<WorkflowPlanIssue[]> {
    const projectPath = scope.kind === "project" ? scope.projectPath : null;
    const issues: WorkflowPlanIssue[] = [];

    for (const site of sites) {
      const qualified = formatAgentProfileRef(site.ref);

      // The scope rule is checked BEFORE resolution and independently of it: a
      // project-tier reference in a global document is wrong even when that
      // profile exists in some project, because no other project can reach it.
      if (scope.kind === "global" && site.ref.tier === "project") {
        issues.push({
          path: site.path,
          message: `A global-scope workflow document may not reference the project-tier profile ${qualified}. Project profiles exist only inside their own project, so ${site.useSite} would be unresolvable in every other project — reference a builtin or global profile instead, or save this document under a project.`,
        });
        continue;
      }

      try {
        await library.resolve(projectPath, site.ref);
      } catch {
        issues.push({
          path: site.path,
          message: `Agent profile ${qualified} referenced by ${site.useSite} could not be resolved. It does not exist, was deleted, or is quarantined.`,
        });
      }
    }

    return issues;
  }

  return {
    checkDefinition: (definition, scope, basePath = "definition") =>
      check(collectDefinitionReferenceSites(definition, basePath), scope),
    checkWorkflowDefaults: (defaults, basePath = "workflowDefaults") =>
      check(collectDefaultsReferenceSites(defaults, basePath), {
        kind: "global",
      }),
  };
}

// ============================================================
// Traversal
// ============================================================

function implementerSite(
  implementer: AgentAssignment | undefined,
  basePath: string,
  tier: AssignmentTierLabel,
): AssignmentReferenceSite[] {
  if (!implementer) return [];
  return [
    {
      path: `${basePath}.profile`,
      useSite: formatAssignmentUseSite(tier, {
        kind: "implementer",
        assignmentId: implementer.id,
      }),
      ref: implementer.profile,
      tier,
      dormant: false,
    },
  ];
}

/**
 * Every assignment in a cohort, INCLUDING the dormant ones a disabled cohort
 * retains. A dormant assignment is persisted configuration that execution start
 * snapshots and a later edit can enable without touching the library, so a
 * dangling dormant reference has to fail at authoring — by the time it is
 * enabled there is no library lookup left to catch it.
 */
function cohortSites(
  cohort: ValidatorCohort | undefined,
  basePath: string,
  tier: AssignmentTierLabel,
): AssignmentReferenceSite[] {
  if (!cohort) return [];
  return cohort.assignments.map((assignment, index) => ({
    path: `${basePath}.assignments.${index}.profile`,
    useSite: formatAssignmentUseSite(tier, {
      kind: "validator",
      assignmentId: assignment.id,
    }),
    ref: assignment.profile,
    tier,
    dormant: !cohort.enabled,
  }));
}

export function collectDefinitionReferenceSites(
  definition: WorkflowSemanticDefinition,
  basePath: string,
): AssignmentReferenceSite[] {
  const workflowConfig = definition.workflowConfig ?? {};
  const sites: AssignmentReferenceSite[] = [
    ...implementerSite(
      workflowConfig.implementer,
      `${basePath}.workflowConfig.implementer`,
      { kind: "workflow" },
    ),
    ...cohortSites(
      workflowConfig.contextValidator,
      `${basePath}.workflowConfig.contextValidator`,
      { kind: "workflow" },
    ),
  ];

  for (const [index, context] of definition.executionContexts.entries()) {
    const contextPath = `${basePath}.executionContexts.${index}`;
    const tier: AssignmentTierLabel = {
      kind: "context",
      contextId: context.id,
    };
    sites.push(
      ...implementerSite(
        context.implementer,
        `${contextPath}.implementer`,
        tier,
      ),
      ...cohortSites(
        context.contextValidator,
        `${contextPath}.contextValidator`,
        tier,
      ),
    );
  }

  return sites;
}

export function collectDefaultsReferenceSites(
  defaults: Partial<WorkflowDefaults> | undefined,
  basePath: string,
): AssignmentReferenceSite[] {
  if (!defaults) return [];
  return [
    ...implementerSite(defaults.implementer, `${basePath}.implementer`, {
      kind: "global-defaults",
    }),
    ...cohortSites(defaults.contextValidator, `${basePath}.contextValidator`, {
      kind: "global-defaults",
    }),
  ];
}

// ============================================================
// Refusal
// ============================================================

/**
 * A refusal carrying located issues, for the surfaces whose failure path is a
 * thrown error rather than a returned result (storage accept, execution start).
 */
export class WorkflowAssignmentReferenceError extends Error {
  readonly code = "workflow_assignment_reference_invalid" as const;

  constructor(readonly issues: readonly WorkflowPlanIssue[]) {
    super(
      issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") ||
        "Workflow assignment references are invalid",
    );
    this.name = "WorkflowAssignmentReferenceError";
  }
}
