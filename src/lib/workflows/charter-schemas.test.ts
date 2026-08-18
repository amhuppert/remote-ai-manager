import { describe, expect, it } from "vitest";

import {
  charterAmendmentSchema,
  sourceOfTruthSchema,
  sourceScopeContextIds,
  workflowCharterSchema,
  type CharterInvariant,
  type SourceOfTruth,
  type WorkflowCharter,
} from "./charter-schemas";

function makeSource(overrides: Partial<SourceOfTruth> = {}): SourceOfTruth {
  return {
    rank: 1,
    id: "design-prototype",
    label: "Design Prototype",
    type: "code",
    locator: "src/lib/aerotrainer/floor-round.ts",
    description: "The reference implementation of the floor/round conversion.",
    appliesTo: { contextIds: ["context-implement"] },
    ...overrides,
  };
}

function makeInvariant(
  overrides: Partial<CharterInvariant> = {},
): CharterInvariant {
  return {
    id: "server-side-enforcement",
    statement:
      "Every gate is enforced server-side; UI-only enforcement does not satisfy a gating criterion.",
    ...overrides,
  };
}

function makeMaximalCharter(): WorkflowCharter {
  return {
    mission: "Deliver a correct floor/round conversion across the trainer.",
    conventions: ["Round half-up", "Floor at integer boundaries"],
    nonGoals: ["Reworking the scoring pipeline"],
    vocabulary: ["floor = round toward zero", "round = nearest integer"],
    testStrategy: "Pin behavior with a fixture matching the prototype.",
    knownAmbiguities: ["AC-7 wording contradicts the prototype"],
    invariants: [
      makeInvariant(),
      makeInvariant({
        id: "pinned-revision-targeting",
        statement:
          "Reads during an active run resolve against the pinned approved revision, never the latest.",
      }),
    ],
    sourcesOfTruth: [
      makeSource({ rank: 1, id: "design-prototype" }),
      makeSource({
        rank: 2,
        id: "acceptance-criteria",
        label: "Acceptance Criteria",
        type: "document",
        locator: ".kiro/specs/aerotrainer/requirements.md",
        description: "The AC prose blocks.",
        appliesTo: undefined,
      }),
      makeSource({
        rank: 3,
        id: "upstream-standard",
        label: "Upstream Standard",
        type: "spec",
        locator: "https://example.test/spec",
        description: "An external authority materialized into the worktree.",
        appliesTo: undefined,
      }),
    ],
  };
}

/**
 * A source entry as persisted before structured scoping: prose `appliesTo`
 * and an `accessPolicy` — the exact stored shape the tolerant read path must
 * carry through unchanged.
 */
function makeLegacySource(): Record<string, unknown> {
  return {
    rank: 1,
    id: "legacy-standard",
    label: "Legacy Standard",
    type: "spec",
    locator: "https://example.test/spec",
    description: "An external authority outside the worktree.",
    appliesTo: "all execution contexts",
    accessPolicy: "external-readonly",
  };
}

