import { escapeDiagnosticValue } from "@/lib/shared/diagnostic-text";

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
 * Shared with the synchronous shape layer (`plan-validation.ts`): an author
 * must not be able to tell which validation layer refused from how the refusal
 * reads. Every message that names a use site routes through here, so the
 * vocabulary cannot drift between them.
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
