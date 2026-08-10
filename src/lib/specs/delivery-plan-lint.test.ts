import { describe, expect, it } from "vitest";
import type { EarlierMergedDeliveryVerdict } from "./delivery-gate";
import {
  deliveryPlanDocumentSchema,
  emptyDeliveryPlanDocument,
  type DeliveryPlanContext,
  type DeliveryPlanDocument,
  type DeliveryPlanReaffirmation,
} from "./delivery-plan";
import {
  deliveryPlanDraftHealth,
  deliveryPlanProposeRefusal,
  wiringOwnershipForContext,
  type DeliveryPlanLintInput,
  type PlanLintCriterion,
} from "./delivery-plan-lint";

const PINNED_REVISION_ID = "revision-pinned";
const BASE_EXECUTION_ID = "execution-earlier";

function criterion(
  id: string,
  handle: string,
  overrides: Partial<PlanLintCriterion> = {},
): PlanLintCriterion {
  return {
    criterionElementId: id,
    handle,
    deliveryClass: "never_delivered",
    freshness: null,
    ...overrides,
  };
}

const CLOSEOUT_CONTEXT: DeliveryPlanContext = {
  contextId: "ctx-closeout",
  title: "Closeout",
  contextType: "closeout",
  criterionElementIds: [],
  acceptanceContract: ["The branch merges with a green pre-merge run."],
  proofPlan: [],
};

/** Every pinned criterion selected and owned by the single delivery context. */
function cleanDocument(): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...emptyDeliveryPlanDocument(),
    dispositions: [
      {
        criterionElementId: "criterion-a",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-a",
        title: "Deliver A",
        contextType: "delivery",
        criterionElementIds: ["criterion-a"],
        acceptanceContract: ["A is observable."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-a1",
        contextId: "ctx-a",
        title: "Do A",
        instructions: "Implement A.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-a"],
      },
    ],
  });
}

/**
 * The same plan with criterion-a not selected: the delivery context is
 * replaced by a typed closeout context so a legal non-selected disposition
 * leaves no zero-criterion delivery context behind.
 */
function unownedDocument(): DeliveryPlanDocument {
  return { ...cleanDocument(), contexts: [CLOSEOUT_CONTEXT], tasks: [] };
}

function lintInput(
  overrides: Partial<DeliveryPlanLintInput> = {},
): DeliveryPlanLintInput {
  return {
    pinnedRevisionId: PINNED_REVISION_ID,
    document: cleanDocument(),
    pinnedCriteria: [criterion("criterion-a", "R1.1")],
    deliveredElsewhereVerdicts: [],
    ...overrides,
  };
}

function ruleIds(input: DeliveryPlanLintInput): string[] {
  return deliveryPlanDraftHealth(input).ordered.map(
    (finding) => finding.ruleId,
  );
}

function findingFor(input: DeliveryPlanLintInput, ruleId: string) {
  const found = deliveryPlanDraftHealth(input).ordered.find(
    (finding) => finding.ruleId === ruleId,
  );
  if (found === undefined) {
    throw new Error(
      `expected finding ${ruleId}; got ${ruleIds(input).join(", ") || "<none>"}`,
    );
  }
  return found;
}

function withDocument(
  mutate: (document: DeliveryPlanDocument) => DeliveryPlanDocument,
  overrides: Partial<DeliveryPlanLintInput> = {},
): DeliveryPlanLintInput {
  return lintInput({ document: mutate(cleanDocument()), ...overrides });
}

describe("delivery plan draft health", () => {
  it("is clean for a total, singly-owned plan", () => {
    const health = deliveryPlanDraftHealth(lintInput());

    expect(health.total).toBe(0);
    expect(health.blocking).toBe(0);
    expect(deliveryPlanProposeRefusal(health)).toBeNull();
  });

  it("groups and ranks through the shared draftHealth projection", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [{ ...document.contexts[0]!, criterionElementIds: [] }],
    }));

    const health = deliveryPlanDraftHealth(input);

    expect(health.blocking).toBeGreaterThan(0);
    expect(health.counts[0]?.severity).toBe("blocks_propose");
    expect(health.blockingFindings).toEqual(health.groups[0]?.findings);
  });
});

