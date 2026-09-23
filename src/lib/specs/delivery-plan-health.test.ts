import { describe, expect, it } from "vitest";

import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import {
  projectDeliveryPlanDraftHealth,
  deliveryPlanRefusalRationale,
  LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
  type DeliveryPlanDraftHealthInput,
} from "./delivery-plan-health";
import { renderSeededDeliveryPlanMission } from "./delivery-plan-charter-seed";
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
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "0".repeat(64),
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    assumptionCitations: [],
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
  covers: string[] = ["criterion-one"],
): AuthoredWorkflowLaunchAdmissionResult {
  const launch = createMaximalAuthoredWorkflowLaunchFixture();
  launch.definition.executionContexts = launch.definition.executionContexts.map(
    (context, index) =>
      index === 0
        ? {
            ...context,
            id: "context-build",
            acceptanceCriteria: [
              { id: "outcome", statement: "The outcome holds.", covers },
            ],
          }
        : context,
  );
  return {
    ok: true,
    launch,
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
    ...overrides,
  };
}

const SEEDED_MISSION = "Deliver this specification as pinned at revision 1.";
const DEFINITION_ID = "definition-health";

function seedCharter(): DeliveryPlanDraftHealthInput["draftCharter"] {
  return {
    mission: SEEDED_MISSION,
    sourcesOfTruth: [
      {
        rank: 1,
        id: "native-sdd-pinned-spec",
        label: "Pinned spec revision",
        type: "spec",
        locator: ".cc/graph-workflow-docs/spec/health.md",
        description: "The revision this attempt is pinned to.",
      },
    ],
  };
}

function authoredCharter(): DeliveryPlanDraftHealthInput["draftCharter"] {
  return {
    mission: "Deliver the withheld status line behind the memory gate.",
    sourcesOfTruth: [
      ...seedCharter().sourcesOfTruth,
      {
        rank: 2,
        id: "design-doc",
        label: "Memory design",
        type: "document",
        locator: "docs/designs/memory.md",
        description: "The decided design the launch delivers.",
      },
    ],
  };
}

/**
 * Every case but the charter ones is about the binding, so they run against an
 * authored charter — the charter rule firing everywhere would prove nothing
 * about the finding under test.
 */
function project(
  input: Omit<
    DeliveryPlanDraftHealthInput,
    "draftCharter" | "workflowDefinitionId"
  > &
    Partial<
      Pick<
        DeliveryPlanDraftHealthInput,
        "draftCharter" | "workflowDefinitionId"
      >
    >,
) {
  return projectDeliveryPlanDraftHealth({
    draftCharter: authoredCharter(),
    workflowDefinitionId: DEFINITION_ID,
    ...input,
  });
}

