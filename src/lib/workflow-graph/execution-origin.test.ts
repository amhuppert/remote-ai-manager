import { describe, expect, it } from "vitest";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import {
  graphWorkflowAbandonmentSchema,
  graphWorkflowExecutionOriginSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowLaunchDocumentSchema,
} from "./schemas";
import {
  buildExecutionProvenance,
  describeLaunchSource,
  deriveTemplateOriginFromSeedFields,
  floorRawExecutionOrigin,
  originFallbackName,
  originKindLabel,
} from "./execution-origin";

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

  it("accepts a spec-delivery origin carrying the spec slug and candidate id", () => {
    expect(
      graphWorkflowExecutionOriginSchema.parse({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      }),
    ).toEqual({
      kind: "spec_delivery",
      specSlug: "conversation-compaction",
      candidateId: "cand-42",
    });
  });

  it("refuses a spec-delivery origin missing its candidate id", () => {
    expect(
      graphWorkflowExecutionOriginSchema.safeParse({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
      }).success,
    ).toBe(false);
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

describe("one-off provenance", () => {
  it("has no saved definition identity", () => {
    expect(
      buildExecutionProvenance({ kind: "one_off", planName: "Ad hoc" }),
    ).toEqual({
      origin: { kind: "one_off", planName: "Ad hoc" },
      seedDefinitionId: null,
      seedDefinitionRevision: null,
      launchedTier: "project",
    });
  });
});

describe("launch-source provenance", () => {
  it("pairs a spec-delivery origin with its saved definition identity", () => {
    expect(
      buildExecutionProvenance({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
        definitionId: "definition-42",
        definitionRevision: 7,
      }),
    ).toEqual({
      origin: {
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      },
      seedDefinitionId: "definition-42",
      seedDefinitionRevision: 7,
      launchedTier: "project",
    });
  });

  it("attributes a spec-delivery launch by slug and candidate, never the filler", () => {
    expect(
      describeLaunchSource({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
        definitionId: "definition-42",
        definitionRevision: 7,
      }),
    ).toEqual({
      origin: "spec_delivery",
      specSlug: "conversation-compaction",
      candidateId: "cand-42",
      definitionId: "definition-42",
      definitionRevision: 7,
    });
  });
});

describe("origin display projections", () => {
  it("falls back to the human-facing identity each origin carries", () => {
    expect(
      originFallbackName({
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 3,
        tier: "project",
      }),
    ).toBe("def-1");
    expect(
      originFallbackName({ kind: "one_off", planName: "Repair the suite" }),
    ).toBe("Repair the suite");
    expect(
      originFallbackName({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      }),
    ).toBe("conversation-compaction");
  });

  it("labels each origin kind distinctly", () => {
    expect(
      originKindLabel({
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 3,
        tier: "project",
      }),
    ).toBe("Template");
    expect(originKindLabel({ kind: "one_off", planName: "n" })).toBe("One-off");
    expect(
      originKindLabel({
        kind: "spec_delivery",
        specSlug: "conversation-compaction",
        candidateId: "cand-42",
      }),
    ).toBe("Spec delivery");
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