describe("disposition and ownership law over the pinned revision", () => {
  it("refuses a pinned criterion with no disposition and names every choice", () => {
    const input = lintInput({
      pinnedCriteria: [
        criterion("criterion-a", "R1.1"),
        criterion("criterion-b", "R1.2"),
      ],
    });

    const finding = findingFor(input, "plan/disposition-missing");
    expect(finding.elementHandle).toBe("R1.2");
    for (const disposition of [
      "selected",
      "deferred",
      "waived",
      "delivered_elsewhere",
      "reaffirmed",
      "pending_reaffirmation",
    ]) {
      expect(finding.message).toContain(disposition);
    }
  });

  it("keys totality off the pinned revision, not a later evergreen head", () => {
    // The plan is total over the revision the attempt pinned. The identical
    // plan is incomplete only once the PINNED list itself carries more — a
    // criterion the evergreen head gained afterwards never reaches this input.
    expect(ruleIds(lintInput())).toEqual([]);
    expect(
      ruleIds(
        lintInput({
          pinnedCriteria: [
            criterion("criterion-a", "R1.1"),
            criterion("criterion-b", "R1.2"),
          ],
        }),
      ),
    ).toContain("plan/disposition-missing");
  });

  it("refuses two dispositions for one criterion", () => {
    const input = withDocument((document) => ({
      ...document,
      dispositions: [
        ...document.dispositions,
        {
          criterionElementId: "criterion-a",
          disposition: "deferred",
          deliveredByExecutionId: null,
          reaffirmation: null,
          note: null,
        },
      ],
    }));

    expect(findingFor(input, "plan/disposition-duplicate").elementHandle).toBe(
      "R1.1",
    );
  });

  it("refuses a disposition for a criterion the pinned revision does not carry", () => {
    const input = withDocument((document) => ({
      ...document,
      dispositions: [
        ...document.dispositions,
        {
          criterionElementId: "criterion-head-only",
          disposition: "deferred",
          deliveredByExecutionId: null,
          reaffirmation: null,
          note: null,
        },
      ],
    }));

    const finding = findingFor(input, "plan/disposition-unknown-criterion");
    expect(finding.message).toContain("criterion-head-only");
    expect(finding.message).toContain(PINNED_REVISION_ID);
  });

  it("refuses a selected criterion with no owning context", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [{ ...document.contexts[0]!, criterionElementIds: [] }],
    }));

    expect(findingFor(input, "plan/selected-unowned").elementHandle).toBe(
      "R1.1",
    );
  });

  it("refuses a selected criterion owned by two contexts", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [
        document.contexts[0]!,
        {
          contextId: "ctx-b",
          title: "Also deliver A",
          contextType: "delivery",
          criterionElementIds: ["criterion-a"],
          acceptanceContract: ["A is observable twice."],
          proofPlan: [],
        },
      ],
    }));

    const finding = findingFor(input, "plan/selected-multi-owned");
    expect(finding.message).toContain("ctx-a");
    expect(finding.message).toContain("ctx-b");
  });

  it("refuses a non-selected criterion that a context still owns", () => {
    const input = withDocument((document) => ({
      ...document,
      dispositions: [{ ...document.dispositions[0]!, disposition: "deferred" }],
    }));

    const finding = findingFor(input, "plan/nonselected-owned");
    expect(finding.message).toContain("deferred");
    expect(finding.message).toContain("ctx-a");
  });

  it("accepts deferred and waived criteria with zero owners", () => {
    for (const disposition of ["deferred", "waived"] as const) {
      const input = lintInput({
        document: {
          ...unownedDocument(),
          dispositions: [{ ...cleanDocument().dispositions[0]!, disposition }],
        },
      });
      expect(ruleIds(input)).toEqual([]);
    }
  });
});

