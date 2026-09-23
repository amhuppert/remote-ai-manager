import { describe, expect, it } from "vitest";

import type {
  CharterAmendment,
  PersistedSourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";

import {
  CHARTER_DOCUMENT_PATH,
  computeCharterHash,
  isDocumentInContextScope,
  renderCharterDigest,
  renderCharterDocument,
  renderCharterMarkdown,
  renderCharterPromptSection,
} from "./render";

// The context ids the scoped fixtures bind to. Prompt rendering is per-context:
// a source is rendered only when it is global or scoped to the rendering
// context (conflicts among sources are resolved at plan time, so agents never
// receive out-of-scope sources or precedence rules).
const IN_SCOPE_CONTEXT = "context-implement";
const OUT_OF_SCOPE_CONTEXT = "context-verify";

const globalSource: PersistedSourceOfTruth = {
  rank: 1,
  id: "prototype",
  label: "Reference Prototype",
  type: "code",
  locator: "src/prototype/floor-round.ts",
  description: "The authoritative implementation of the floor/round behavior.",
};

const scopedSource: PersistedSourceOfTruth = {
  rank: 2,
  id: "acceptance-doc",
  label: "Acceptance Criteria Doc",
  type: "document",
  locator: "docs/acceptance.md",
  description: "Per-context acceptance criteria prose.",
  appliesTo: { contextIds: [IN_SCOPE_CONTEXT] },
};

// Persisted before structured scoping: prose applicability plus the retired
// accessPolicy field. The prompt path treats it as global and renders neither
// legacy field; the full markdown document preserves both.
const legacySource: PersistedSourceOfTruth = {
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
    sourcesOfTruth: [globalSource, scopedSource, legacySource],
    ...overrides,
  };
}

describe("renderCharterDigest", () => {
  it("renders global sources plus sources scoped to the rendering context", () => {
    const digest = renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT);

    expect(digest).toContain(globalSource.label);
    expect(digest).toContain(scopedSource.label);
  });

  it("omits sources scoped to a different context", () => {
    const digest = renderCharterDigest(makeCharter(), OUT_OF_SCOPE_CONTEXT);

    expect(digest).toContain(globalSource.label);
    expect(digest).not.toContain(scopedSource.label);
  });

  it("treats a legacy prose appliesTo as global and renders neither legacy field", () => {
    const digest = renderCharterDigest(makeCharter(), OUT_OF_SCOPE_CONTEXT);

    expect(digest).toContain(legacySource.label);
    expect(digest).not.toContain("protocol shape");
    expect(digest).not.toContain("Access:");
    expect(digest).not.toContain("external-readonly");
  });

  it("is byte-identical for deeply-equal charters whose source arrays differ in input order", () => {
    const ordered = makeCharter({
      sourcesOfTruth: [globalSource, scopedSource, legacySource],
    });
    const shuffled = makeCharter({
      sourcesOfTruth: [legacySource, scopedSource, globalSource],
    });

    expect(renderCharterDigest(shuffled, IN_SCOPE_CONTEXT)).toBe(
      renderCharterDigest(ordered, IN_SCOPE_CONTEXT),
    );
  });

  it("renders the ranked hierarchy with the rank-1 source ahead of the rank-2 source", () => {
    const digest = renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT);

    const rank1Index = digest.indexOf(globalSource.label);
    const rank2Index = digest.indexOf(scopedSource.label);

    expect(rank1Index).toBeGreaterThanOrEqual(0);
    expect(rank2Index).toBeGreaterThanOrEqual(0);
    expect(rank1Index).toBeLessThan(rank2Index);
  });

  it("includes the mission and the non-goals", () => {
    const digest = renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT);

    expect(digest).toContain(
      "Deliver a deterministic floor/round implementation.",
    );
    expect(digest).toContain("Do not change unrelated rounding utilities");
  });

  it("carries no precedence or criterion-deferral rule (conflicts are resolved at plan time)", () => {
    const digest = renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT);
    const lowered = digest.toLowerCase();

    expect(digest).not.toContain("Applying the source-of-truth hierarchy");
    expect(lowered).not.toContain("higher-ranked source");
    expect(lowered).not.toContain("do not fail");
  });

  it("carries no access-policy or applies-to bookkeeping lines", () => {
    const digest = renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT);
    const lowered = digest.toLowerCase();

    expect(digest).not.toContain("Access:");
    expect(digest).not.toContain("Applies to:");
    expect(lowered).not.toContain("permission-gated");
    expect(lowered).not.toContain("read-only");
  });

  it("renders declared invariants with their ids ahead of the source hierarchy", () => {
    const digest = renderCharterDigest(
      makeCharter({
        invariants: [
          {
            id: "server-side-enforcement",
            statement: "Every gate is enforced server-side.",
          },
          {
            id: "evidence-binding",
            statement: "Evidence is bound to its producing execution.",
          },
        ],
      }),
      IN_SCOPE_CONTEXT,
    );

    expect(digest).toContain("server-side-enforcement");
    expect(digest).toContain("Every gate is enforced server-side.");
    expect(digest).toContain("Evidence is bound to its producing execution.");
    // Invariants are load-bearing for every context; they render before the
    // source hierarchy so they are read ahead of the reference list.
    expect(digest.indexOf("server-side-enforcement")).toBeLessThan(
      digest.indexOf("Source-of-truth hierarchy"),
    );
  });

  it("labels global and context-scoped invariants when a charter declares scope", () => {
    const charter = makeCharter({
      invariants: [
        { id: "global", statement: "Applies everywhere." },
        {
          id: "implementation-only",
          statement: "Applies only to implementation work.",
          appliesTo: { contextIds: ["context-implement", "context-verify"] },
        },
      ],
    });

    const digest = renderCharterDigest(charter, IN_SCOPE_CONTEXT);
    const markdown = renderCharterMarkdown(charter);

    for (const rendered of [digest, markdown]) {
      expect(rendered).toContain("global)");
      expect(rendered).toContain(
        "applies to: context-implement, context-verify",
      );
    }
  });

  it("keeps all-unscoped invariant rendering byte-compatible", () => {
    const charter = makeCharter({
      invariants: [{ id: "global", statement: "Applies everywhere." }],
    });

    expect(renderCharterDigest(charter, IN_SCOPE_CONTEXT)).toContain(
      "## Invariants (hold for every change)\n- `global` — Applies everywhere.",
    );
    expect(renderCharterMarkdown(charter)).toContain(
      "## Invariants (hold for every change)\n- `global` — Applies everywhere.",
    );
  });

  it("omits the invariants section when the charter declares none", () => {
    const digest = renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT);

    expect(digest.toLowerCase()).not.toContain("invariant");
  });

  it("keeps long source descriptions within the digest budget", () => {
    const longDescription = "x".repeat(2000);
    const digest = renderCharterDigest(
      makeCharter({
        sourcesOfTruth: [
          { ...globalSource, description: longDescription },
          scopedSource,
        ],
      }),
      IN_SCOPE_CONTEXT,
    );

    expect(digest).not.toContain(longDescription);
  });
});

