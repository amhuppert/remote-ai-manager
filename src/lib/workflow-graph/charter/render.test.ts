import { describe, expect, it } from "vitest";

import type {
  SourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";

import {
  CHARTER_DOCUMENT_PATH,
  computeCharterHash,
  renderCharterDigest,
  renderCharterMarkdown,
  renderCharterPromptSection,
} from "./render";

const rank1Source: SourceOfTruth = {
  rank: 1,
  id: "prototype",
  label: "Reference Prototype",
  type: "code",
  locator: "src/prototype/floor-round.ts",
  description: "The authoritative implementation of the floor/round behavior.",
  appliesTo: "rounding behavior",
  accessPolicy: "worktree-relative",
};

const rank2Source: SourceOfTruth = {
  rank: 2,
  id: "acceptance-doc",
  label: "Acceptance Criteria Doc",
  type: "document",
  locator: "docs/acceptance.md",
  description: "Per-context acceptance criteria prose.",
  appliesTo: "task acceptance",
  accessPolicy: "worktree-relative",
};

const externalSource: SourceOfTruth = {
  rank: 3,
  id: "upstream-spec",
  label: "Upstream Spec",
  type: "spec",
  locator: "https://example.com/spec",
  description: "External authority that lives outside the worktree.",
  appliesTo: "protocol shape",
  accessPolicy: "external-readonly",
};

function makeCharter(
  overrides: Partial<WorkflowCharter> = {},
): WorkflowCharter {
  return {
    mission: "Deliver a deterministic floor/round implementation.",
    conventions: ["Prefer pure functions", "No I/O in renderers"],
    nonGoals: ["Do not change unrelated rounding utilities"],
    vocabulary: ["floor: round toward negative infinity"],
    testStrategy: "Unit-test pure functions directly.",
    knownAmbiguities: ["Tie-breaking at .5 is intentionally bankers'."],
    sourcesOfTruth: [rank1Source, rank2Source, externalSource],
    ...overrides,
  };
}

describe("renderCharterDigest", () => {
  it("is byte-identical for deeply-equal charters whose source arrays differ in input order", () => {
    const ordered = makeCharter({
      sourcesOfTruth: [rank1Source, rank2Source, externalSource],
    });
    const shuffled = makeCharter({
      sourcesOfTruth: [externalSource, rank2Source, rank1Source],
    });

    expect(renderCharterDigest(shuffled)).toBe(renderCharterDigest(ordered));
  });

  it("renders the ranked hierarchy with the rank-1 source ahead of the rank-2 source", () => {
    const digest = renderCharterDigest(makeCharter());

    const rank1Index = digest.indexOf(rank1Source.label);
    const rank2Index = digest.indexOf(rank2Source.label);

    expect(rank1Index).toBeGreaterThanOrEqual(0);
    expect(rank2Index).toBeGreaterThanOrEqual(0);
    expect(rank1Index).toBeLessThan(rank2Index);
  });

  it("includes the mission, the application rule, and the applicability scope", () => {
    const digest = renderCharterDigest(makeCharter());

    expect(digest).toContain(
      "Deliver a deterministic floor/round implementation.",
    );
    expect(digest).toContain("higher-ranked source");
    expect(digest).toContain(rank1Source.appliesTo!);
  });

  it("states that the validator should flag the conflicting acceptance criterion rather than fail the implementer", () => {
    const digest = renderCharterDigest(makeCharter());

    expect(digest.toLowerCase()).toContain("acceptance criterion");
    expect(digest.toLowerCase()).toContain("do not fail");
  });

  it("notes that external-readonly sources are read-only and permission-gated", () => {
    const digest = renderCharterDigest(makeCharter());

    expect(digest.toLowerCase()).toContain("read-only");
    expect(digest).toContain(externalSource.label);
  });

  it("renders the non-goals when present", () => {
    const digest = renderCharterDigest(makeCharter());

    expect(digest).toContain("Do not change unrelated rounding utilities");
  });

  it("keeps long source descriptions within the digest budget", () => {
    const longDescription = "x".repeat(2000);
    const digest = renderCharterDigest(
      makeCharter({
        sourcesOfTruth: [
          { ...rank1Source, description: longDescription },
          rank2Source,
        ],
      }),
    );

    expect(digest).not.toContain(longDescription);
  });
});

describe("computeCharterHash", () => {
  it("is identical for deeply-equal charters with different property insertion order", () => {
    const a: WorkflowCharter = {
      mission: "m",
      sourcesOfTruth: [rank1Source],
    };
    const b: WorkflowCharter = {
      sourcesOfTruth: [{ ...rank1Source }],
      mission: "m",
    };

    expect(computeCharterHash(b)).toBe(computeCharterHash(a));
  });

  it("is identical regardless of source-of-truth key insertion order", () => {
    const a = makeCharter();
    const reordered = makeCharter({
      sourcesOfTruth: [
        {
          accessPolicy: rank1Source.accessPolicy,
          appliesTo: rank1Source.appliesTo,
          description: rank1Source.description,
          locator: rank1Source.locator,
          type: rank1Source.type,
          label: rank1Source.label,
          id: rank1Source.id,
          rank: rank1Source.rank,
        },
        rank2Source,
        externalSource,
      ],
    });

    expect(computeCharterHash(reordered)).toBe(computeCharterHash(a));
  });

  it("returns a 64-character hex sha256 digest", () => {
    expect(computeCharterHash(makeCharter())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the highest-authority source's description changes", () => {
    const original = makeCharter();
    const edited = makeCharter({
      sourcesOfTruth: [
        { ...rank1Source, description: "A different authoritative behavior." },
        rank2Source,
        externalSource,
      ],
    });

    expect(computeCharterHash(edited)).not.toBe(computeCharterHash(original));
  });
});

describe("renderCharterMarkdown", () => {
  it("includes the mission and the full ranked source list", () => {
    const markdown = renderCharterMarkdown(makeCharter());

    expect(markdown).toContain(
      "Deliver a deterministic floor/round implementation.",
    );
    expect(markdown).toContain(rank1Source.label);
    expect(markdown).toContain(rank2Source.label);
    expect(markdown).toContain(externalSource.label);
  });

  it("includes the optional narrative sections when present", () => {
    const markdown = renderCharterMarkdown(makeCharter());

    expect(markdown).toContain("Prefer pure functions");
    expect(markdown).toContain("Do not change unrelated rounding utilities");
    expect(markdown).toContain("floor: round toward negative infinity");
    expect(markdown).toContain("Unit-test pure functions directly.");
    expect(markdown).toContain("Tie-breaking at .5 is intentionally bankers'.");
  });

  it("renders the full untruncated source description (unlike the digest)", () => {
    const longDescription = "y".repeat(2000);
    const markdown = renderCharterMarkdown(
      makeCharter({
        sourcesOfTruth: [{ ...rank1Source, description: longDescription }],
      }),
    );

    expect(markdown).toContain(longDescription);
  });

  it("is deterministic regardless of source input order", () => {
    const ordered = renderCharterMarkdown(
      makeCharter({ sourcesOfTruth: [rank1Source, rank2Source] }),
    );
    const shuffled = renderCharterMarkdown(
      makeCharter({ sourcesOfTruth: [rank2Source, rank1Source] }),
    );

    expect(shuffled).toBe(ordered);
  });
});

describe("renderCharterPromptSection", () => {
  it("begins with the digest and appends the full-charter pointer", () => {
    const section = renderCharterPromptSection(makeCharter());

    expect(section.startsWith(renderCharterDigest(makeCharter()))).toBe(true);
    expect(section).toContain(
      `Full charter: read \`${CHARTER_DOCUMENT_PATH}\` on demand.`,
    );
  });

  it("appends role-specific extra instructions in the pointer block", () => {
    const citation = "Cite the governing source in your summary.";
    const section = renderCharterPromptSection(makeCharter(), [citation]);

    expect(section).toContain(citation);
    // The extra instruction shares the pointer block (single newline), not a
    // separate digest section.
    expect(section).toContain(
      `Full charter: read \`${CHARTER_DOCUMENT_PATH}\` on demand.\n${citation}`,
    );
  });

  it("omits the extra-instruction line when none are supplied", () => {
    const section = renderCharterPromptSection(makeCharter());

    expect(section.endsWith("on demand.")).toBe(true);
  });
});
