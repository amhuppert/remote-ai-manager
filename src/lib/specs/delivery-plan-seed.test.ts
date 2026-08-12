import { describe, expect, it } from "vitest";

import {
  DELIVERY_PLAN_DISPOSITIONS,
  deliveryPlanDocumentSchema,
  emptyDeliveryPlanDocument,
  pinnedSpecDocumentPath,
  withPinnedSpecSource,
  PINNED_SPEC_SOURCE_ID,
  type DeliveryPlanDocument,
  type DeliveryPlanSourceOfTruth,
} from "./delivery-plan";
import { deliveryPlanDraftHealth } from "./delivery-plan-lint";
import {
  discoveryTaskId,
  seedDeliveryPlanDocument,
  type PlanSeedCriterion,
  type PlanSeedDiscovery,
} from "./delivery-plan-seed";

const PINNED_REVISION_ID = "revision-2";
const BASIS_EXECUTION_ID = "execution-1";
const SPEC_SLUG = "native-sdd";

/**
 * One criterion per delivery class, so every assertion below reads against a
 * fixture that exercises the whole classification rather than the two classes
 * a given rule happens to care about.
 */
const CRITERIA: PlanSeedCriterion[] = [
  {
    criterionElementId: "c-fresh",
    handle: "R1.1",
    deliveryClass: "delivered_and_fresh",
  },
  { criterionElementId: "c-soft", handle: "R1.2", deliveryClass: "soft_stale" },
  { criterionElementId: "c-hard", handle: "R1.3", deliveryClass: "hard_stale" },
  {
    criterionElementId: "c-new",
    handle: "R2.1",
    deliveryClass: "never_delivered",
  },
  {
    criterionElementId: "c-deferred",
    handle: "R2.2",
    deliveryClass: "deferred",
  },
  { criterionElementId: "c-waived", handle: "R2.3", deliveryClass: "waived" },
];

function priorPlan(): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...emptyDeliveryPlanDocument(),
    dispositions: CRITERIA.map((criterion) => ({
      criterionElementId: criterion.criterionElementId,
      disposition: "selected",
      deliveredByExecutionId: null,
      reaffirmation: null,
      note: null,
    })),
    contexts: [
      {
        contextId: "ctx-alpha",
        title: "Alpha",
        contextType: "delivery",
        // `c-fresh` seeds as delivered_elsewhere, so carrying the context
        // forward must not carry its ownership of an unselected criterion.
        criterionElementIds: ["c-hard", "c-fresh"],
        acceptanceContract: ["Alpha is observable."],
        proofPlan: [
          {
            criterionElementId: "c-hard",
            evidenceKinds: ["validator_verdict"],
            note: "re-prove",
          },
          {
            criterionElementId: "c-fresh",
            evidenceKinds: ["validator_verdict"],
            note: "already proved",
          },
        ],
      },
      {
        contextId: "ctx-done",
        title: "Everything here landed",
        contextType: "delivery",
        criterionElementIds: ["c-fresh"],
        acceptanceContract: ["Done."],
        proofPlan: [],
      },
      {
        contextId: "ctx-closeout",
        title: "Closeout",
        contextType: "closeout",
        criterionElementIds: [],
        acceptanceContract: ["The branch merges green."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-alpha-1",
        contextId: "ctx-alpha",
        title: "First",
        instructions: "Do the first thing.",
        order: 0,
        contributesToCriterionElementIds: ["c-hard"],
      },
      {
        taskId: "task-alpha-2",
        contextId: "ctx-alpha",
        title: "Second",
        instructions: "Do the second thing.",
        order: 1,
        contributesToCriterionElementIds: ["c-hard", "c-gone"],
      },
      {
        taskId: "task-done-1",
        contextId: "ctx-done",
        title: "Landed",
        instructions: "Already delivered.",
        order: 0,
        contributesToCriterionElementIds: ["c-fresh"],
      },
    ],
    edges: [
      {
        edgeId: "edge-alpha-closeout",
        fromContextId: "ctx-alpha",
        toContextId: "ctx-closeout",
      },
      {
        edgeId: "edge-done-closeout",
        fromContextId: "ctx-done",
        toContextId: "ctx-closeout",
      },
    ],
    wiring: [
      {
        capabilityId: "cap-alpha",
        criterionElementIds: ["c-hard"],
        owner: {
          kind: "call_site",
          contextId: "ctx-alpha",
          locator: "src/lib/a.ts",
        },
      },
      {
        capabilityId: "cap-done",
        criterionElementIds: ["c-fresh"],
        owner: { kind: "downstream", contextId: "ctx-done" },
      },
    ],
    policyOverrides: [
      { key: "validation.preMerge", value: "lint", rationale: "fast lane" },
    ],
    touchedSurfaces: ["src/lib/specs/"],
    governance: {
      mission: "Seed the next plan from the last delivery.",
      charterInvariants: [
        {
          id: "exact-approval",
          statement: "Launch uses the approved candidate.",
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "final-design",
          label: "Design",
          type: "document",
          locator: "#47",
          description: "the design",
          appliesTo: null,
          accessPolicy: "external-readonly",
        },
      ],
      validationCommandNames: ["typecheck"],
    },
  });
}