describe("delivered_elsewhere basis law", () => {
  function deliveredElsewhere(
    verdict: EarlierMergedDeliveryVerdict,
    deliveryClass: PlanLintCriterion["deliveryClass"] = "delivered_and_fresh",
  ): DeliveryPlanLintInput {
    return lintInput({
      document: {
        ...unownedDocument(),
        dispositions: [
          {
            ...cleanDocument().dispositions[0]!,
            disposition: "delivered_elsewhere",
            deliveredByExecutionId: verdict.baseExecutionId,
          },
        ],
      },
      pinnedCriteria: [criterion("criterion-a", "R1.1", { deliveryClass })],
      deliveredElsewhereVerdicts: [
        { criterionElementId: "criterion-a", verdict },
      ],
    });
  }

  it("accepts a fresh criterion whose base the gate accepts", () => {
    expect(
      ruleIds(
        deliveredElsewhere({
          code: "accepted",
          baseExecutionId: BASE_EXECUTION_ID,
        }),
      ),
    ).toEqual([]);
  });

  const REFUSED_VERDICTS = [
    { code: "missing_base", baseExecutionId: null },
    { code: "self_reference", baseExecutionId: BASE_EXECUTION_ID },
    { code: "unknown_base", baseExecutionId: BASE_EXECUTION_ID },
    { code: "foreign_spec", baseExecutionId: BASE_EXECUTION_ID },
    { code: "not_merged", baseExecutionId: BASE_EXECUTION_ID },
    { code: "not_earlier", baseExecutionId: BASE_EXECUTION_ID },
    { code: "base_did_not_deliver", baseExecutionId: BASE_EXECUTION_ID },
  ] as const satisfies readonly EarlierMergedDeliveryVerdict[];

  it.each(REFUSED_VERDICTS)(
    "refuses a $code basis and names the ids",
    (verdict) => {
      const finding = findingFor(
        deliveredElsewhere(verdict),
        "plan/delivered-elsewhere-basis",
      );

      expect(finding.elementHandle).toBe("R1.1");
      expect(finding.message).toContain(
        verdict.baseExecutionId ?? "names no earlier execution",
      );
      expect(finding.message).toContain("criterion-a");
    },
  );

  it.each(["soft_stale", "hard_stale"] as const)(
    "refuses an accepted basis for a %s criterion",
    (deliveryClass) => {
      const finding = findingFor(
        deliveredElsewhere(
          { code: "accepted", baseExecutionId: BASE_EXECUTION_ID },
          deliveryClass,
        ),
        "plan/delivered-elsewhere-stale",
      );

      expect(finding.message).toContain(deliveryClass);
      expect(finding.elementHandle).toBe("R1.1");
    },
  );
});

describe("reaffirmation law", () => {
  const HUMAN_ACT: DeliveryPlanReaffirmation = {
    actor: { kind: "human" },
    at: "2026-08-07T10:00:00.000Z",
    basisRevisionId: "revision-prior",
    basis: [],
  };

  function reaffirmed(
    deliveryClass: PlanLintCriterion["deliveryClass"],
    reaffirmation: DeliveryPlanReaffirmation | null,
  ): DeliveryPlanLintInput {
    return lintInput({
      document: {
        ...unownedDocument(),
        dispositions: [
          {
            ...cleanDocument().dispositions[0]!,
            disposition: "reaffirmed",
            reaffirmation,
          },
        ],
      },
      pinnedCriteria: [criterion("criterion-a", "R1.1", { deliveryClass })],
    });
  }

  it("accepts a soft-stale criterion carrying the audited human act", () => {
    expect(ruleIds(reaffirmed("soft_stale", HUMAN_ACT))).toEqual([]);
  });

  it("refuses reaffirmation of a criterion that is not soft-stale", () => {
    const finding = findingFor(
      reaffirmed("hard_stale", HUMAN_ACT),
      "plan/reaffirmed-not-soft-stale",
    );
    expect(finding.message).toContain("hard_stale");
  });

  it("refuses reaffirmation with no audited act and names where the act lives", () => {
    const finding = findingFor(
      reaffirmed("soft_stale", null),
      "plan/reaffirmed-unattested",
    );
    expect(finding.message).toContain("Spec Studio");
    expect(finding.message).toContain("selected");
  });

  it("refuses reaffirmation attested by an agent rather than a human", () => {
    const finding = findingFor(
      reaffirmed("soft_stale", {
        actor: { kind: "agent", conversationId: "conversation-1" },
        at: "2026-08-07T10:00:00.000Z",
        basisRevisionId: "revision-prior",
        basis: [],
      }),
      "plan/reaffirmed-unattested",
    );
    expect(finding.message).toContain("human");
  });

  it("lets pending_reaffirmation sit in a draft but blocks propose with both resolutions", () => {
    const input = lintInput({
      document: {
        ...unownedDocument(),
        dispositions: [
          {
            ...cleanDocument().dispositions[0]!,
            disposition: "pending_reaffirmation",
          },
        ],
      },
      pinnedCriteria: [
        criterion("criterion-a", "R1.1", { deliveryClass: "soft_stale" }),
      ],
    });

    const finding = findingFor(input, "plan/pending-reaffirmation");
    expect(finding.severity).toBe("blocks_propose");
    expect(finding.message).toContain("reaffirm");
    expect(finding.message).toContain("select");

    const refusal = deliveryPlanProposeRefusal(deliveryPlanDraftHealth(input));
    expect(refusal?.code).toBe("lint_blocked");
    expect(refusal?.unmetConditions.join(" ")).toContain("R1.1");
    expect(refusal?.instruction).toContain("spec plan propose");
  });
});

