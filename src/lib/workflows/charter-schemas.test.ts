import { describe, expect, it } from "vitest";

import {
  sourceOfTruthSchema,
  workflowCharterSchema,
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
    appliesTo: "src/lib/aerotrainer/**",
    accessPolicy: "worktree-relative",
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
        accessPolicy: "worktree-relative",
      }),
      makeSource({
        rank: 3,
        id: "upstream-standard",
        label: "Upstream Standard",
        type: "spec",
        locator: "https://example.test/spec",
        description: "An external authority outside the worktree.",
        accessPolicy: "external-readonly",
      }),
    ],
  };
}

describe("sourceOfTruthSchema", () => {
  it("parses a fully populated source entry", () => {
    const parsed = sourceOfTruthSchema.parse(makeSource());
    expect(parsed.rank).toBe(1);
    expect(parsed.accessPolicy).toBe("worktree-relative");
  });

  it("accepts an omitted optional appliesTo", () => {
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

  it("rejects an unknown access policy", () => {
    const result = sourceOfTruthSchema.safeParse(
      makeSource({
        accessPolicy: "anywhere" as SourceOfTruth["accessPolicy"],
      }),
    );
    expect(result.success).toBe(false);
  });
});

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