function seed(
  overrides: Partial<Parameters<typeof seedDeliveryPlanDocument>[0]> = {},
): DeliveryPlanDocument {
  return seedDeliveryPlanDocument({
    pinnedRevisionId: PINNED_REVISION_ID,
    specSlug: SPEC_SLUG,
    criteria: CRITERIA,
    deliveredByExecutionId: BASIS_EXECUTION_ID,
    priorPlan: priorPlan(),
    discoveries: [],
    ...overrides,
  });
}

function dispositionOf(
  document: DeliveryPlanDocument,
  criterionElementId: string,
): string | undefined {
  return document.dispositions.find(
    (entry) => entry.criterionElementId === criterionElementId,
  )?.disposition;
}

describe("seedDeliveryPlanDocument", () => {
  it("gives EVERY pinned criterion exactly one disposition", () => {
    const document = seed();

    expect(document.dispositions).toHaveLength(CRITERIA.length);
    expect(
      document.dispositions.map((entry) => entry.criterionElementId).sort(),
    ).toEqual(CRITERIA.map((c) => c.criterionElementId).sort());
    for (const entry of document.dispositions) {
      expect(DELIVERY_PLAN_DISPOSITIONS).toContain(entry.disposition);
    }
  });

  it("maps each delivery class to the disposition the seeding law names", () => {
    const document = seed();

    expect(dispositionOf(document, "c-fresh")).toBe("delivered_elsewhere");
    expect(dispositionOf(document, "c-soft")).toBe("pending_reaffirmation");
    expect(dispositionOf(document, "c-hard")).toBe("selected");
    expect(dispositionOf(document, "c-new")).toBe("selected");
    expect(dispositionOf(document, "c-deferred")).toBe("selected");
    expect(dispositionOf(document, "c-waived")).toBe("waived");
  });

  it("rests an auto-proposed delivered_elsewhere on the delta basis execution", () => {
    const entry = seed().dispositions.find(
      (candidate) => candidate.criterionElementId === "c-fresh",
    );

    expect(entry?.deliveredByExecutionId).toBe(BASIS_EXECUTION_ID);
    expect(entry?.note).toContain(BASIS_EXECUTION_ID);
  });

  it("never asserts a reaffirmation the human has not performed", () => {
    const entry = seed().dispositions.find(
      (candidate) => candidate.criterionElementId === "c-soft",
    );

    expect(entry?.disposition).toBe("pending_reaffirmation");
    expect(entry?.reaffirmation).toBeNull();
  });

  it("selects a fresh delivery when there is no basis execution to rest on", () => {
    const document = seed({ deliveredByExecutionId: null, priorPlan: null });

    expect(dispositionOf(document, "c-fresh")).toBe("selected");
  });

  it("carries forward only the contexts that still own selected criteria", () => {
    const document = seed();

    expect(document.contexts.map((context) => context.contextId)).toEqual([
      "ctx-alpha",
      "ctx-closeout",
    ]);
  });

  it("strips carried ownership and proof steps down to the still-selected criteria", () => {
    const alpha = seed().contexts.find(
      (context) => context.contextId === "ctx-alpha",
    );

    expect(alpha?.criterionElementIds).toEqual(["c-hard"]);
    expect(alpha?.proofPlan.map((step) => step.criterionElementId)).toEqual([
      "c-hard",
    ]);
  });

  it("carries the prior tasks of surviving contexts, renumbered contiguously", () => {
    const document = seed();

    expect(document.tasks.map((task) => task.taskId)).toEqual([
      "task-alpha-1",
      "task-alpha-2",
    ]);
    expect(document.tasks.map((task) => task.order)).toEqual([0, 1]);
  });

  it("drops task provenance the pinned revision no longer carries", () => {
    const task = seed().tasks.find(
      (candidate) => candidate.taskId === "task-alpha-2",
    );

    expect(task?.contributesToCriterionElementIds).toEqual(["c-hard"]);
  });

  it("keeps only the edges and wiring whose endpoints survived", () => {
    const document = seed();

    expect(document.edges.map((edge) => edge.edgeId)).toEqual([
      "edge-alpha-closeout",
    ]);
    expect(document.wiring.map((entry) => entry.capabilityId)).toEqual([
      "cap-alpha",
    ]);
  });

  it("carries governance, policy overrides, and touched surfaces forward whole", () => {
    const document = seed();
    const prior = priorPlan();

    // Governance comes forward authored. The one entry the seed installs is
    // the reserved pinned-spec source, which carried entries rank below.
    expect(document.governance.mission).toEqual(prior.governance.mission);
    expect(document.governance.charterInvariants).toEqual(
      prior.governance.charterInvariants,
    );
    expect(document.governance.validationCommandNames).toEqual(
      prior.governance.validationCommandNames,
    );
    expect(document.governance.sourcesOfTruth.slice(1)).toEqual(
      prior.governance.sourcesOfTruth.map((entry) => ({
        ...entry,
        rank: entry.rank + 1,
      })),
    );
    expect(document.policyOverrides).toEqual(prior.policyOverrides);
    expect(document.touchedSurfaces).toEqual(prior.touchedSurfaces);
  });

  it("lands a discovery on the context that owns the criterion it covers", () => {
    const discovery: PlanSeedDiscovery = {
      discoveryId: "discovery-1",
      title: "Handle the empty case",
      instructions: "The prior run found the empty case unhandled.",
      coveredCriterionElementIds: ["c-hard"],
    };

    const document = seed({ discoveries: [discovery] });
    const landed = document.tasks.filter(
      (task) => task.contextId === "ctx-alpha",
    );

    expect(landed.map((task) => task.title)).toEqual([
      "First",
      "Second",
      "Handle the empty case",
    ]);
    expect(landed.map((task) => task.order)).toEqual([0, 1, 2]);
  });

  it("stages an unowned discovery in a typed context with no invented contract", () => {
    const discovery: PlanSeedDiscovery = {
      discoveryId: "discovery-2",
      title: "Unowned follow-up",
      instructions: "Nothing selected covers this yet.",
      coveredCriterionElementIds: [],
    };

    const document = seed({ discoveries: [discovery] });
    const staged = document.contexts.find(
      (context) =>
        context.criterionElementIds.length === 0 &&
        context.contextType === "integration",
    );

    expect(staged).toBeDefined();
    // An empty contract is what makes lint say "author what this context must
    // make observable" — the seed stages the work without manufacturing one.
    expect(staged?.acceptanceContract).toEqual([]);
    expect(
      document.tasks.filter((task) => task.contextId === staged?.contextId),
    ).toHaveLength(1);
  });

  it("does not re-place a discovery the prior plan already carries", () => {
    const discovery: PlanSeedDiscovery = {
      discoveryId: "discovery-3",
      title: "Handle the empty case",
      instructions: "The prior run found the empty case unhandled.",
      coveredCriterionElementIds: ["c-hard"],
    };
    // The plan that carried it forward IS the record that it was taken up, so
    // a second seed over the same discovery must not duplicate the work.
    const carried = seed({ discoveries: [discovery] });

    const again = seed({
      priorPlan: deliveryPlanDocumentSchema.parse(carried),
      discoveries: [discovery],
    });

    expect(
      again.tasks.filter(
        (task) => task.taskId === discoveryTaskId("discovery-3"),
      ),
    ).toHaveLength(1);
  });

  it("produces a document the plan schema accepts with no prior plan at all", () => {
    const document = seed({ priorPlan: null, deliveredByExecutionId: null });

    expect(() => deliveryPlanDocumentSchema.parse(document)).not.toThrow();
    expect(document.contexts).toEqual([]);
    expect(document.tasks).toEqual([]);
  });
});

