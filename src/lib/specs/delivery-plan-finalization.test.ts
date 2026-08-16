import { describe, expect, it } from "vitest";

import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import {
  finalizeAndAdmitDeliveryPlanLaunch,
  finalizeDeliveryPlanLaunch,
} from "./delivery-plan-finalization";

const INPUT = {
  specId: "spec-finalization",
  specSlug: "direct-plan",
  attemptId: "attempt-finalization",
} as const;

describe("delivery-plan candidate finalization", () => {
  it("allocates the candidate before injecting every server-owned field and admitting the full launch", async () => {
    const events: string[] = [];
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    launch.definition.charter.sourcesOfTruth = [
      {
        rank: 1,
        id: "authored-primary",
        label: "Authored primary",
        type: "document",
        locator: "docs/primary.md",
        description: "Primary authored source.",
        accessPolicy: "worktree-relative",
      },
      {
        rank: 4,
        id: "authored-secondary",
        label: "Authored secondary",
        type: "document",
        locator: "docs/secondary.md",
        description: "Secondary authored source.",
        accessPolicy: "worktree-relative",
      },
    ];

    const result = await finalizeAndAdmitDeliveryPlanLaunch(
      { ...INPUT, launch },
      {
        allocateCandidateId() {
          events.push("allocate");
          return "candidate-finalization";
        },
        async admitLaunch(finalized) {
          events.push("admit");
          expect(finalized).toEqual(
            finalizeDeliveryPlanLaunch({
              ...INPUT,
              candidateId: "candidate-finalization",
              launch,
            }),
          );
          return {
            ok: true as const,
            launch: finalized,
            warnings: [],
            stableAccountabilityContextIds: ["context-implement"],
            accountabilityGroupAnalysis: [],
          };
        },
      },
    );

    expect(events).toEqual(["allocate", "admit"]);
    expect(result.candidateId).toBe("candidate-finalization");
    expect(result.admission.ok).toBe(true);
  });

  it("prepends ranked candidate sources without changing authored relative ranks", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    launch.definition.charter.sourcesOfTruth = [
      {
        rank: 1,
        id: "authored-primary",
        label: "Authored primary",
        type: "document",
        locator: "docs/primary.md",
        description: "Primary authored source.",
        accessPolicy: "worktree-relative",
      },
      {
        rank: 4,
        id: "authored-secondary",
        label: "Authored secondary",
        type: "document",
        locator: "docs/secondary.md",
        description: "Secondary authored source.",
        accessPolicy: "worktree-relative",
      },
    ];

    const finalized = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-finalization",
      launch,
    });

    expect(finalized.definition.charter.sourcesOfTruth).toEqual([
      expect.objectContaining({
        id: "native-sdd-pinned-spec",
        rank: 1,
        locator: ".cc/graph-workflow-docs/spec/direct-plan.md",
      }),
      expect.objectContaining({
        id: "native-sdd-claims",
        rank: 2,
        locator:
          ".cc/graph-workflow-docs/spec-bindings/candidate-finalization/claims.md",
      }),
      expect.objectContaining({ id: "authored-primary", rank: 3 }),
      expect.objectContaining({ id: "authored-secondary", rank: 6 }),
    ]);
  });

  it("injects a candidate-id origin, exactly two parseable locks, and disabled graph approval", () => {
    const finalized = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-finalization",
      launch: createMaximalAuthoredWorkflowLaunchFixture(),
    });
    const sourceUri =
      "spec-plan://spec-finalization/attempts/attempt-finalization/candidates/candidate-finalization";

    expect(finalized.definition.origin).toEqual({ sourceUri });
    expect(finalized.definition.approvalRequired).toBe(false);
    expect(finalized.definition.lockedRegions).toEqual([
      {
        paths: ["/charter"],
        sourceUri,
        reason: "The signed native SDD candidate owns workflow governance.",
        instruction:
          "Before launch, reopen and re-propose the plan; during a run, use the audited charter-amendment act.",
      },
      {
        paths: ["/origin", "/approvalRequired"],
        sourceUri,
        reason:
          "The signed native SDD candidate owns provenance and approval policy.",
        instruction:
          "Before launch, reopen and re-propose the plan; after launch, replace the execution.",
      },
    ]);
  });
});
