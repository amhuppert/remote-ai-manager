import { describe, expect, it } from "vitest";

import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  deliveryPlanBindingAccountabilityGroups,
  lintDeliveryPlanBinding,
  deriveDeliveryPlanClaims,
} from "./delivery-plan-binding-lint";
import type { SpecRevisionSnapshot } from "./schemas";

const NOW = "2026-08-15T12:00:00.000Z";

function pinnedRevision(): SpecRevisionSnapshot {
  return {
    revision: {
      id: "revision-binding",
      specId: "spec-binding",
      number: 1,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:binding",
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "0".repeat(64),
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    assumptionCitations: [],
    elements: ["criterion-selected", "criterion-deferred"].map(
      (criterionId, index) => ({
        element: {
          id: criterionId,
          specId: "spec-binding",
          kind: "criterion" as const,
          number: index + 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: "revision-binding",
          elementId: criterionId,
          position: index,
          payload: {
            kind: "criterion" as const,
            text: criterionId,
            validationStrategy: { kinds: ["test_run" as const] },
          },
          payloadHash: `sha256:${criterionId}`,
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ),
  };
}

function binding(): DeliveryPlanBinding {
  return {
    dispositions: [
      {
        criterionElementId: "criterion-selected",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-deferred",
        disposition: "deferred",
        deliveredByExecutionId: null,
      },
    ],
  };
}

function admitted(
  input: { covers?: string[]; stableIds?: string[]; covered?: boolean } = {},
): Extract<AuthoredWorkflowLaunchAdmissionResult, { ok: true }> {
  const launch = createMaximalAuthoredWorkflowLaunchFixture();
  launch.definition.executionContexts = launch.definition.executionContexts.map(
    (context, index) =>
      index === 0
        ? {
            ...context,
            id: "context-implement",
            acceptanceCriteria: [
              {
                id: "observable-outcome",
                statement: "The observable outcome holds.",
                covers: input.covers ?? ["criterion-selected"],
              },
            ],
          }
        : context,
  );
  return {
    ok: true,
    launch,
    warnings: [],
    stableAccountabilityContextIds: input.stableIds ?? ["context-implement"],
    accountabilityGroupAnalysis: [
      {
        bindingKey: "criterion-selected",
        claimantContextIds: ["context-implement"],
        stableExistingClaimantContextIds: input.stableIds ?? [
          "context-implement",
        ],
        mustRunClaimantContextIds:
          input.covered === false ? [] : ["context-implement"],
        covered: input.covered ?? true,
      },
    ],
  };
}

function codes(candidateBinding = binding(), admission = admitted()): string[] {
  return lintDeliveryPlanBinding({
    pinnedRevision: pinnedRevision(),
    binding: candidateBinding,
    admission,
  }).map((issue) => issue.code);
}

describe("delivery-plan binding lint", () => {
  it("accepts selected coverage authored on context criteria without authored claims", () => {
    expect(codes()).toEqual([]);
    expect(
      deliveryPlanBindingAccountabilityGroups(
        binding(),
        admitted().launch.definition,
      ),
    ).toEqual([
      {
        bindingKey: "criterion-selected",
        claimantContextIds: ["context-implement"],
      },
    ]);
  });

  it.each([
    ["coverage/selected-criterion-uncovered", { covers: [] }],
    ["coverage/unknown-id", { covers: ["missing"] }],
    ["coverage/unselected", { covers: ["criterion-deferred"] }],
    ["coverage/unstable-context", { stableIds: [] }],
    ["coverage/not-must-run", { covered: false }],
  ])("locates %s and clears it with corrected coverage", (code, input) => {
    const admission = admitted(input);
    const issues = lintDeliveryPlanBinding({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission,
    });
    expect(issues).toContainEqual(expect.objectContaining({ code }));
    expect(issues.every((issue) => issue.path[0] === "definition")).toBe(true);
    expect(codes(binding(), admitted())).not.toContain(code);
  });

  it("names a stable context whose criteria cover no selected spec criterion as plan-authored", () => {
    // The context keeps its records but none carries `covers`: the plan, not
    // the spec, decided what this context owes. That is legitimate for a
    // foundation context and worth a second look in every case, so it is an
    // advisory with a null criterion, never a refusal.
    const issues = lintDeliveryPlanBinding({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted({ covers: [] }),
    });
    expect(issues).toContainEqual({
      code: "coverage/plan-authored-context",
      path: ["definition", "executionContexts", 0, "acceptanceCriteria"],
      criterionElementId: null,
      message:
        "Context context-implement owns no selected spec criterion: its 1 acceptance criterion (observable-outcome) is plan-authored. Justify each plan-authored obligation against the design or the charter, or add covers.",
    });
    expect(codes(binding(), admitted())).not.toContain(
      "coverage/plan-authored-context",
    );
  });

  it("deduplicates repeated coverage and permits multiple contexts to cover one criterion", () => {
    const admission = admitted({
      covers: ["criterion-selected", "criterion-selected"],
    });
    const context = admission.launch.definition.executionContexts[0];
    if (!context) throw new Error("fixture requires an authored context");
    admission.launch.definition.executionContexts.push({
      ...context,
      id: "context-verify",
    });
    expect(
      deriveDeliveryPlanClaims(binding(), admission.launch.definition),
    ).toEqual([
      {
        contextId: "context-implement",
        criterionElementIds: ["criterion-selected"],
      },
      {
        contextId: "context-verify",
        criterionElementIds: ["criterion-selected"],
      },
    ]);
  });

  it("derives only selected coverage in graph-declared stable contexts", () => {
    const admission = admitted({
      covers: ["criterion-selected", "criterion-deferred", "missing"],
    });
    expect(
      deriveDeliveryPlanClaims(binding(), admission.launch.definition, []),
    ).toEqual([]);
    expect(
      deriveDeliveryPlanClaims(binding(), admission.launch.definition),
    ).toEqual([
      {
        contextId: "context-implement",
        criterionElementIds: ["criterion-selected"],
      },
    ]);
  });

  it("preserves the disposition integrity findings", () => {
    const selected = binding().dispositions[0];
    if (!selected) throw new Error("fixture requires a selected disposition");
    expect(codes({ dispositions: [] })).toContain(
      "binding/disposition-missing",
    );
    expect(
      codes({ dispositions: [...binding().dispositions, selected] }),
    ).toContain("binding/disposition-duplicate");
    expect(
      codes({
        dispositions: [
          ...binding().dispositions,
          { ...selected, criterionElementId: "missing" },
        ],
      }),
    ).toContain("binding/disposition-criterion-unknown");
    expect(
      codes({
        dispositions: [{ ...selected, disposition: "pending_reaffirmation" }],
      }),
    ).toContain("binding/pending-reaffirmation");
    expect(
      codes({ dispositions: [{ ...selected, disposition: "reaffirmed" }] }),
    ).toContain("binding/reaffirmed-without-delivery");
  });

  it("names covering records and the always-run closeout remedy", () => {
    const issues = lintDeliveryPlanBinding({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted({ covered: false }),
    });
    const message = issues.find(
      (issue) => issue.code === "coverage/not-must-run",
    )?.message;
    expect(message).toContain("context-implement/observable-outcome");
    expect(message).toContain("always-run closeout");
  });
});