describe("computeCharterHash", () => {
  it("is identical for deeply-equal charters with different property insertion order", () => {
    const a: WorkflowCharter = {
      mission: "m",
      sourcesOfTruth: [legacySource],
    };
    const b: WorkflowCharter = {
      sourcesOfTruth: [{ ...legacySource }],
      mission: "m",
    };

    expect(computeCharterHash(b)).toBe(computeCharterHash(a));
  });

  it("is identical regardless of source-of-truth key insertion order", () => {
    const a = makeCharter();
    const reordered = makeCharter({
      sourcesOfTruth: [
        globalSource,
        scopedSource,
        {
          accessPolicy: legacySource.accessPolicy,
          appliesTo: legacySource.appliesTo,
          description: legacySource.description,
          locator: legacySource.locator,
          type: legacySource.type,
          label: legacySource.label,
          id: legacySource.id,
          rank: legacySource.rank,
        },
      ],
    });

    expect(computeCharterHash(reordered)).toBe(computeCharterHash(a));
  });

  it("returns a 64-character hex sha256 digest", () => {
    expect(computeCharterHash(makeCharter())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when an invariant statement changes", () => {
    const withInvariant = makeCharter({
      invariants: [{ id: "inv", statement: "Original statement." }],
    });
    const edited = makeCharter({
      invariants: [{ id: "inv", statement: "Edited statement." }],
    });

    expect(computeCharterHash(edited)).not.toBe(
      computeCharterHash(withInvariant),
    );
  });

  it("changes when an invariant's context scope changes", () => {
    const firstScope = makeCharter({
      invariants: [
        {
          id: "inv",
          statement: "Keep this invariant true.",
          appliesTo: { contextIds: ["implement"] },
        },
      ],
    });
    const secondScope = makeCharter({
      invariants: [
        {
          id: "inv",
          statement: "Keep this invariant true.",
          appliesTo: { contextIds: ["verify"] },
        },
      ],
    });

    expect(computeCharterHash(secondScope)).not.toBe(
      computeCharterHash(firstScope),
    );
  });

  it("changes when a source's context scope changes", () => {
    const firstScope = makeCharter({
      sourcesOfTruth: [
        globalSource,
        { ...scopedSource, appliesTo: { contextIds: ["context-implement"] } },
      ],
    });
    const secondScope = makeCharter({
      sourcesOfTruth: [
        globalSource,
        { ...scopedSource, appliesTo: { contextIds: ["context-verify"] } },
      ],
    });

    expect(computeCharterHash(secondScope)).not.toBe(
      computeCharterHash(firstScope),
    );
  });

  it("changes when the highest-authority source's description changes", () => {
    const original = makeCharter();
    const edited = makeCharter({
      sourcesOfTruth: [
        { ...globalSource, description: "A different authoritative behavior." },
        scopedSource,
        legacySource,
      ],
    });

    expect(computeCharterHash(edited)).not.toBe(computeCharterHash(original));
  });
});

describe("renderCharterMarkdown", () => {
  it("includes the mission and the full ranked source list, scoped sources included", () => {
    const markdown = renderCharterMarkdown(makeCharter());

    expect(markdown).toContain(
      "Deliver a deterministic floor/round implementation.",
    );
    expect(markdown).toContain(globalSource.label);
    expect(markdown).toContain(scopedSource.label);
    expect(markdown).toContain(legacySource.label);
  });

  it("preserves structured scopes and the legacy applies-to/access-policy fields", () => {
    const markdown = renderCharterMarkdown(makeCharter());

    // The structured scope, joined; the legacy prose and access policy verbatim.
    expect(markdown).toContain(`- applies to: ${IN_SCOPE_CONTEXT}`);
    expect(markdown).toContain("- applies to: protocol shape");
    expect(markdown).toContain("- access policy: external-readonly");
  });

  it("includes the optional narrative sections when present", () => {
    const markdown = renderCharterMarkdown(makeCharter());

    expect(markdown).toContain("Prefer pure functions");
    expect(markdown).toContain("Do not change unrelated rounding utilities");
    expect(markdown).toContain("floor: round toward negative infinity");
    expect(markdown).toContain("Unit-test pure functions directly.");
    expect(markdown).toContain("Tie-breaking at .5 is intentionally bankers'.");
  });

  it("renders declared invariants with their ids", () => {
    const markdown = renderCharterMarkdown(
      makeCharter({
        invariants: [
          {
            id: "pinned-revision-targeting",
            statement: "Reads resolve against the pinned approved revision.",
          },
        ],
      }),
    );

    expect(markdown).toContain("pinned-revision-targeting");
    expect(markdown).toContain(
      "Reads resolve against the pinned approved revision.",
    );
  });

  it("renders the full untruncated source description (unlike the digest)", () => {
    const longDescription = "y".repeat(2000);
    const markdown = renderCharterMarkdown(
      makeCharter({
        sourcesOfTruth: [{ ...globalSource, description: longDescription }],
      }),
    );

    expect(markdown).toContain(longDescription);
  });

  it("is deterministic regardless of source input order", () => {
    const ordered = renderCharterMarkdown(
      makeCharter({ sourcesOfTruth: [globalSource, scopedSource] }),
    );
    const shuffled = renderCharterMarkdown(
      makeCharter({ sourcesOfTruth: [scopedSource, globalSource] }),
    );

    expect(shuffled).toBe(ordered);
  });
});

describe("renderCharterPromptSection", () => {
  it("begins with the context's digest and appends the full-charter pointer", () => {
    const section = renderCharterPromptSection(makeCharter(), IN_SCOPE_CONTEXT);

    expect(
      section.startsWith(renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT)),
    ).toBe(true);
    expect(section).toContain(
      `Full charter: read \`${CHARTER_DOCUMENT_PATH}\` on demand.`,
    );
  });

  it("includes a scoped source for its context and omits it for every other context", () => {
    const inScope = renderCharterPromptSection(makeCharter(), IN_SCOPE_CONTEXT);
    const outOfScope = renderCharterPromptSection(
      makeCharter(),
      OUT_OF_SCOPE_CONTEXT,
    );

    expect(inScope).toContain(scopedSource.label);
    expect(outOfScope).not.toContain(scopedSource.label);
    // Global sources render for both contexts.
    expect(inScope).toContain(globalSource.label);
    expect(outOfScope).toContain(globalSource.label);
  });

  it("carries no amendment, access-policy, precedence, or deferral text", () => {
    const section = renderCharterPromptSection(makeCharter(), IN_SCOPE_CONTEXT);
    const lowered = section.toLowerCase();

    expect(section).not.toContain("Amendment log");
    expect(section).not.toContain("Access:");
    expect(lowered).not.toContain("permission-gated");
    expect(lowered).not.toContain("higher-ranked source");
    expect(lowered).not.toContain("do not fail");
    expect(section).not.toContain("Applying the source-of-truth hierarchy");
  });

  it("appends role-specific extra instructions in the pointer block", () => {
    const citation = "Cite the governing source in your summary.";
    const section = renderCharterPromptSection(
      makeCharter(),
      IN_SCOPE_CONTEXT,
      [citation],
    );

    expect(section).toContain(citation);
    // The extra instruction shares the pointer block (single newline), not a
    // separate digest section.
    expect(section).toContain(
      `Full charter: read \`${CHARTER_DOCUMENT_PATH}\` on demand.\n${citation}`,
    );
  });

  it("omits the extra-instruction line when none are supplied", () => {
    const section = renderCharterPromptSection(makeCharter(), IN_SCOPE_CONTEXT);

    expect(section.endsWith("on demand.")).toBe(true);
  });
});

