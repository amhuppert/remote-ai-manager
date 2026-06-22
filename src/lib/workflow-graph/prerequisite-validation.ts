import {
  isAbsolutePath,
  normalizeSkillReference,
  pathHasParentSegment,
  type WorkflowGraphValidationError,
  type WorkflowPrerequisite,
} from "@/lib/workflows/schemas";

import { containsPlaceholderOpener } from "./parameter-validation";

// Every text field a single prerequisite carries, scanned for `{{...}}` (R4.10).
// A prerequisite is literal/environment-level, so NO field is ever a substitution
// target — the path/skill identifier and the optional label are all scanned.
function prerequisiteTextFields(prerequisite: WorkflowPrerequisite): string[] {
  const fields: string[] = [];
  if (prerequisite.kind === "path") {
    fields.push(prerequisite.path);
  } else {
    fields.push(prerequisite.skill);
  }
  if (prerequisite.label !== undefined) {
    fields.push(prerequisite.label);
  }
  return fields;
}

// Structural identifier + placeholder checks for one prerequisite. Each emitted
// error carries the same `field` locator (`prerequisites[<index>]`) so the
// offending prerequisite is identified by its position in the declared list.
// Inputs are assumed to already parse against the `.strict()` prerequisiteSchema
// (so unmodeled fields and a `backend` on a `path` variant are already rejected);
// the unknown-kind / missing-identifier guards below defend the choke point
// against crafted or legacy data that bypassed that parse.
function validatePrerequisite(
  prerequisite: WorkflowPrerequisite,
  index: number,
): WorkflowGraphValidationError[] {
  const locator = `prerequisites[${index}]`;
  const errors: WorkflowGraphValidationError[] = [];

  if (prerequisite.kind !== "path" && prerequisite.kind !== "skill") {
    errors.push({
      code: "prerequisite-unknown-kind",
      message: `Prerequisite at ${locator} has an unknown kind; the supported kinds are "path" and "skill"`,
      field: locator,
    });
    return errors;
  }

  if (prerequisite.kind === "path") {
    if (
      typeof prerequisite.path !== "string" ||
      prerequisite.path.trim().length === 0
    ) {
      errors.push({
        code: "prerequisite-missing-identifier",
        message: `Path prerequisite at ${locator} must declare a non-empty path`,
        field: locator,
      });
    } else if (
      isAbsolutePath(prerequisite.path) ||
      pathHasParentSegment(prerequisite.path)
    ) {
      errors.push({
        code: "prerequisite-path-not-worktree-relative",
        message: `Path prerequisite at ${locator} ('${prerequisite.path}') must be worktree-relative: absolute paths and '..' parent-directory segments are rejected`,
        field: locator,
      });
    }
  }

  if (prerequisite.kind === "skill") {
    if (
      typeof prerequisite.skill !== "string" ||
      prerequisite.skill.trim().length === 0
    ) {
      errors.push({
        code: "prerequisite-missing-identifier",
        message: `Skill prerequisite at ${locator} must declare a non-empty skill reference`,
        field: locator,
      });
    } else if (normalizeSkillReference(prerequisite.skill).length === 0) {
      errors.push({
        code: "prerequisite-empty-skill-reference",
        message: `Skill prerequisite at ${locator} ('${prerequisite.skill}') normalizes to an empty reference`,
        field: locator,
      });
    }
  }

  for (const value of prerequisiteTextFields(prerequisite)) {
    if (typeof value === "string" && containsPlaceholderOpener(value)) {
      errors.push({
        code: "prerequisite-contains-placeholder",
        message: `Prerequisite at ${locator} contains a '{{...}}' placeholder; prerequisites are literal/environment-level declarations and are never a substitution target`,
        field: locator,
      });
    }
  }

  return errors;
}

/**
 * Accept-time SHAPE validation for declared prerequisites. Collects every
 * violation (does not short-circuit) in declaration order, returning
 * graph-validation-shaped errors so it composes with `validateWorkflowDefinition`
 * at the same storage choke point.
 *
 * This layer enforces the STRUCTURAL rules the `.strict()` `prerequisiteSchema`
 * does not own at parse time: known kind + non-empty identifier (R4.2, R4.4),
 * non-empty normalized skill reference (R4.2b), worktree-relative path policy
 * (R4.8, mirrored from the schema refinement so the validation layer enforces it
 * too), and rejection of any `{{...}}` occurrence in any prerequisite field
 * (R4.10) — reusing the SAME `{{...}}` detection (`containsPlaceholderOpener`) the
 * upstream placeholder lint uses so the two lints stay consistent. Each error
 * carries a `prerequisites[<index>]` locator. The function takes only the
 * prerequisite list, so it is inherently tier-agnostic and applies identically to
 * global and project definitions (R4.6).
 */
export function validatePrerequisites(
  prerequisites: WorkflowPrerequisite[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  prerequisites.forEach((prerequisite, index) => {
    errors.push(...validatePrerequisite(prerequisite, index));
  });
  return errors;
}