describe("graph and reference lint", () => {
  it("refuses duplicate context ids", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [document.contexts[0]!, { ...document.contexts[0]! }],
    }));
    expect(findingFor(input, "plan/duplicate-context-id").message).toContain(
      "ctx-a",
    );
  });

  it("refuses duplicate task ids", () => {
    const input = withDocument((document) => ({
      ...document,
      tasks: [document.tasks[0]!, { ...document.tasks[0]!, order: 1 }],
    }));
    expect(findingFor(input, "plan/duplicate-task-id").message).toContain(
      "task-a1",
    );
  });

  it("refuses duplicate edge ids", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [document.contexts[0]!, CLOSEOUT_CONTEXT],
      edges: [
        {
          edgeId: "edge-1",
          fromContextId: "ctx-a",
          toContextId: "ctx-closeout",
        },
        {
          edgeId: "edge-1",
          fromContextId: "ctx-a",
          toContextId: "ctx-closeout",
        },
      ],
    }));
    expect(findingFor(input, "plan/duplicate-edge-id").message).toContain(
      "edge-1",
    );
  });

  it("refuses duplicate task order within a context", () => {
    const input = withDocument((document) => ({
      ...document,
      tasks: [document.tasks[0]!, { ...document.tasks[0]!, taskId: "task-a2" }],
    }));
    expect(findingFor(input, "plan/duplicate-task-order").message).toContain(
      "ctx-a",
    );
  });

  it("refuses non-contiguous task order within a context", () => {
    const input = withDocument((document) => ({
      ...document,
      tasks: [
        document.tasks[0]!,
        { ...document.tasks[0]!, taskId: "task-a2", order: 7 },
      ],
    }));
    expect(
      findingFor(input, "plan/non-contiguous-task-order").message,
    ).toContain("ctx-a");
  });

  it("refuses a task pointing at no context", () => {
    const input = withDocument((document) => ({
      ...document,
      tasks: [{ ...document.tasks[0]!, contextId: "ctx-missing" }],
    }));
    expect(findingFor(input, "plan/dangling-task-context").message).toContain(
      "ctx-missing",
    );
  });

  it("refuses a task contribution naming a criterion outside the pinned revision", () => {
    const input = withDocument((document) => ({
      ...document,
      tasks: [
        {
          ...document.tasks[0]!,
          contributesToCriterionElementIds: ["criterion-ghost"],
        },
      ],
    }));
    expect(
      findingFor(input, "plan/dangling-criterion-reference").message,
    ).toContain("criterion-ghost");
  });

  it("refuses a context owning a criterion outside the pinned revision", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [
        {
          ...document.contexts[0]!,
          criterionElementIds: ["criterion-a", "criterion-ghost"],
        },
      ],
    }));
    expect(
      findingFor(input, "plan/dangling-criterion-reference").message,
    ).toContain("criterion-ghost");
  });

  it("refuses an edge endpoint that is not a context", () => {
    const input = withDocument((document) => ({
      ...document,
      edges: [
        { edgeId: "edge-1", fromContextId: "ctx-a", toContextId: "ctx-gone" },
      ],
    }));
    expect(findingFor(input, "plan/dangling-edge-endpoint").message).toContain(
      "ctx-gone",
    );
  });

  it("refuses a self edge", () => {
    const input = withDocument((document) => ({
      ...document,
      edges: [
        { edgeId: "edge-1", fromContextId: "ctx-a", toContextId: "ctx-a" },
      ],
    }));
    expect(findingFor(input, "plan/self-edge").message).toContain("ctx-a");
  });

  it("refuses an edge cycle and names the contexts on it", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [
        document.contexts[0]!,
        {
          contextId: "ctx-b",
          title: "Integration",
          contextType: "integration",
          criterionElementIds: [],
          acceptanceContract: ["A and B compose."],
          proofPlan: [],
        },
      ],
      edges: [
        { edgeId: "edge-1", fromContextId: "ctx-a", toContextId: "ctx-b" },
        { edgeId: "edge-2", fromContextId: "ctx-b", toContextId: "ctx-a" },
      ],
    }));

    const finding = findingFor(input, "plan/edge-cycle");
    expect(finding.message).toContain("ctx-a");
    expect(finding.message).toContain("ctx-b");
  });

  it("accepts an acyclic multi-context graph", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [document.contexts[0]!, CLOSEOUT_CONTEXT],
      edges: [
        {
          edgeId: "edge-1",
          fromContextId: "ctx-a",
          toContextId: "ctx-closeout",
        },
      ],
    }));
    expect(ruleIds(input)).toEqual([]);
  });

  it("refuses a zero-criterion delivery context but allows a typed one", () => {
    const emptyDelivery = withDocument((document) => ({
      ...document,
      contexts: [{ ...document.contexts[0]!, criterionElementIds: [] }],
      dispositions: [{ ...document.dispositions[0]!, disposition: "deferred" }],
      tasks: [],
    }));
    expect(findingFor(emptyDelivery, "plan/empty-context").message).toContain(
      "ctx-a",
    );

    const typed = withDocument((document) => ({
      ...document,
      contexts: [document.contexts[0]!, CLOSEOUT_CONTEXT],
    }));
    expect(ruleIds(typed)).toEqual([]);
  });

  it("refuses a typed context that carries no contract of its own", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [
        document.contexts[0]!,
        { ...CLOSEOUT_CONTEXT, acceptanceContract: [] },
      ],
    }));
    expect(
      findingFor(input, "plan/typed-context-contract-missing").message,
    ).toContain("ctx-closeout");
  });
});

