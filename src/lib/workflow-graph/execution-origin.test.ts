import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import {
  graphWorkflowAbandonmentSchema,
  graphWorkflowExecutionOriginSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowLaunchDocumentSchema,
} from "./schemas";
import {
  ONE_OFF_SEED_DEFINITION_ID_PREFIX,
  buildOneOffSeedCompatibilityFields,
  deriveTemplateOriginFromSeedFields,
  floorRawExecutionOrigin,
  isOneOffExecution,
} from "./execution-origin";

/**
 * The EXACT required-field shape every pre-D7 build parses a stored definition
 * tier with (D2). A one-off row has to keep satisfying it: the active repo's
 * `listActive()` decodes every row in the set, so one unparseable one-off row
 * would cost an older build the workflow state of every session rather than of
 * the one run it cannot understand.
 */
const preD7RequiredDefinitionShape = z.object({
  seedDefinitionId: z.string().trim().min(1),
  seedDefinitionRevision: z.number().int().min(1),
  launchedTier: z.enum(["project", "global"]).default("project"),
});

function maximal(): Record<string, unknown> {
  const built = buildMaximalGraphWorkflowExecution();
  if (typeof built !== "object" || built === null) {
    throw new Error("maximal fixture must be an object");
  }
  return { ...(built as Record<string, unknown>) };
}

describe("graph-workflow execution origin", () => {
  it("accepts a template origin carrying identity, revision, and tier", () => {
    expect(
      graphWorkflowExecutionOriginSchema.parse({
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 3,
        tier: "global",
      }),
    ).toEqual({
      kind: "template",
      definitionId: "def-1",
      definitionRevision: 3,
      tier: "global",
    });
  });

  it("accepts a one-off origin carrying only the authored plan name", () => {
    expect(
      graphWorkflowExecutionOriginSchema.parse({
        kind: "one_off",
        planName: "Repair the flaky suite",
      }),
    ).toEqual({ kind: "one_off", planName: "Repair the flaky suite" });
  });

  it("refuses an origin kind outside the union", () => {
    expect(
      graphWorkflowExecutionOriginSchema.safeParse({
        kind: "ephemeral",
        planName: "Repair the flaky suite",
      }).success,
    ).toBe(false);
  });

  // Origin is provenance every consumer branches on, so it is REQUIRED on the
  // domain record. The only place absence is tolerated is the stored-row decode
  // boundary, which floors it from the seed fields (D2) — making optionality
  // here an unspecified second compatibility surface.
  it("requires origin on the execution record", () => {
    const { origin: _origin, ...withoutOrigin } = maximal();
    expect(graphWorkflowExecutionSchema.safeParse(withoutOrigin).success).toBe(
      false,
    );
  });

  it("derives a template origin from the legacy seed fields", () => {
    expect(
      deriveTemplateOriginFromSeedFields({
        seedDefinitionId: "seed-maximal",
        seedDefinitionRevision: 3,
        launchedTier: "global",
      }),
    ).toEqual({
      kind: "template",
      definitionId: "seed-maximal",
      definitionRevision: 3,
      tier: "global",
    });
  });

  it("derives the project tier for a row written before launchedTier existed", () => {
    expect(
      deriveTemplateOriginFromSeedFields({
        seedDefinitionId: "seed-legacy",
        seedDefinitionRevision: 1,
        launchedTier: undefined,
      }).tier,
    ).toBe("project");
  });

  it("floors only an absent origin, leaving a stored null for the parse to refuse", () => {
    const legacyRow: Record<string, unknown> = {
      seedDefinitionId: "seed-legacy",
      seedDefinitionRevision: 2,
    };
    expect(floorRawExecutionOrigin(legacyRow)).toBe(true);

    // JSON has no `undefined`, so a stored null is not an absent field — it is a
    // post-D7 row that failed to record provenance, and D2 authorizes no floor
    // for it.
    const nulledRow: Record<string, unknown> = {
      origin: null,
      seedDefinitionId: "seed-legacy",
      seedDefinitionRevision: 2,
    };
    expect(floorRawExecutionOrigin(nulledRow)).toBe(false);
    expect(nulledRow.origin).toBeNull();
  });
});