describe("projectDeliveryPlanDraftHealth", () => {
  it("reports nothing owed when the binding lints clean", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(),
    });

    expect(health.findings).toEqual([]);
    expect(health.unresolved).toEqual([]);
  });

  it("counts a selected criterion as claimed only from a stable authored source", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted({ stableAccountabilityContextIds: [] }),
    });

    // The claimant is not among the graph-declared stable authored sources, so
    // the criterion is not claimed however many claim records name it.
    expect(health.findings.map((finding) => finding.ruleId)).toContain(
      "coverage/unstable-context",
    );
    expect(health.claims).toEqual({ selected: 1, claimed: 0, unclaimed: 1 });
  });

  it("counts both sides of the claims ledger when every claimant is stable", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(),
    });

    expect(health.claims).toEqual({ selected: 1, claimed: 1, unclaimed: 0 });
  });

  it("proves no claim at all when the launch is not admissible", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: {
        ok: false,
        issues: [{ path: "definition.contexts", message: "Refused." }],
      },
    });

    // Without an admission nothing says which contexts are stable, so a claim
    // the ledger cannot prove is not one it may count.
    expect(health.claims).toEqual({ selected: 1, claimed: 0, unclaimed: 1 });
  });

  it("reports the unclaimed selected criterion propose refuses on", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(
        {
          accountabilityGroupAnalysis: [
            {
              bindingKey: "criterion-one",
              claimantContextIds: [],
              stableExistingClaimantContextIds: [],
              mustRunClaimantContextIds: [],
              covered: false,
            },
          ],
        },
        [],
      ),
    });

    // Removing the only covers entry leaves the selected criterion unclaimed
    // (a refusal) and makes the context plan-authored (an advisory).
    expect(
      health.findings.map((finding) => [finding.ruleId, finding.severity]),
    ).toEqual([
      ["coverage/selected-criterion-uncovered", "blocks_propose"],
      ["coverage/plan-authored-context", "advisory"],
    ]);
    expect(health.findings[0]?.elementHandle).toBe("R1.1");
    expect(health.refusalConditions).toHaveLength(1);
    expect(health.unresolved).toEqual([
      {
        criterionElementId: "criterion-one",
        handle: "R1.1",
        disposition: "in_scope",
        resolution:
          "Add covers on a criterion in a stable authored context with workflow replace, or change its disposition in Spec Studio.",
      },
    ]);
  });

  it("names the human act a pending reaffirmation owes", () => {
    const health = project({
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
    const health = project({
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

  /**
   * An inadmissible launch used to short-circuit the whole projection, so a
   * seed stub that also failed admission was reported as a graph problem
   * alone — and the moment the graph was fixed the charter refusal appeared
   * for the first time. The governance rule reads the charter, not the graph.
   */
  it("still reports the unauthored charter when the launch is inadmissible", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      draftCharter: seedCharter(),
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

    expect(health.findings.map((finding) => finding.ruleId)).toEqual([
      "launch/not-admissible",
      LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
      LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
    ]);
    expect(
      health.refusalConditions.some((condition) =>
        condition.startsWith("charter.mission:"),
      ),
    ).toBe(true);
  });

  it("names a plan-authored stable context as an advisory that neither refuses nor owes a criterion act", () => {
    // The selection stays covered by another context; context-build simply
    // carries criteria the spec never named.
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(
        {
          stableAccountabilityContextIds: ["context-build", "context-other"],
          accountabilityGroupAnalysis: [
            {
              bindingKey: "criterion-one",
              claimantContextIds: ["context-other"],
              stableExistingClaimantContextIds: ["context-other"],
              mustRunClaimantContextIds: ["context-other"],
              covered: true,
            },
          ],
        },
        [],
      ),
    });

    const advisory = health.findings.find(
      (finding) => finding.ruleId === "coverage/plan-authored-context",
    );
    expect(advisory).toMatchObject({ severity: "advisory" });
    expect(advisory?.message).toContain("context-build");
    expect(advisory?.message).toContain("plan-authored");
    expect(health.refusalConditions).not.toContain(
      expect.stringContaining("plan-authored"),
    );
    expect(
      health.unresolved.map((row) => row.criterionElementId),
    ).not.toContain(null);
  });

  it("reports the admitted launch's graph advisories without blocking propose", () => {
    const health = project({
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

  it("refuses propose while the mission is still the text open seeded", () => {
    // The seed the projection reconstructs is the text `spec plan open` writes,
    // so this fixture cannot drift into asserting against a mission the server
    // would never store.
    expect(SEEDED_MISSION).toBe(
      renderSeededDeliveryPlanMission({ pinnedRevision: pinnedRevision() }),
    );
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(),
      draftCharter: seedCharter(),
    });

    const charterFindings = health.findings.filter(
      (finding) => finding.ruleId === LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
    );
    expect(charterFindings.map((finding) => finding.elementHandle)).toEqual([
      "charter.mission",
      "charter.sourcesOfTruth",
    ]);
    expect(
      charterFindings.every((finding) => finding.severity === "blocks_propose"),
    ).toBe(true);
    expect(charterFindings[0]?.message).toContain(
      `cctl workflow replace ${DEFINITION_ID}`,
    );
    expect(charterFindings[0]?.rationale).toBe(
      "the charter is the governance every implementer and validator reads, and a seed stub would freeze into the signed candidate (#98)",
    );
    expect(health.refusalConditions).toContain(
      `charter.mission: ${charterFindings[0]?.message}`,
    );
    expect(deliveryPlanRefusalRationale(health)).toContain(
      "a seed stub would freeze into the signed candidate",
    );
  });

  it("refuses propose while every charter source is server-owned", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(),
      draftCharter: {
        ...authoredCharter(),
        sourcesOfTruth: seedCharter().sourcesOfTruth,
      },
    });

    expect(
      health.findings.map((finding) => ({
        ruleId: finding.ruleId,
        elementHandle: finding.elementHandle,
      })),
    ).toEqual([
      {
        ruleId: LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
        elementHandle: "charter.sourcesOfTruth",
      },
    ]);
  });

  it("reports nothing once the mission differs and an authored source exists", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
      admission: admitted(),
      draftCharter: authoredCharter(),
    });

    expect(health.findings).toEqual([]);
    expect(deliveryPlanRefusalRationale(health)).toBeUndefined();
  });

  it("states why a claimed criterion must be covered on every path", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
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

    const notMustRun = health.findings.find(
      (finding) => finding.ruleId === "coverage/not-must-run",
    );
    expect(notMustRun?.rationale).toBe(
      "a claimed criterion must be covered on every path so a skipped branch can never waive it silently",
    );
    expect(deliveryPlanRefusalRationale(health)).toBe(
      "a claimed criterion must be covered on every path so a skipped branch can never waive it silently",
    );
  });

  it("keeps blocking binding findings ahead of advisories", () => {
    const health = project({
      pinnedRevision: pinnedRevision(),
      binding: binding(),
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
      "advisory",
    ]);
    expect(health.refusalConditions).toHaveLength(1);
  });
});