describe("production wiring ownership", () => {
  function withWiring(
    owner: DeliveryPlanDocument["wiring"][number]["owner"],
    capabilityId = "cap-1",
  ): DeliveryPlanLintInput {
    return withDocument((document) => ({
      ...document,
      wiring: [{ capabilityId, criterionElementIds: ["criterion-a"], owner }],
    }));
  }

  it("accepts a capability resolving to exactly one owning context", () => {
    expect(
      ruleIds(
        withWiring({
          kind: "call_site",
          contextId: "ctx-a",
          locator: "src/lib/specs/service-factory.ts",
        }),
      ),
    ).toEqual([]);
  });

  it("refuses an exported capability whose owner is no context in this plan", () => {
    const input = withWiring({
      kind: "call_site",
      contextId: "ctx-nobody",
      locator: "src/lib/specs/service-factory.ts",
    });

    const finding = findingFor(input, "plan/wiring-owner-unresolved");
    expect(finding.severity).toBe("blocks_propose");
    expect(finding.elementHandle).toBe("cap-1");
    expect(finding.message).toContain("ctx-nobody");
  });

  it("refuses a capability declared twice, which resolves to no single owner", () => {
    const input = withDocument((document) => ({
      ...document,
      contexts: [document.contexts[0]!, CLOSEOUT_CONTEXT],
      wiring: [
        {
          capabilityId: "cap-1",
          criterionElementIds: [],
          owner: { kind: "downstream", contextId: "ctx-a" },
        },
        {
          capabilityId: "cap-1",
          criterionElementIds: [],
          owner: { kind: "downstream", contextId: "ctx-closeout" },
        },
      ],
    }));

    expect(
      findingFor(input, "plan/wiring-duplicate-capability").message,
    ).toContain("cap-1");
  });

  it("renders the resolved list into the owning context's validator pack", () => {
    const document = withWiring({
      kind: "call_site",
      contextId: "ctx-a",
      locator: "src/lib/specs/service-factory.ts",
    }).document;

    expect(wiringOwnershipForContext(document, "ctx-a")).toEqual([
      "cap-1 — reached from the call site src/lib/specs/service-factory.ts; covers criterion-a",
    ]);
    expect(wiringOwnershipForContext(document, "ctx-closeout")).toEqual([]);
  });

  it("renders a downstream owner's obligation in its own context", () => {
    const document = withWiring({
      kind: "downstream",
      contextId: "ctx-a",
    }).document;

    expect(wiringOwnershipForContext(document, "ctx-a")).toEqual([
      "cap-1 — wired downstream by this context; covers criterion-a",
    ]);
  });
});