describe("one-off legacy seed filler", () => {
  it("mints a nonempty seed id namespaced to the execution", () => {
    const filler = buildOneOffSeedCompatibilityFields("exec-77");
    expect(filler).toEqual({
      seedDefinitionId: `${ONE_OFF_SEED_DEFINITION_ID_PREFIX}exec-77`,
      seedDefinitionRevision: 1,
      launchedTier: "project",
    });
  });

  // The filler exists to keep an OLD reader parsing, so the assertion that
  // matters is the old reader's own required-field shape, not ours.
  it("keeps a one-off definition tier parseable under the pre-D7 required shape", () => {
    const execution = graphWorkflowExecutionSchema.parse({
      ...maximal(),
      ...buildOneOffSeedCompatibilityFields("exec-77"),
      origin: { kind: "one_off", planName: "Repair the flaky suite" },
    });

    expect(preD7RequiredDefinitionShape.parse(execution)).toEqual({
      seedDefinitionId: "one-off:exec-77",
      seedDefinitionRevision: 1,
      launchedTier: "project",
    });
  });

  it("classifies a run by its origin, never by the seed sentinel", () => {
    const oneOff = graphWorkflowExecutionSchema.parse({
      ...maximal(),
      ...buildOneOffSeedCompatibilityFields("exec-77"),
      origin: { kind: "one_off", planName: "Repair the flaky suite" },
    });
    expect(isOneOffExecution(oneOff)).toBe(true);

    // A template run whose seed id merely LOOKS like the sentinel is still a
    // template run: the sentinel is a projection, not an authority.
    const templateWithSentinelShapedSeedId = graphWorkflowExecutionSchema.parse(
      {
        ...maximal(),
        seedDefinitionId: "one-off:not-really",
        origin: {
          kind: "template",
          definitionId: "one-off:not-really",
          definitionRevision: 2,
          tier: "project",
        },
      },
    );
    expect(isOneOffExecution(templateWithSentinelShapedSeedId)).toBe(false);
  });
});

describe("launch document", () => {
  it("carries the submitted name, description, definition, and layout", () => {
    const execution = graphWorkflowExecutionSchema.parse(maximal());
    const launchDocument = execution.launchDocument;
    if (launchDocument === null) {
      throw new Error("the maximal fixture must carry a launch document");
    }
    expect(launchDocument.name.length).toBeGreaterThan(0);
    expect(launchDocument.description).not.toBeNull();
    expect(launchDocument.definition.executionContexts.length).toBeGreaterThan(
      0,
    );
    expect(launchDocument.layout.workflowId.length).toBeGreaterThan(0);
    expect(
      Object.keys(launchDocument.layout.contextPositions).length,
    ).toBeGreaterThan(0);
  });

  it("floors a record written before the launch document existed to null", () => {
    const { launchDocument: _launchDocument, ...withoutDocument } = maximal();
    expect(
      graphWorkflowExecutionSchema.parse(withoutDocument).launchDocument,
    ).toBeNull();
  });

  it("refuses a launch document missing the layout the dialect requires", () => {
    expect(
      graphWorkflowLaunchDocumentSchema.safeParse({
        name: "Repair the flaky suite",
        description: null,
        definition: { charter: undefined },
      }).success,
    ).toBe(false);
  });
});

describe("abandonment audit", () => {
  it("records when, who, and why", () => {
    expect(
      graphWorkflowAbandonmentSchema.parse({
        abandonedAt: "2026-08-12T10:00:00.000Z",
        actor: { kind: "human" },
        reason: "the branch was superseded",
      }),
    ).toEqual({
      abandonedAt: "2026-08-12T10:00:00.000Z",
      actor: { kind: "human" },
      reason: "the branch was superseded",
    });
  });

  it("records the verified conversation when the origin conversation abandons", () => {
    expect(
      graphWorkflowAbandonmentSchema.parse({
        abandonedAt: "2026-08-12T10:00:00.000Z",
        actor: { kind: "conversation", conversationId: "conv-owner-maximal" },
        reason: "replanning from scratch",
      }).actor,
    ).toEqual({ kind: "conversation", conversationId: "conv-owner-maximal" });
  });

  it("requires a reason, so the one explicit release act is always audited", () => {
    expect(
      graphWorkflowAbandonmentSchema.safeParse({
        abandonedAt: "2026-08-12T10:00:00.000Z",
        actor: { kind: "human" },
        reason: "   ",
      }).success,
    ).toBe(false);
  });

  it("floors a record written before abandonment existed to null", () => {
    const { abandonment: _abandonment, ...withoutAbandonment } = maximal();
    expect(
      graphWorkflowExecutionSchema.parse(withoutAbandonment).abandonment,
    ).toBeNull();
  });
});

describe("dirty-worktree read-only pin", () => {
  it("carries the pin the maximal fixture launched under", () => {
    expect(
      graphWorkflowExecutionSchema.parse(maximal()).liveSessionReadOnlyPinned,
    ).toBe(true);
  });

  // A clean-worktree launch pins nothing, and so does every row written before
  // the exemption existed — the unpinned floor is what keeps ordinary live
  // edits legal on those runs (D10).
  it("floors a record written before the pin existed to unpinned", () => {
    const { liveSessionReadOnlyPinned: _pinned, ...withoutPin } = maximal();
    expect(
      graphWorkflowExecutionSchema.parse(withoutPin).liveSessionReadOnlyPinned,
    ).toBe(false);
  });
});
