import { NextResponse } from "next/server";
import {
  WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
  WorkflowAssignmentReferenceError,
} from "@/lib/workflow-graph/assignment-references";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";

export function assignmentReferenceRefusalBody(
  issues: readonly WorkflowPlanIssue[],
) {
  return {
    error: "Workflow assignment references are invalid",
    code: WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
    issues,
  };
}

/**
 * The one acceptance-time refusal for an unresolvable assignment reference.
 *
 * `cctl workflow validate` is advisory — a profile can be deleted between the
 * check and the write — so ACCEPTANCE is where a reference error actually
 * reaches most authors, and it has to arrive as the same located issues
 * validate rendered: the qualified `tier:id` and the exact use site, one line
 * per offending reference.
 *
 * Every write surface funnels its catch through here (definition and template
 * create/replace, and the targeted-edit persist on both tiers) so no path can
 * degrade the payload to a joined message string, or — as the replace path
 * did by treating any persist failure as a missing id — to a 404.
 */
export function assignmentReferenceRefusal(error: unknown): Response | null {
  if (!(error instanceof WorkflowAssignmentReferenceError)) return null;
  return NextResponse.json(assignmentReferenceRefusalBody(error.issues), {
    status: 400,
  });
}