/**
 * D7: the pinned spec is readable from inside every lane because the engine
 * materializes it there, so the plan's rank-1 source of truth must be that
 * file. The seed installs it rather than the author inventing a locator — and
 * a `--seed-from last` plan must not inherit the prior attempt's unreadable
 * spelling, which is the state the audited run shipped in.
 */
describe("pinned-spec source of truth", () => {
  const PRIOR_EXTERNAL_SOURCE: DeliveryPlanSourceOfTruth = {
    rank: 1,
    id: "the-spec",
    label: "The spec",
    type: "spec",
    locator: "cctl spec show native-sdd",
    description: "The approved contract.",
    appliesTo: null,
    accessPolicy: "external-readonly",
  };

  function lintOf(document: DeliveryPlanDocument) {
    return deliveryPlanDraftHealth({
      pinnedRevisionId: PINNED_REVISION_ID,
      specSlug: SPEC_SLUG,
      document,
      pinnedCriteria: [],
      deliveredElsewhereVerdicts: [],
    });
  }

  it("ranks the materialized spec document first on an unseeded plan", () => {
    const document = withPinnedSpecSource(emptyDeliveryPlanDocument(), {
      specSlug: SPEC_SLUG,
      pinnedRevisionId: PINNED_REVISION_ID,
    });
    const first = document.governance.sourcesOfTruth[0];

    expect(first?.rank).toBe(1);
    expect(first?.id).toBe(PINNED_SPEC_SOURCE_ID);
    expect(first?.locator).toBe(pinnedSpecDocumentPath(SPEC_SLUG));
    expect(first?.accessPolicy).toBe("worktree-relative");
    expect(first?.description).toContain(PINNED_REVISION_ID);
    expect(deliveryPlanDocumentSchema.parse(document)).toEqual(document);
  });

  it("installs the same entry on a seeded plan", () => {
    const first = seed().governance.sourcesOfTruth[0];

    expect(first?.id).toBe(PINNED_SPEC_SOURCE_ID);
    expect(first?.locator).toBe(pinnedSpecDocumentPath(SPEC_SLUG));
    expect(first?.accessPolicy).toBe("worktree-relative");
  });

  it("keeps every authored source a prior attempt carried, shifted below it", () => {
    const carried = seed({
      priorPlan: {
        ...priorPlan(),
        governance: {
          ...priorPlan().governance,
          sourcesOfTruth: [
            PRIOR_EXTERNAL_SOURCE,
            {
              rank: 4,
              id: "upstream-protocol",
              label: "Upstream protocol",
              type: "document",
              locator: "https://example.invalid/protocol",
              description: "The wire format.",
              appliesTo: null,
              accessPolicy: "external-readonly",
            },
          ],
        },
      },
    }).governance.sourcesOfTruth;

    expect(carried.map((entry) => entry.id)).toEqual([
      PINNED_SPEC_SOURCE_ID,
      "the-spec",
      "upstream-protocol",
    ]);
    expect(carried.map((entry) => entry.rank)).toEqual([1, 2, 5]);
  });

  it("leaves a seeded plan free of the unreadable-source refusal", () => {
    expect(
      lintOf(seed()).ordered.map((finding) => finding.ruleId),
    ).not.toContain("plan/spec-source-unreadable");
  });

  it("still refuses a carried-forward external spelling of the same spec", () => {
    const document = seed({
      priorPlan: {
        ...priorPlan(),
        governance: {
          ...priorPlan().governance,
          sourcesOfTruth: [PRIOR_EXTERNAL_SOURCE],
        },
      },
    });

    expect(lintOf(document).ordered.map((finding) => finding.ruleId)).toContain(
      "plan/spec-source-unreadable",
    );
  });
});