describe("amendment log rendering", () => {
  const amendments: CharterAmendment[] = [
    {
      seq: 1,
      amendedAt: "2026-07-29T10:00:00.000Z",
      source: "cli",
      rationale: "Invariant inv-2 was impossible against the shipped API",
      fieldsChanged: ["invariants"],
      charterHash: "hash-1",
    },
    {
      seq: 2,
      amendedAt: "2026-07-30T09:00:00.000Z",
      source: "ui",
      rationale: "Mission narrowed after descoping the importer",
      fieldsChanged: ["mission", "nonGoals"],
      charterHash: "hash-2",
    },
  ];

  it("renders the amendment log in the full markdown document, oldest first", () => {
    const markdown = renderCharterMarkdown(makeCharter(), amendments);
    expect(markdown).toContain("## Amendment log");
    expect(markdown).toContain(
      "Invariant inv-2 was impossible against the shipped API",
    );
    expect(markdown).toContain("Mission narrowed after descoping the importer");
    expect(markdown.indexOf("inv-2 was impossible")).toBeLessThan(
      markdown.indexOf("Mission narrowed"),
    );
    expect(markdown).toContain("2026-07-30");
    expect(markdown).toContain("mission, nonGoals");
  });

  it("omits the amendment section entirely when there are no amendments", () => {
    expect(renderCharterMarkdown(makeCharter())).not.toContain("Amendment log");
  });

  it("does not change the charter hash (content-only hashing)", () => {
    expect(computeCharterHash(makeCharter())).toBe(
      computeCharterHash(makeCharter()),
    );
  });

  it("never renders an amendment log in the prompt path (history lives in charter.md)", () => {
    expect(
      renderCharterPromptSection(makeCharter(), IN_SCOPE_CONTEXT),
    ).not.toContain("Amendment log");
    expect(renderCharterDigest(makeCharter(), IN_SCOPE_CONTEXT)).not.toContain(
      "Amendment log",
    );
  });
});

