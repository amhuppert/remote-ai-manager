import { describe, expect, it } from "vitest";

import { isEarlierMergedDelivery } from "@/lib/specs/delivery-gate";
import type { SpecExecutionRow } from "@/lib/specs/schemas";
import {
  specDetailViewSchema,
  specGateAdmissionViewSchema,
  type SpecExecutionView,
} from "@/lib/specs/view-schemas";

import {
  approvedAwaitingProofSpecControlsDetailFixture,
  denseSpecControlsDetailFixture,
  draftingSpecControlsDetailFixture,
  policyAdmissionViewFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";

/**
 * Spec Studio renders whatever `/api/specs/.../detail` returns, so these
 * fixtures are only evidence if they are the same shape as that payload. The
 * snake_case-to-camelCase execution/admission migration reached the server
 * while these fixtures kept the old shape, which left every component test
 * green against a surface that was broken in the running app. Parsing through
 * the response schema is what makes the next server-side shape change fail
 * here instead of diverging silently.
 */
describe("spec-studio fixtures", () => {
  it.each([
    { name: "no execution", detail: specControlsDetailFixture() },
    {
      name: "definition review",
      detail: specControlsDetailFixture("definition_review"),
    },
    { name: "running", detail: specControlsDetailFixture("running") },
    {
      name: "dense running",
      detail: denseSpecControlsDetailFixture("running"),
    },
    {
      name: "dense no execution",
      detail: denseSpecControlsDetailFixture("none"),
    },
    { name: "drafting", detail: draftingSpecControlsDetailFixture("design") },
  ])("conforms to the spec detail response schema ($name)", ({ detail }) => {
    const parsed = specDetailViewSchema.safeParse(detail);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("builds policy admissions in the gate-admission response shape", () => {
    const parsed = specGateAdmissionViewSchema.safeParse(
      policyAdmissionViewFixture(),
    );

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  // Structural Zod parsing cannot see cross-row invariants, and a fixture
  // whose state the live route can never emit is this repository's known
  // failure mode. The assertions below run the PRODUCTION rules over the
  // fixture rows.
  it("dense running fixture's delivered_elsewhere row satisfies the gate's own prior-run rule", () => {
    const detail = denseSpecControlsDetailFixture("running");
    const current = detail.executions.find((run) => run.id === "execution-1");
    const disposition = detail.criterionDispositions.find(
      (row) =>
        row.execution_id === "execution-1" &&
        row.criterion_element_id === "criterion-4",
    );
    if (current === undefined || disposition === undefined) {
      throw new Error("Dense fixture rows missing");
    }
    const repo = {
      findExecutionById(id: string) {
        const view = detail.executions.find((run) => run.id === id);
        return view === undefined ? null : executionRowFromView(view);
      },
      findCriterionDisposition(executionId: string, criterionId: string) {
        return (
          detail.criterionDispositions.find(
            (row) =>
              row.execution_id === executionId &&
              row.criterion_element_id === criterionId,
          ) ?? null
        );
      },
    };

    expect(disposition.disposition).toBe("delivered_elsewhere");
    expect(
      isEarlierMergedDelivery(repo, executionRowFromView(current), disposition),
    ).toBe(true);
  });

  it("approved-awaiting-proof fixture parses and carries a complete human delivery admission", () => {
    const detail = approvedAwaitingProofSpecControlsDetailFixture();
    const parsed = specDetailViewSchema.safeParse(detail);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);

    const deliveryAdmissions = detail.gateAdmissions.filter(
      (admission) => admission.gate === "delivery",
    );
    expect(deliveryAdmissions).toHaveLength(1);
    // Production human gate admission always persists a real approval id and
    // the parsed human actor; a basis-only mutation is unreachable state.
    for (const admission of deliveryAdmissions) {
      expect(admission.basis).toBe("human_approval");
      expect(admission.approvalId).not.toBeNull();
      expect(admission.actor).toEqual({ kind: "human" });
    }
  });
});

/**
 * The view-to-row adapter the gate-rule assertions need: the detail response
 * carries executions in the domain view shape while the gate reads repository
 * rows.
 */
function executionRowFromView(view: SpecExecutionView): SpecExecutionRow {
  return {
    id: view.id,
    spec_id: view.specId,
    revision_id: view.revisionId,
    scope_json: JSON.stringify(view.scope),
    state: view.state,
    execution_start_dial:
      view.definitionApprovalRequired === true ? "gate" : null,
    workflow_definition_id: view.workflowDefinitionId,
    workflow_definition_revision: null,
    workflow_execution_id: view.workflowExecutionId,
    session_name: view.sessionName,
    delivered_at: view.deliveredAt,
    abandoned_reason: view.abandonedReason,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}
