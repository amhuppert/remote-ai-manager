import { describe, expect, it } from "vitest";

import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import {
  dedupeServerOwnedDeliveryPlanSources,
  finalizeAndAdmitDeliveryPlanLaunch,
  finalizeDeliveryPlanLaunch,
} from "./delivery-plan-finalization";

const INPUT = {
  specId: "spec-finalization",
  specSlug: "direct-plan",
  pinnedRevisionId: "revision-finalization",
  attemptId: "attempt-finalization",
} as const;

describe("delivery-plan candidate finalization", () => {
  it("gives every context its own spec source above the full audit anchor without access policies", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    const finalized = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-finalization",
      launch,
    });
    const sources = finalized.definition.charter.sourcesOfTruth;
    const global = sources.find(
      (source) => source.id === "native-sdd-pinned-spec",
    );
    for (const context of launch.definition.executionContexts) {
      const excerpt = sources.find(
        (source) =>
          source.locator ===
          `.cc/graph-workflow-docs/spec/direct-plan/${context.id}.md`,
      );
      expect(excerpt).toMatchObject({
        appliesTo: { contextIds: [context.id] },
      });
      expect(excerpt?.rank).toBeLessThan(global?.rank ?? 0);
      expect(excerpt).not.toHaveProperty("accessPolicy");
    }
    expect(global).not.toHaveProperty("accessPolicy");
    expect(
      sources.find((source) => source.id === "native-sdd-claims"),
    ).not.toHaveProperty("accessPolicy");
  });
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

    const contextCount = launch.definition.executionContexts.length;
    expect(
      finalized.definition.charter.sourcesOfTruth.slice(contextCount),
    ).toEqual([
      expect.objectContaining({
        id: "native-sdd-pinned-spec",
        rank: contextCount + 1,
        locator: ".cc/graph-workflow-docs/spec/direct-plan.md",
      }),
      expect.objectContaining({
        id: "native-sdd-claims",
        rank: contextCount + 2,
        locator:
          ".cc/graph-workflow-docs/spec-bindings/candidate-finalization/claims.md",
      }),
      expect.objectContaining({
        id: "authored-primary",
        rank: contextCount + 3,
      }),
      expect.objectContaining({
        id: "authored-secondary",
        rank: contextCount + 6,
      }),
    ]);
  });

  it("injects a candidate-id origin, exactly two parseable locks, and disabled graph approval", () => {
    const finalized = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-finalization",
      launch: createMaximalAuthoredWorkflowLaunchFixture(),
    });
    const sourceUri =
      "spec-plan://spec-finalization/revisions/revision-finalization/attempts/attempt-finalization/candidates/candidate-finalization";

    expect(finalized.definition.origin).toEqual({ sourceUri });
    expect(finalized.definition.approvalRequired).toBe(false);
    expect(finalized.definition.lockedRegions).toEqual([
      {
        paths: ["/charter"],
        sourceUri,
        reason: "The signed native SDD candidate owns workflow governance.",
        instruction:
          "Before launch, reopen the plan and have the revised draft signed off; during a run, use the audited charter-amendment act.",
      },
      {
        paths: ["/origin", "/approvalRequired"],
        sourceUri,
        reason:
          "The signed native SDD candidate owns provenance and approval policy.",
        instruction:
          "Before launch, reopen the plan and have the revised draft signed off; after launch, replace the execution.",
      },
    ]);
  });

  it("leaves the charter unlocked at the draft stage so the authoring surfaces can replace it", () => {
    const finalized = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-finalization",
      launch: createMaximalAuthoredWorkflowLaunchFixture(),
      stage: "draft",
    });
    const sourceUri =
      "spec-plan://spec-finalization/revisions/revision-finalization/attempts/attempt-finalization/candidates/candidate-finalization";

    expect(finalized.definition.origin).toEqual({ sourceUri });
    expect(finalized.definition.approvalRequired).toBe(false);
    expect(finalized.definition.lockedRegions).toEqual([
      expect.objectContaining({
        paths: ["/origin", "/approvalRequired"],
        sourceUri,
      }),
    ]);
    expect(
      finalized.definition.charter.sourcesOfTruth.map((s) => s.id),
    ).toEqual(
      expect.arrayContaining(["native-sdd-pinned-spec", "native-sdd-claims"]),
    );
  });

  it("re-finalizes an already finalized launch without duplicating the server-owned sources", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    const authoredIds = launch.definition.charter.sourcesOfTruth.map(
      (source) => source.id,
    );
    const candidate = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-one",
      launch,
    });

    const reopened = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-two",
      launch: candidate,
      stage: "draft",
    });
    const refrozen = finalizeDeliveryPlanLaunch({
      ...INPUT,
      candidateId: "candidate-two",
      launch: reopened,
    });

    for (const definition of [reopened.definition, refrozen.definition]) {
      expect(definition.charter.sourcesOfTruth.map((s) => s.id)).toEqual([
        ...definition.executionContexts.map(
          (context) => `native-sdd-context-${context.id}`,
        ),
        "native-sdd-pinned-spec",
        "native-sdd-claims",
        ...authoredIds,
      ]);
      expect(definition.charter.sourcesOfTruth.map((s) => s.rank)).toEqual(
        definition.charter.sourcesOfTruth.map((_, index) => index + 1),
      );
      expect(
        definition.charter.sourcesOfTruth.find(
          (s) => s.id === "native-sdd-claims",
        )?.locator,
      ).toBe(".cc/graph-workflow-docs/spec-bindings/candidate-two/claims.md");
    }
    expect(refrozen.definition.lockedRegions?.map((l) => l.paths)).toEqual([
      ["/charter"],
      ["/origin", "/approvalRequired"],
    ]);
  });
});

describe("dedupeServerOwnedDeliveryPlanSources", () => {
  const pinned = {
    rank: 1,
    id: "native-sdd-pinned-spec",
    locator: ".cc/graph-workflow-docs/spec/direct-plan.md",
  };
  const claims = {
    rank: 2,
    id: "native-sdd-claims",
    locator: ".cc/graph-workflow-docs/spec-bindings/c-1/claims.md",
  };
  const authored = { rank: 3, id: "design-doc", locator: "docs/design.md" };

  it("keeps the first copy of each server-owned source and every authored one", () => {
    expect(
      dedupeServerOwnedDeliveryPlanSources([
        pinned,
        claims,
        authored,
        { ...pinned, rank: 9 },
        { ...claims, rank: 10 },
      ]),
    ).toEqual([pinned, claims, authored]);
  });

  it("passes a plan that omits the server-owned pair through unchanged", () => {
    expect(dedupeServerOwnedDeliveryPlanSources([authored])).toEqual([
      authored,
    ]);
  });
});
