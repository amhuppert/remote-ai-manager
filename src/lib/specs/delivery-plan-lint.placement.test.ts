/**
 * Propose-time placement lint (R4).
 *
 * A test file may import the graph tier; production spec-tier code may not
 * (`inv-mirror-pinned`), so the lane-grammar and session-name assertions below
 * are driven by `lane-identity`'s own exports. That is what pins the mirror
 * inside `delivery-plan-lint.ts`: if the graph tier's grammar moves, the plan
 * tier's copy stops agreeing with it here rather than at launch.
 */

import { describe, expect, it } from "vitest";
import {
  laneIdViolation,
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
import {
  deliveryPlanDocumentSchema,
  emptyDeliveryPlanDocument,
  type DeliveryPlanContextPlacement,
  type DeliveryPlanContextType,
} from "./delivery-plan";
import {
  DELIVERY_PLAN_LINT_RULES,
  lintDeliveryPlan,
  type DeliveryPlanLintInput,
} from "./delivery-plan-lint";
import type { LintFinding } from "./lint";

const PINNED_REVISION_ID = "revision-pinned";
const SPEC_SLUG = "native-sdd";

interface ContextSpec {
  readonly id: string;
  readonly placement?: DeliveryPlanContextPlacement;
  readonly contextType?: DeliveryPlanContextType;
}

type EdgeSpec = readonly [from: string, to: string];

function owned(
  lane: string,
  ...ownedPaths: string[]
): DeliveryPlanContextPlacement {
  return { lane, mode: "owned", ownedPaths };
}

function full(lane: string): DeliveryPlanContextPlacement {
  return { lane, mode: "full" };
}

function readOnly(lane: string): DeliveryPlanContextPlacement {
  return { lane, mode: "readOnly" };
}

/**
 * A lint input whose ONLY authored variable is placement: every delivery
 * context owns exactly one pinned criterion, so a placement finding is never
 * confounded with a disposition or ownership one.
 */
function planWith(
  contexts: readonly ContextSpec[],
  edges: readonly EdgeSpec[] = [],
): DeliveryPlanLintInput {
  const deliveryContexts = contexts.filter(
    (context) => (context.contextType ?? "delivery") === "delivery",
  );
  const document = deliveryPlanDocumentSchema.parse({
    ...emptyDeliveryPlanDocument(),
    dispositions: deliveryContexts.map((context) => ({
      criterionElementId: `criterion-${context.id}`,
      disposition: "selected",
      deliveredByExecutionId: null,
      reaffirmation: null,
      note: null,
    })),
    contexts: contexts.map((context) => {
      const contextType = context.contextType ?? "delivery";
      return {
        contextId: context.id,
        title: `Context ${context.id}`,
        contextType,
        criterionElementIds:
          contextType === "delivery" ? [`criterion-${context.id}`] : [],
        acceptanceContract:
          contextType === "delivery"
            ? []
            : [`${context.id} verifies the assembled branch.`],
        proofPlan: [],
        ...(context.placement === undefined
          ? {}
          : { placement: context.placement }),
      };
    }),
    edges: edges.map(([from, to]) => ({
      edgeId: `edge-${from}-${to}`,
      fromContextId: from,
      toContextId: to,
    })),
  });

  return {
    pinnedRevisionId: PINNED_REVISION_ID,
    specSlug: SPEC_SLUG,
    document,
    pinnedCriteria: deliveryContexts.map((context) => ({
      criterionElementId: `criterion-${context.id}`,
      handle: `R.${context.id}`,
      deliveryClass: "never_delivered",
      freshness: null,
    })),
    deliveredElsewhereVerdicts: [],
  };
}

function placementFindings(input: DeliveryPlanLintInput): LintFinding[] {
  return lintDeliveryPlan(input).filter((finding) =>
    finding.ruleId.startsWith("plan/placement-"),
  );
}

function placementRuleIds(input: DeliveryPlanLintInput): string[] {
  return placementFindings(input).map((finding) => finding.ruleId);
}

function placementFinding(
  input: DeliveryPlanLintInput,
  ruleId: string,
): LintFinding {
  const found = placementFindings(input).find(
    (finding) => finding.ruleId === ruleId,
  );
  if (found === undefined) {
    throw new Error(
      `expected ${ruleId}; got ${placementRuleIds(input).join(", ") || "<no placement finding>"}`,
    );
  }
  return found;
}

describe("plan/placement-lane-grammar", () => {
  it("refuses a lane name the branch-and-path grammar rejects", () => {
    const lane = "core lane";
    // Pinned against the graph tier: the mirrored copy must agree that this
    // name is illegal, and carry the graph tier's own reason for it.
    const violation = laneIdViolation(lane);
    expect(violation).not.toBeNull();

    const finding = placementFinding(
      planWith([{ id: "ctx-a", placement: full(lane) }]),
      "plan/placement-lane-grammar",
    );

    expect(finding.severity).toBe("blocks_propose");
    expect(finding.elementHandle).toBe("ctx-a");
    expect(finding.message).toContain(lane);
    expect(finding.message).toContain(violation);
    expect(finding.message).toContain("Rename");
  });

  it("refuses the engine's internal session-lane id", () => {
    const finding = placementFinding(
      planWith([{ id: "ctx-a", placement: full(SESSION_LANE_ID) }]),
      "plan/placement-lane-grammar",
    );

    expect(finding.severity).toBe("blocks_propose");
    expect(finding.elementHandle).toBe("ctx-a");
    expect(finding.message).toContain(SESSION_LANE_ID);
    expect(finding.message).toContain("group lane");
  });

  it.each([
    ["full", full(SESSION_LANE_NAME)],
    ["owned", owned(SESSION_LANE_NAME, "src/lib")],
  ])(
    "refuses a write-capable %s placement on the reserved session lane",
    (mode, placement) => {
      const finding = placementFinding(
        planWith([{ id: "ctx-a", placement }]),
        "plan/placement-lane-grammar",
      );

      expect(finding.severity).toBe("blocks_propose");
      expect(finding.elementHandle).toBe("ctx-a");
      expect(finding.message).toContain(SESSION_LANE_NAME);
      expect(finding.message).toContain(mode);
      expect(finding.message).toContain("group lane");
    },
  );

  it("admits a legal group lane name", () => {
    expect(
      placementRuleIds(planWith([{ id: "ctx-a", placement: full("core") }])),
    ).toEqual([]);
  });
});

describe("plan/placement-readonly-unsupported", () => {
  it.each([SESSION_LANE_NAME, "core"])(
    "refuses every read-only placement, naming the missing output contract (lane %s)",
    (lane) => {
      const finding = placementFinding(
        planWith([{ id: "ctx-a", placement: readOnly(lane) }]),
        "plan/placement-readonly-unsupported",
      );

      expect(finding.severity).toBe("blocks_propose");
      expect(finding.elementHandle).toBe("ctx-a");
      expect(finding.message).toContain("structured output contract");
      expect(finding.message).toContain('mode "owned"');
    },
  );

  it("leaves a read-only placement on the session lane free of a grammar finding", () => {
    // "session" is the read-only lane's correct authored spelling; the plan
    // tier refuses it for the output contract it cannot author, not the name.
    expect(
      placementRuleIds(
        planWith([{ id: "ctx-a", placement: readOnly(SESSION_LANE_NAME) }]),
      ),
    ).toEqual(["plan/placement-readonly-unsupported"]);
  });
});

describe("plan/placement-owned-overlap", () => {
  it("refuses two unordered same-lane owners whose paths overlap at a segment boundary", () => {
    const input = planWith([
      { id: "ctx-a", placement: owned("core", "src/lib") },
      { id: "ctx-b", placement: owned("core", "src/lib/specs") },
    ]);

    const finding = placementFinding(input, "plan/placement-owned-overlap");
    expect(finding.severity).toBe("blocks_propose");
    expect(finding.elementHandle).toBe("ctx-a");
    expect(finding.message).toContain("src/lib");
    expect(finding.message).toContain("src/lib/specs");
    expect(finding.message).toContain("disjoint");
  });

  it("does not treat a sibling sharing a name prefix as an overlap", () => {
    expect(
      placementRuleIds(
        planWith([
          { id: "ctx-a", placement: owned("core", "src/lib") },
          { id: "ctx-b", placement: owned("core", "src/libraries") },
        ]),
      ),
    ).toEqual([]);
  });

  it("does not fire across different lanes", () => {
    expect(
      placementRuleIds(
        planWith([
          { id: "ctx-a", placement: owned("core", "src/lib") },
          { id: "ctx-b", placement: owned("edge", "src/lib/specs") },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("plan/placement-full-shared", () => {
  it("refuses a full-access context sharing its lane with an unordered writer", () => {
    const input = planWith([
      { id: "ctx-a", placement: full("core") },
      { id: "ctx-b", placement: owned("core", "src/lib") },
    ]);

    const finding = placementFinding(input, "plan/placement-full-shared");
    expect(finding.severity).toBe("blocks_propose");
    expect(finding.elementHandle).toBe("ctx-a");
    expect(finding.message).toContain("ctx-b");
    expect(finding.message).toContain('"core"');
    expect(finding.message).toContain("ownedPaths");
  });

  it("reports the full-access context even when it is authored second", () => {
    const finding = placementFinding(
      planWith([
        { id: "ctx-b", placement: owned("core", "src/lib") },
        { id: "ctx-a", placement: full("core") },
      ]),
      "plan/placement-full-shared",
    );

    expect(finding.elementHandle).toBe("ctx-a");
  });

  it("does not fire against a read-only lane mate", () => {
    expect(
      placementRuleIds(
        planWith([
          { id: "ctx-a", placement: full("core") },
          { id: "ctx-b", placement: readOnly("core") },
        ]),
      ),
    ).toEqual(["plan/placement-readonly-unsupported"]);
  });
});

describe("plan/placement-lane-cycle", () => {
  it("refuses authored placements that contract the edges into a lane cycle", () => {
    const input = planWith(
      [
        { id: "ctx-a", placement: owned("lane-x", "src/a") },
        { id: "ctx-b", placement: owned("lane-y", "src/b") },
        { id: "ctx-c", placement: owned("lane-x", "src/c") },
      ],
      [
        ["ctx-a", "ctx-b"],
        ["ctx-b", "ctx-c"],
      ],
    );

    const finding = placementFinding(input, "plan/placement-lane-cycle");
    expect(finding.severity).toBe("blocks_propose");
    // The returning work is what the remedy asks the author to move.
    expect(finding.elementHandle).toBe("ctx-c");
    expect(finding.message).toContain("lane-x");
    expect(finding.message).toContain("lane-y");
    expect(finding.message).toContain("new lane");
  });

  /**
   * Omitting a placement is the author's choice to take the materializer's
   * solo-lane default (`placement: { lane: contextId, mode: "full" }`), so a
   * placement-less context is still a lane NODE once materialized and an edge
   * through it is still a lane dependency. A contraction that skipped those
   * contexts would miss a cycle the graph tier refuses at launch.
   */
  it("refuses a cycle that runs through a context taking the solo-lane default", () => {
    const input = planWith(
      [
        { id: "ctx-a", placement: owned("lane-x", "src/a") },
        { id: "ctx-b" },
        { id: "ctx-c", placement: owned("lane-x", "src/c") },
      ],
      [
        ["ctx-a", "ctx-b"],
        ["ctx-b", "ctx-c"],
      ],
    );

    const finding = placementFinding(input, "plan/placement-lane-cycle");
    expect(finding.severity).toBe("blocks_propose");
    expect(finding.elementHandle).toBe("ctx-c");
    expect(finding.message).toContain("lane-x");
    expect(finding.message).toContain("ctx-b");
    expect(finding.message).toContain("new lane");
  });

  it("admits a solo-lane hop between two lanes that never meet again", () => {
    expect(
      placementRuleIds(
        planWith(
          [
            { id: "ctx-a", placement: owned("lane-x", "src/a") },
            { id: "ctx-b" },
            { id: "ctx-c", placement: owned("lane-z", "src/c") },
          ],
          [
            ["ctx-a", "ctx-b"],
            ["ctx-b", "ctx-c"],
          ],
        ),
      ),
    ).toEqual([]);
  });

  /**
   * With nothing placed, the contraction is the identity on the context graph,
   * so a lane cycle could only be an edge cycle — which `plan/edge-cycle`
   * already owns, and which no authored placement contracted.
   */
  it("stays silent for a plan that authors no placement at all", () => {
    expect(
      placementRuleIds(
        planWith(
          [{ id: "ctx-a" }, { id: "ctx-b" }, { id: "ctx-c" }],
          [
            ["ctx-a", "ctx-b"],
            ["ctx-b", "ctx-c"],
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("admits a lane fan-out that never returns", () => {
    expect(
      placementRuleIds(
        planWith(
          [
            { id: "ctx-a", placement: owned("lane-x", "src/a") },
            { id: "ctx-b", placement: owned("lane-y", "src/b") },
            { id: "ctx-c", placement: owned("lane-z", "src/c") },
          ],
          [
            ["ctx-a", "ctx-b"],
            ["ctx-a", "ctx-c"],
          ],
        ),
      ),
    ).toEqual([]);
  });
});

describe("plan/placement-closeout-shared", () => {
  it.each<DeliveryPlanContextType>(["closeout", "integration"])(
    "advises when a %s context shares a lane with an unordered writer",
    (contextType) => {
      const input = planWith([
        { id: "ctx-verify", contextType, placement: owned("core", "docs") },
        { id: "ctx-a", placement: owned("core", "src/lib") },
      ]);

      const finding = placementFinding(input, "plan/placement-closeout-shared");
      expect(finding.severity).toBe("advisory");
      expect(finding.elementHandle).toBe("ctx-verify");
      expect(finding.message).toContain("ctx-a");
      expect(finding.message).toContain(contextType);
      expect(finding.message).toContain("own lane");
    },
  );

  it("does not advise when the closeout context has the lane to itself", () => {
    expect(
      placementRuleIds(
        planWith([
          {
            id: "ctx-verify",
            contextType: "closeout",
            placement: owned("verify", "docs"),
          },
          { id: "ctx-a", placement: owned("core", "src/lib") },
        ]),
      ),
    ).toEqual([]);
  });
});

/**
 * The concurrency-sensitive rules judge whether two lane mates could ever hold
 * the one worktree at the same time, which is exactly what a directed edge path
 * settles — in either direction, however many hops away.
 */
describe("dependency ordering exempts the concurrency-sensitive rules", () => {
  const SHAPES: ReadonlyArray<{
    readonly rule: string;
    readonly left: ContextSpec;
    readonly right: ContextSpec;
  }> = [
    {
      rule: "plan/placement-owned-overlap",
      left: { id: "ctx-a", placement: owned("core", "src/lib") },
      right: { id: "ctx-b", placement: owned("core", "src/lib/specs") },
    },
    {
      rule: "plan/placement-full-shared",
      left: { id: "ctx-a", placement: full("core") },
      right: { id: "ctx-b", placement: owned("core", "src/lib") },
    },
    {
      rule: "plan/placement-closeout-shared",
      left: {
        id: "ctx-a",
        contextType: "closeout",
        placement: owned("core", "docs"),
      },
      right: { id: "ctx-b", placement: owned("core", "src/lib") },
    },
  ];

  /** A same-lane hop, so ordering never introduces a lane-level cycle. */
  const MIDDLE: ContextSpec = {
    id: "ctx-mid",
    placement: owned("core", "src/middle"),
  };

  for (const shape of SHAPES) {
    it(`${shape.rule} does not fire for a directly ordered pair`, () => {
      expect(
        placementRuleIds(
          planWith(
            [shape.left, shape.right],
            [[shape.left.id, shape.right.id]],
          ),
        ),
      ).toEqual([]);
    });

    it(`${shape.rule} does not fire for a reversed direct edge`, () => {
      expect(
        placementRuleIds(
          planWith(
            [shape.left, shape.right],
            [[shape.right.id, shape.left.id]],
          ),
        ),
      ).toEqual([]);
    });

    it(`${shape.rule} does not fire for a transitive path`, () => {
      expect(
        placementRuleIds(
          planWith(
            [shape.left, MIDDLE, shape.right],
            [
              [shape.left.id, MIDDLE.id],
              [MIDDLE.id, shape.right.id],
            ],
          ),
        ),
      ).toEqual([]);
    });

    it(`${shape.rule} does not fire for a reversed transitive path`, () => {
      expect(
        placementRuleIds(
          planWith(
            [shape.left, MIDDLE, shape.right],
            [
              [shape.right.id, MIDDLE.id],
              [MIDDLE.id, shape.left.id],
            ],
          ),
        ),
      ).toEqual([]);
    });
  }
});

describe("a clean placement-bearing plan", () => {
  it("produces no findings at all", () => {
    const input = planWith(
      [
        { id: "ctx-chain-1", placement: owned("core", "src/lib/specs") },
        { id: "ctx-chain-2", placement: owned("core", "src/lib/specs") },
        { id: "ctx-pair-1", placement: owned("wide", "src/features") },
        { id: "ctx-pair-2", placement: owned("wide", "src/components") },
      ],
      [["ctx-chain-1", "ctx-chain-2"]],
    );

    expect(placementRuleIds(input)).toEqual([]);
    expect(lintDeliveryPlan(input)).toEqual([]);
  });
});

describe("the placement rule registry", () => {
  it("declares exactly the six placement rules with their stated severities", () => {
    expect(
      DELIVERY_PLAN_LINT_RULES.filter((rule) =>
        rule.ruleId.startsWith("plan/placement-"),
      ),
    ).toEqual([
      { ruleId: "plan/placement-lane-grammar", severity: "blocks_propose" },
      {
        ruleId: "plan/placement-readonly-unsupported",
        severity: "blocks_propose",
      },
      { ruleId: "plan/placement-owned-overlap", severity: "blocks_propose" },
      { ruleId: "plan/placement-full-shared", severity: "blocks_propose" },
      { ruleId: "plan/placement-lane-cycle", severity: "blocks_propose" },
      { ruleId: "plan/placement-closeout-shared", severity: "advisory" },
    ]);
  });
});
