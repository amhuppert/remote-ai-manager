import { describe, expect, it } from "vitest";

import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import { projectDeliveryPlanDraftHealth } from "./delivery-plan-health";
import type { DeliveryPlanBinding } from "./delivery-plan";
import type { SpecRevisionSnapshot } from "./schemas";

const NOW = "2026-08-15T12:00:00.000Z";
const SPEC_ID = "spec-health";
const REVISION_ID = "revision-health";

function pinnedRevision(): SpecRevisionSnapshot {
  const criteria = ["criterion-one", "criterion-two"];
  return {
    revision: {
      id: REVISION_ID,
      specId: SPEC_ID,
      number: 1,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:pinned",
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    elements: [
      {
        element: {
          id: "requirement-one",
          specId: SPEC_ID,
          kind: "requirement" as const,
          number: 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: REVISION_ID,
          elementId: "requirement-one",
          position: 0,
          payload: {
            kind: "requirement" as const,
            statement: "The plan reports what it owes.",
            priority: "must" as const,
            risk: "high" as const,
          },
          payloadHash: "sha256:requirement-one",
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      ...criteria.map((criterionId, index) => ({
        element: {
          id: criterionId,
          specId: SPEC_ID,
          kind: "criterion" as const,
          number: index + 1,
          parentElementId: "requirement-one",
          createdAt: NOW,
        },
        version: {
          revisionId: REVISION_ID,
          elementId: criterionId,
          position: index + 1,
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
      })),
    ],
  };
}

function admitted(
  overrides: Partial<
    Extract<AuthoredWorkflowLaunchAdmissionResult, { ok: true }>
  > = {},
): AuthoredWorkflowLaunchAdmissionResult {
  return {
    ok: true,
    launch: createMaximalAuthoredWorkflowLaunchFixture(),
    warnings: [],
    stableAccountabilityContextIds: ["context-build"],
    accountabilityGroupAnalysis: [
      {
        bindingKey: "criterion-one",
        claimantContextIds: ["context-build"],
        stableExistingClaimantContextIds: ["context-build"],
        mustRunClaimantContextIds: ["context-build"],
        covered: true,
      },
    ],
    ...overrides,
  };
}

function binding(
  overrides: Partial<DeliveryPlanBinding> = {},
): DeliveryPlanBinding {
  return {
    dispositions: [
      {
        criterionElementId: "criterion-one",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-two",
        disposition: "deferred",
        deliveredByExecutionId: null,
      },
    ],
    claims: [
      { contextId: "context-build", criterionElementIds: ["criterion-one"] },
    ],
    ...overrides,
  };
}

describe("projectDeliveryPlanDraftHealth", () => {
  it("reports nothing owed when the binding lints clean", () => {
    const health = projectDeliveryPlanDraftHealth({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(),
    });

    expect(health.findings).toEqual([]);
    expect(health.unresolved).toEqual([]);
  });

  it("reports the unclaimed selected criterion propose refuses on", () => {
    const health = projectDeliveryPlanDraftHealth({
      pinnedRevision: pinnedRevision(),
      binding: binding({ claims: [] }),
      admission: admitted({
        accountabilityGroupAnalysis: [
          {
            bindingKey: "criterion-one",
            claimantContextIds: [],
            stableExistingClaimantContextIds: [],
            mustRunClaimantContextIds: [],
            covered: false,
          },
        ],
      }),
    });

    expect(health.findings.map((finding) => finding.ruleId)).toEqual([
      "binding/selected-criterion-unclaimed",
      "binding/selected-criterion-not-must-run",
    ]);
    expect(
      health.findings.every((finding) => finding.severity === "blocks_propose"),
    ).toBe(true);
    expect(health.findings[0]?.elementHandle).toBe("R1.1");
    expect(health.unresolved).toEqual([
      {
        criterionElementId: "criterion-one",
        handle: "R1.1",
        disposition: "in_scope",
        resolution:
          "Claim it from a stable authored accountability context, or defer, waive, or attribute it in the binding.",
      },
    ]);
  });

  it("names the human act a pending reaffirmation owes", () => {
    const health = projectDeliveryPlanDraftHealth({
      pinnedRevision: pinnedRevision(),
      binding: binding({
        dispositions: [
          {
            criterionElementId: "criterion-one",
            disposition: "in_scope",
            deliveredByExecutionId: null,
          },
          {
            criterionElementId: "criterion-two",
            disposition: "pending_reaffirmation",
            deliveredByExecutionId: "execution-earlier",
          },
        ],
      }),
      admission: admitted(),
    });

    expect(health.findings.map((finding) => finding.ruleId)).toEqual([
      "binding/pending-reaffirmation",
    ]);
    expect(health.unresolved).toEqual([
      {
        criterionElementId: "criterion-two",
        handle: "R1.2",
        disposition: "pending_reaffirmation",
        resolution:
          "Reaffirm it in Spec Studio, or select it for re-delivery in this plan.",
      },
    ]);
  });

  it("reports a refused graph launch as the blocking finding", () => {
    const health = projectDeliveryPlanDraftHealth({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: {
        ok: false,
        issues: [
          {
            path: "definition.executionContexts",
            message: "A launch needs at least one execution context.",
          },
        ],
      },
    });

    expect(health.findings).toEqual([
      {
        ruleId: "launch/not-admissible",
        severity: "blocks_propose",
        elementHandle: "definition.executionContexts",
        message: "A launch needs at least one execution context.",
      },
    ]);
    expect(health.unresolved).toEqual([]);
  });

  it("reports the admitted launch's graph advisories without blocking propose", () => {
    const health = projectDeliveryPlanDraftHealth({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted({
        warnings: [
          {
            path: "definition.executionContexts[0].outputSchema.properties.verdict.enum",
            message:
              'Source context "context-spawner" branches on "verdict" but no outgoing edge covers "defer"; add a branch for those values or an else edge',
          },
        ],
      }),
    });

    expect(health.findings).toEqual([
      {
        ruleId: "launch/advisory",
        severity: "advisory",
        elementHandle:
          "definition.executionContexts[0].outputSchema.properties.verdict.enum",
        message:
          'Source context "context-spawner" branches on "verdict" but no outgoing edge covers "defer"; add a branch for those values or an else edge',
      },
    ]);
    expect(health.refusalConditions).toEqual([]);
    expect(health.unresolved).toEqual([]);
  });

  it("keeps blocking binding findings ahead of advisories", () => {
    const health = projectDeliveryPlanDraftHealth({
      pinnedRevision: pinnedRevision(),
      binding: binding({ claims: [] }),
      admission: admitted({
        warnings: [{ path: "definition.edges", message: "An advisory." }],
        accountabilityGroupAnalysis: [
          {
            bindingKey: "criterion-one",
            claimantContextIds: [],
            stableExistingClaimantContextIds: [],
            mustRunClaimantContextIds: [],
            covered: false,
          },
        ],
      }),
    });

    expect(health.findings.map((finding) => finding.severity)).toEqual([
      "blocks_propose",
      "blocks_propose",
      "advisory",
    ]);
    expect(health.refusalConditions).toHaveLength(2);
  });
});