describe("sourceOfTruthSchema", () => {
  it("parses a fully populated source entry with a structured scope", () => {
    const parsed = sourceOfTruthSchema.parse(makeSource());
    expect(parsed.rank).toBe(1);
    expect(parsed.appliesTo).toEqual({ contextIds: ["context-implement"] });
  });

  it("accepts an omitted optional appliesTo (global)", () => {
    const result = sourceOfTruthSchema.safeParse(
      makeSource({ appliesTo: undefined }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive rank", () => {
    const result = sourceOfTruthSchema.safeParse(makeSource({ rank: 0 }));
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer rank", () => {
    const result = sourceOfTruthSchema.safeParse(makeSource({ rank: 1.5 }));
    expect(result.success).toBe(false);
  });

  it.each(["code", "config", "document", "spec", "other"] as const)(
    "accepts source type %s",
    (type) => {
      const result = sourceOfTruthSchema.safeParse(makeSource({ type }));
      expect(result.success).toBe(true);
    },
  );

  it("rejects an unknown source type", () => {
    const result = sourceOfTruthSchema.safeParse(
      makeSource({ type: "unknown" as SourceOfTruth["type"] }),
    );
    expect(result.success).toBe(false);
  });

  it("refuses an authored accessPolicy field", () => {
    const result = sourceOfTruthSchema.safeParse({
      ...makeSource(),
      accessPolicy: "worktree-relative",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("accessPolicy");
  });

  it("refuses legacy prose appliesTo on the authored path", () => {
    const result = sourceOfTruthSchema.safeParse({
      ...makeSource(),
      appliesTo: "src/lib/aerotrainer/**",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    {
      label: "an empty context id list",
      appliesTo: { contextIds: [] },
      path: ["appliesTo", "contextIds"],
    },
    {
      label: "an empty context id",
      appliesTo: { contextIds: [""] },
      path: ["appliesTo", "contextIds", 0],
    },
    {
      label: "a duplicate context id",
      appliesTo: { contextIds: ["context-plan", "context-plan"] },
      path: ["appliesTo", "contextIds", 1],
    },
    {
      label: "an unknown scope property",
      appliesTo: { contextIds: ["context-plan"], extra: true },
      path: ["appliesTo"],
    },
  ])(
    "rejects $label at its authored location (shared scope schema)",
    ({ appliesTo, path }) => {
      const result = sourceOfTruthSchema.safeParse({
        ...makeSource(),
        appliesTo,
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(
        result.error.issues.some(
          (issue) => JSON.stringify(issue.path) === JSON.stringify(path),
        ),
      ).toBe(true);
    },
  );
});

describe("sourceScopeContextIds", () => {
  it("returns the scoped context ids for a structured appliesTo", () => {
    expect(sourceScopeContextIds(makeSource())).toEqual(["context-implement"]);
  });

  it("returns null for a global source (no appliesTo)", () => {
    expect(
      sourceScopeContextIds(makeSource({ appliesTo: undefined })),
    ).toBeNull();
  });

  it("returns null for a legacy prose appliesTo (treated as global)", () => {
    const legacy = workflowCharterSchema.parse({
      mission: "Legacy mission.",
      sourcesOfTruth: [makeLegacySource()],
    });
    const source = legacy.sourcesOfTruth[0];
    if (!source) throw new Error("fixture must have a source");
    expect(sourceScopeContextIds(source)).toBeNull();
  });
});

describe("workflowCharterSchema — tolerant persisted read", () => {
  it("accepts a stored charter carrying legacy prose appliesTo and accessPolicy", () => {
    const result = workflowCharterSchema.safeParse({
      mission: "Legacy mission.",
      sourcesOfTruth: [makeLegacySource()],
    });
    expect(result.success).toBe(true);
  });

  it("preserves the legacy fields verbatim so recomputed hashes stay stable", () => {
    const parsed = workflowCharterSchema.parse({
      mission: "Legacy mission.",
      sourcesOfTruth: [makeLegacySource()],
    });
    expect(parsed.sourcesOfTruth[0]).toEqual(makeLegacySource());
  });

  it("still refuses duplicate ranks on the persisted path", () => {
    const result = workflowCharterSchema.safeParse({
      mission: "Legacy mission.",
      sourcesOfTruth: [
        makeLegacySource(),
        { ...makeLegacySource(), id: "second" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// The authored refusal of the legacy shapes (retired accessPolicy, prose
// appliesTo) is enforced at plan accept by validateCharterSourceAuthoredShapes
// — covered in src/lib/workflow-graph/validation.test.ts — and at the edit-op
// surface by the strict sourceOfTruthSchema above. Parse surfaces stay
// tolerant so persisted documents keep loading verbatim.

describe("workflowCharterSchema", () => {
  it("parses a maximal valid charter", () => {
    const parsed = workflowCharterSchema.parse(makeMaximalCharter());
    expect(parsed.mission).toContain("floor/round");
    expect(parsed.sourcesOfTruth).toHaveLength(3);
    expect(parsed.knownAmbiguities).toHaveLength(1);
  });

  it("parses a minimal charter (mission + one source only)", () => {
    const result = workflowCharterSchema.safeParse({
      mission: "Minimal mission.",
      sourcesOfTruth: [makeSource()],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing mission", () => {
    const charter = makeMaximalCharter();
    const { mission: _mission, ...withoutMission } = charter;
    void _mission;
    const result = workflowCharterSchema.safeParse(withoutMission);
    expect(result.success).toBe(false);
  });

  it("rejects an empty sourcesOfTruth list", () => {
    const result = workflowCharterSchema.safeParse({
      ...makeMaximalCharter(),
      sourcesOfTruth: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required source field, naming the offending entry", () => {
    const charter = makeMaximalCharter();
    const offending = charter.sourcesOfTruth[1];
    if (!offending) throw new Error("fixture must have a second source");
    const { label: _label, ...withoutLabel } = offending;
    void _label;
    const result = workflowCharterSchema.safeParse({
      ...charter,
      sourcesOfTruth: [
        charter.sourcesOfTruth[0],
        withoutLabel,
        charter.sourcesOfTruth[2],
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // The offending entry is identified by its position in the array.
    const namesEntry = result.error.issues.some(
      (issue) =>
        issue.path.includes("sourcesOfTruth") && issue.path.includes(1),
    );
    expect(namesEntry).toBe(true);
  });

  it("rejects a missing locator, naming the offending entry", () => {
    const charter = makeMaximalCharter();
    const offending = charter.sourcesOfTruth[0];
    if (!offending) throw new Error("fixture must have a first source");
    const { locator: _locator, ...withoutLocator } = offending;
    void _locator;
    const result = workflowCharterSchema.safeParse({
      ...charter,
      sourcesOfTruth: [
        withoutLocator,
        charter.sourcesOfTruth[1],
        charter.sourcesOfTruth[2],
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const namesEntry = result.error.issues.some(
      (issue) =>
        issue.path.includes("sourcesOfTruth") && issue.path.includes(0),
    );
    expect(namesEntry).toBe(true);
  });

  it("rejects duplicate ranks, naming the offending entry by id and rank", () => {
    const charter = makeMaximalCharter();
    const duplicated: WorkflowCharter = {
      ...charter,
      sourcesOfTruth: [
        makeSource({ rank: 1, id: "design-prototype" }),
        makeSource({ rank: 1, id: "acceptance-criteria" }),
        makeSource({ rank: 3, id: "upstream-standard" }),
      ],
    };
    const result = workflowCharterSchema.safeParse(duplicated);
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((i) => i.message).join(" ");
    // The offending entry must be identified: its id and the conflicting rank.
    expect(message).toContain("acceptance-criteria");
    expect(message).toContain("1");
    // The path must point at the offending array index.
    const pointsAtEntry = result.error.issues.some(
      (issue) =>
        issue.path.includes("sourcesOfTruth") && issue.path.includes(1),
    );
    expect(pointsAtEntry).toBe(true);
  });

  it("parses a maximal charter's invariants", () => {
    const parsed = workflowCharterSchema.parse(makeMaximalCharter());
    expect(parsed.invariants).toHaveLength(2);
    expect(parsed.invariants?.[0]?.id).toBe("server-side-enforcement");
  });

  it("accepts an omitted invariants list", () => {
    const { invariants: _invariants, ...withoutInvariants } =
      makeMaximalCharter();
    void _invariants;
    const result = workflowCharterSchema.safeParse(withoutInvariants);
    expect(result.success).toBe(true);
  });

  it("rejects duplicate invariant ids, naming the id and pointing at the offending entry", () => {
    const result = workflowCharterSchema.safeParse({
      ...makeMaximalCharter(),
      invariants: [
        makeInvariant({ id: "evidence-binding" }),
        makeInvariant({ id: "evidence-binding" }),
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("evidence-binding");
    const pointsAtEntry = result.error.issues.some(
      (issue) => issue.path.includes("invariants") && issue.path.includes(1),
    );
    expect(pointsAtEntry).toBe(true);
  });

  it("rejects an invariant with an empty statement", () => {
    const result = workflowCharterSchema.safeParse({
      ...makeMaximalCharter(),
      invariants: [makeInvariant({ statement: "" })],
    });
    expect(result.success).toBe(false);
  });

  it("preserves an invariant's strict authored-context scope", () => {
    const result = workflowCharterSchema.safeParse({
      ...makeMaximalCharter(),
      invariants: [
        {
          ...makeInvariant(),
          appliesTo: { contextIds: ["context-implement"] },
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.invariants?.[0]?.appliesTo).toEqual({
      contextIds: ["context-implement"],
    });
  });

  it.each([
    {
      label: "an empty context id list",
      appliesTo: { contextIds: [] },
      path: ["invariants", 0, "appliesTo", "contextIds"],
    },
    {
      label: "an empty context id",
      appliesTo: { contextIds: [""] },
      path: ["invariants", 0, "appliesTo", "contextIds", 0],
    },
    {
      label: "a duplicate context id",
      appliesTo: { contextIds: ["context-plan", "context-plan"] },
      path: ["invariants", 0, "appliesTo", "contextIds", 1],
    },
    {
      label: "an unknown scope property",
      appliesTo: { contextIds: ["context-plan"], extra: true },
      path: ["invariants", 0, "appliesTo"],
    },
  ])("rejects $label at its authored location", ({ appliesTo, path }) => {
    const result = workflowCharterSchema.safeParse({
      ...makeMaximalCharter(),
      invariants: [{ ...makeInvariant(), appliesTo }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (issue) => JSON.stringify(issue.path) === JSON.stringify(path),
      ),
    ).toBe(true);
  });

  it("accepts non-contiguous but unique ranks", () => {
    const result = workflowCharterSchema.safeParse({
      ...makeMaximalCharter(),
      sourcesOfTruth: [
        makeSource({ rank: 10, id: "a" }),
        makeSource({ rank: 20, id: "b" }),
        makeSource({ rank: 99, id: "c" }),
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("charterAmendmentSchema — source attribution", () => {
  it.each(["cli", "ui", "plan-repair"] as const)(
    "accepts amendment source %s",
    (source) => {
      const parsed = charterAmendmentSchema.parse({
        seq: 1,
        amendedAt: "2026-07-29T00:00:00.000Z",
        source,
        rationale: "AC referenced a removed endpoint",
        fieldsChanged: ["mission"],
        charterHash: "hash-1",
      });
      expect(parsed.source).toBe(source);
    },
  );

  it("rejects an unknown amendment source", () => {
    const result = charterAmendmentSchema.safeParse({
      seq: 1,
      amendedAt: "2026-07-29T00:00:00.000Z",
      source: "lane-agent",
      rationale: "x",
      fieldsChanged: ["mission"],
      charterHash: "hash-1",
    });
    expect(result.success).toBe(false);
  });
});
