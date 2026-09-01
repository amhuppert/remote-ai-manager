import { describe, expect, it } from "vitest";

import {
  maximalPlanDocument,
  maximalWorkflowLaunch,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { seedDeliveryPlanFromLast } from "./delivery-plan-seed";

describe("seedDeliveryPlanFromLast", () => {
  it("copies the approved direct authored launch wholesale while stripping server fields and retaining only still-selected claims", () => {
    const prior = maximalPlanDocument();
    const approvedLaunch = structuredClone(maximalWorkflowLaunch());
    approvedLaunch.name = "Approved launch with guarded topology and loops";
    approvedLaunch.definition.origin = {
      sourceUri: "spec-plan://spec-1/attempts/attempt-1/candidates/candidate-1",
      label: "Server-finalized delivery candidate",
    };
    approvedLaunch.definition.lockedRegions = [
      {
        paths: ["/charter"],
        sourceUri:
          "spec-plan://spec-1/attempts/attempt-1/candidates/candidate-1",
        reason: "The candidate governs this region.",
        instruction: "Reopen the plan before changing governance.",
      },
    ];
    approvedLaunch.definition.approvalRequired = true;
    approvedLaunch.definition.charter.sourcesOfTruth.push(
      {
        rank: 3,
        id: "native-sdd-pinned-spec",
        label: "Pinned spec",
        type: "spec",
        locator: ".cc/graph-workflow-docs/spec/delivery-plan.md",
        description: "Server-injected pinned spec source.",
        accessPolicy: "worktree-relative",
      },
      {
        rank: 4,
        id: "native-sdd-claims",
        label: "Candidate claims",
        type: "document",
        locator: ".cc/graph-workflow-docs/spec-bindings/candidate-1/claims.md",
        description: "Server-injected candidate claims source.",
        accessPolicy: "worktree-relative",
      },
    );
    // A context-scoped charter invariant: the field SDD never interprets and
    // the graph alone resolves. Seeding must carry it across byte-for-byte,
    // including its appliesTo scope, or the next attempt silently widens a
    // narrow invariant to the whole graph.
    approvedLaunch.definition.charter.invariants = [
      ...(approvedLaunch.definition.charter.invariants ?? []),
      {
        id: "graph-after-envelope-canary",
        statement:
          "The scoped canary survives every hop without an SDD projection change",
        appliesTo: { contextIds: ["fixture-followup"] },
      },
    ];
    const liveEditedWorkingLaunch = structuredClone(approvedLaunch);
    liveEditedWorkingLaunch.name = "Live-edited execution working graph";
    liveEditedWorkingLaunch.definition.edges = [];
    liveEditedWorkingLaunch.definition.loopGroups = [];

    const source = {
      candidateId: "candidate-1",
      launch: approvedLaunch,
      binding: {
        dispositions: prior.binding.dispositions,
        claims: [
          ...prior.binding.claims,
          {
            contextId: "fixture-followup",
            criterionElementIds: ["criterion-removed"],
          },
        ],
      },
      runtimeWorkingLaunch: liveEditedWorkingLaunch,
    };
    const seeded = seedDeliveryPlanFromLast({
      source,
      dispositions: [
        {
          criterionElementId: "criterion-selected",
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-new",
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
        {
          criterionElementId: "criterion-reaffirmed",
          disposition: "delivered_elsewhere",
          deliveredByExecutionId: "execution-delivery-plan-earlier",
        },
      ],
    });

    expect(seeded.launch.name).toBe(approvedLaunch.name);
    expect(seeded.launch.definition.edges).toEqual(
      approvedLaunch.definition.edges,
    );
    expect(seeded.launch.definition.loopGroups).toEqual(
      approvedLaunch.definition.loopGroups,
    );
    expect(seeded.launch.definition.edges).not.toEqual(
      liveEditedWorkingLaunch.definition.edges,
    );
    expect(seeded.launch.definition.loopGroups).not.toEqual(
      liveEditedWorkingLaunch.definition.loopGroups,
    );
    expect(seeded.launch.definition).not.toHaveProperty("origin");
    expect(seeded.launch.definition).not.toHaveProperty("lockedRegions");
    expect(seeded.launch.definition).not.toHaveProperty("approvalRequired");
    expect(
      seeded.launch.definition.charter.sourcesOfTruth.map(
        (source) => source.id,
      ),
    ).toEqual(["design-doc", "acceptance-criteria"]);
    // Scoped invariant and authored layout are graph-owned payload: seeding
    // copies them, it does not re-derive or normalize them.
    expect(seeded.launch.definition.charter.invariants).toEqual(
      approvedLaunch.definition.charter.invariants,
    );
    expect(
      seeded.launch.definition.charter.invariants?.find(
        (invariant) => invariant.id === "graph-after-envelope-canary",
      )?.appliesTo,
    ).toEqual({ contextIds: ["fixture-followup"] });
    expect(seeded.launch.layout).toEqual(approvedLaunch.layout);
    expect(seeded.binding.dispositions).toEqual([
      {
        criterionElementId: "criterion-selected",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-new",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-reaffirmed",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: "execution-delivery-plan-earlier",
      },
    ]);
    expect(seeded.binding.claims).toEqual([
      {
        contextId: "fixture-context",
        criterionElementIds: ["criterion-selected"],
      },
    ]);
  });
});
