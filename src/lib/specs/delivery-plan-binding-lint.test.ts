import { describe, expect, it } from "vitest";

import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  deliveryPlanBindingAccountabilityGroups,
  lintDeliveryPlanBinding,
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
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
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
    claims: [
      {
        contextId: "context-implement",
        criterionElementIds: ["criterion-selected"],
      },
    ],
  };
}

function admitted(
  input: {
    stableIds?: string[];
    covered?: boolean;
    mustRunIds?: string[];
  } = {},
): Extract<AuthoredWorkflowLaunchAdmissionResult, { ok: true }> {
  return {
    ok: true,
    launch: createMaximalAuthoredWorkflowLaunchFixture(),
    warnings: [],
    stableAccountabilityContextIds: input.stableIds ?? ["context-implement"],
    accountabilityGroupAnalysis: [
      {
        bindingKey: "criterion-selected",
        claimantContextIds: ["context-implement"],
        stableExistingClaimantContextIds:
          input.stableIds?.includes("context-implement") === false
            ? []
            : ["context-implement"],
        mustRunClaimantContextIds:
          input.mustRunIds ??
          (input.covered === false ? [] : ["context-implement"]),
        covered: input.covered ?? true,
      },
    ],
  };
}

function codes(
  candidateBinding: DeliveryPlanBinding,
  admission = admitted(),
): string[] {
  return lintDeliveryPlanBinding({
    pinnedRevision: pinnedRevision(),
    binding: candidateBinding,
    admission,
  }).map((issue) => issue.code);
}

describe("delivery-plan binding lint", () => {
  it("accepts one disposition per criterion and one stable must-run claimant per selected criterion", () => {
    expect(codes(binding())).toEqual([]);
    expect(deliveryPlanBindingAccountabilityGroups(binding())).toEqual([
      {
        bindingKey: "criterion-selected",
        claimantContextIds: ["context-implement"],
      },
    ]);
  });

  it.each([
    [
      "missing disposition",
      () => ({
        ...binding(),
        dispositions: binding().dispositions.slice(0, 1),
      }),
      "binding/disposition-missing",
    ],
    [
      "duplicate disposition",
      () => ({
        ...binding(),
        dispositions: [...binding().dispositions, binding().dispositions[0]!],
      }),
      "binding/disposition-duplicate",
    ],
    [
      "unknown disposition criterion",
      () => ({
        ...binding(),
        dispositions: [
          ...binding().dispositions,
          {
            criterionElementId: "criterion-unknown",
            disposition: "deferred" as const,
            deliveredByExecutionId: null,
          },
        ],
      }),
      "binding/disposition-criterion-unknown",
    ],
    [
      "selected criterion without a claim",
      () => ({ ...binding(), claims: [] }),
      "binding/selected-criterion-unclaimed",
    ],
    [
      "claim for an unknown criterion",
      () => ({
        ...binding(),
        claims: [
          {
            contextId: "context-implement",
            criterionElementIds: ["criterion-unknown"],
          },
        ],
      }),
      "binding/claim-criterion-unknown",
    ],
    [
      "claim for an unselected criterion",
      () => ({
        ...binding(),
        claims: [
          {
            contextId: "context-implement",
            criterionElementIds: ["criterion-deferred"],
          },
        ],
      }),
      "binding/claim-criterion-unselected",
    ],
    [
      "duplicate claim record",
      () => ({
        ...binding(),
        claims: [...binding().claims, binding().claims[0]!],
      }),
      "binding/claim-context-duplicate",
    ],
    [
      "duplicate criterion in one claim",
      () => ({
        ...binding(),
        claims: [
          {
            contextId: "context-implement",
            criterionElementIds: ["criterion-selected", "criterion-selected"],
          },
        ],
      }),
      "binding/claim-criterion-duplicate",
    ],
  ])("refuses %s", (_label, arrange, expectedCode) => {
    expect(codes(arrange())).toContain(expectedCode);
  });

  it("refuses a claimant absent from graph-declared stable authored sources", () => {
    expect(codes(binding(), admitted({ stableIds: [] }))).toContain(
      "binding/claim-context-unstable",
    );
  });

  it("refuses a selected criterion without a graph-owned conservative must-run claimant", () => {
    expect(codes(binding(), admitted({ covered: false }))).toContain(
      "binding/selected-criterion-not-must-run",
    );
  });

  it("imposes no validator, placement, commit, script, evidence-kind, loop, or generated-lineage modality", () => {
    const admission = admitted();
    admission.launch.definition.executionContexts =
      admission.launch.definition.executionContexts.map((context) =>
        context.id === "context-implement"
          ? {
              ...context,
              placement: { lane: "review", mode: "readOnly" as const },
              contextValidator: { enabled: false, assignments: [] },
              scriptValidator: { commands: [] },
            }
          : context,
      );

    expect(codes(binding(), admission)).toEqual([]);
  });
});