describe("renderCharterDocument", () => {
  it("lists global sources and leaves context-scoped sources to each context's prompt", () => {
    const document = renderCharterDocument(makeCharter());
    expect(document).toContain("Reference Prototype");
    expect(document).toContain("Upstream Spec");
    // The on-disk document is read by every context's agents, so naming a
    // source scoped to other contexts would advertise it to all of them.
    expect(document).not.toContain("Acceptance Criteria Doc");
    expect(document).not.toContain(scopedSource.locator);
  });

  it("matches the full markdown when no source is context-scoped", () => {
    const charter = makeCharter({
      sourcesOfTruth: [globalSource, legacySource],
    });
    expect(renderCharterDocument(charter)).toBe(renderCharterMarkdown(charter));
  });
});

describe("isDocumentInContextScope", () => {
  const charter = makeCharter();

  it("keeps a document that is no charter source in every context's scope", () => {
    expect(
      isDocumentInContextScope(charter, OUT_OF_SCOPE_CONTEXT, "notes.md"),
    ).toBe(true);
  });

  it("scopes a source document to the contexts its source applies to", () => {
    expect(
      isDocumentInContextScope(charter, IN_SCOPE_CONTEXT, scopedSource.locator),
    ).toBe(true);
    expect(
      isDocumentInContextScope(
        charter,
        OUT_OF_SCOPE_CONTEXT,
        scopedSource.locator,
      ),
    ).toBe(false);
  });

  it("keeps a globally sourced document in every context's scope", () => {
    expect(
      isDocumentInContextScope(
        charter,
        OUT_OF_SCOPE_CONTEXT,
        globalSource.locator,
      ),
    ).toBe(true);
  });
});
