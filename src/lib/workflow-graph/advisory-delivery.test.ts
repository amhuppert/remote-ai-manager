import { describe, expect, it } from "vitest";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";
import type { WorkflowValidatorAdvisory } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowValidationAdvisory,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import {
  ADVISORY_NON_BINDING_FRAMING,
  advisoryIdentityKey,
  buildAdvisoryDispositionsOutputSchema,
  buildAdvisoryFailureAppendix,
  buildAdvisoryResponsePrompt,
  collectFreshAdvisories,
  parseAdvisoryDispositions,
  stampAdvisoryIdentities,
} from "@/lib/workflow-graph/advisory-delivery";

function advisory(
  overrides: Partial<WorkflowValidatorAdvisory> = {},
): WorkflowValidatorAdvisory {
  return {
    kind: "implementation",
    title: "Extract the retry loop",
    description: "The retry loop is duplicated across both runners.",
    ...overrides,
  };
}

function record(
  overrides: Partial<GraphWorkflowValidationAdvisory> & {
    identity: GraphWorkflowValidationAdvisory["identity"];
  },
): GraphWorkflowValidationAdvisory {
  return {
    kind: "implementation",
    title: `advisory ${overrides.identity.ordinal}`,
    description: `body ${overrides.identity.ordinal}`,
    deliveredAt: null,
    disposition: null,
    ...overrides,
  };
}

function roundWith(
  specialists: Record<string, GraphWorkflowValidationAdvisory[]>,
  rosterOrder: string[],
): GraphWorkflowValidationRound {
  return {
    seq: 3,
    candidate: {
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-a",
      taskStateHash: "state-a",
    },
    roster: rosterOrder.map((assignmentId) => ({
      assignmentId,
      profileRef: { tier: "builtin" as const, id: "general" },
      revision: 1,
      resolvedInstructionHash: "hash",
    })),
    specialists: Object.fromEntries(
      Object.entries(specialists).map(([assignmentId, advisories]) => [
        assignmentId,
        {
          state: "verdict_pass" as const,
          attempts: 0,
          summary: null,
          issues: [],
          advisories,
          questionToken: null,
          sessionRef: null,
          reviewArtifact: null,
          lastInfraFailure: null,
        },
      ]),
    ),
    phase: "specialists",
    outcome: null,
    startedAt: "2026-08-04T12:00:00.000Z",
  };
}

describe("advisory identity", () => {
  it("stamps {roundSeq, assignmentId, ordinal} from the engine, ordinals 1-based per lane", () => {
    const stamped = stampAdvisoryIdentities({
      roundSeq: 7,
      assignmentId: "security-reviewer",
      advisories: [
        advisory({ title: "first" }),
        advisory({ title: "second", kind: "out_of_scope" }),
      ],
    });

    expect(stamped.map((entry) => entry.identity)).toEqual([
      { roundSeq: 7, assignmentId: "security-reviewer", ordinal: 1 },
      { roundSeq: 7, assignmentId: "security-reviewer", ordinal: 2 },
    ]);
    expect(stamped.map((entry) => entry.title)).toEqual(["first", "second"]);
    expect(stamped.map((entry) => entry.kind)).toEqual([
      "implementation",
      "out_of_scope",
    ]);
  });

  it("records a stamped advisory as undelivered with no disposition", () => {
    const [stamped] = stampAdvisoryIdentities({
      roundSeq: 1,
      assignmentId: "general",
      advisories: [advisory()],
    });

    expect(stamped).toMatchObject({ deliveredAt: null, disposition: null });
  });
});

describe("collectFreshAdvisories", () => {
  it("collects undelivered advisories in roster order, then ordinal order", () => {
    const round = roundWith(
      {
        "perf-reviewer": [
          record({
            identity: { roundSeq: 3, assignmentId: "perf", ordinal: 1 },
          }),
        ],
        "security-reviewer": [
          record({
            identity: { roundSeq: 3, assignmentId: "security", ordinal: 2 },
          }),
          record({
            identity: { roundSeq: 3, assignmentId: "security", ordinal: 1 },
          }),
        ],
      },
      ["security-reviewer", "perf-reviewer"],
    );

    expect(
      collectFreshAdvisories(round).map((entry) =>
        advisoryIdentityKey(entry.identity),
      ),
    ).toEqual(["3:security:1", "3:security:2", "3:perf:1"]);
  });

  it("skips advisories already delivered in this round", () => {
    const round = roundWith(
      {
        general: [
          record({
            identity: { roundSeq: 3, assignmentId: "general", ordinal: 1 },
            deliveredAt: "2026-08-04T12:00:00.000Z",
          }),
          record({
            identity: { roundSeq: 3, assignmentId: "general", ordinal: 2 },
          }),
        ],
      },
      ["general"],
    );

    expect(collectFreshAdvisories(round)).toHaveLength(1);
    expect(collectFreshAdvisories(round)[0]?.identity.ordinal).toBe(2);
  });
});

describe("non-binding framing", () => {
  it("pins the framing text", () => {
    expect(ADVISORY_NON_BINDING_FRAMING).toBe(
      [
        "These advisories are NOT requirements. None of them reopened a task, none of them",
        "failed this execution context, and none of them obliges you to change your work.",
        "Act on an advisory only where you judge it right. You may decline any of them, and",
        "a one-line reason is all a decline needs.",
      ].join("\n"),
    );
  });

  it("carries the framing into both delivery paths", () => {
    const advisories = stampAdvisoryIdentities({
      roundSeq: 2,
      assignmentId: "general",
      advisories: [advisory()],
    });

    expect(buildAdvisoryFailureAppendix(advisories)).toContain(
      ADVISORY_NON_BINDING_FRAMING,
    );
    expect(
      buildAdvisoryResponsePrompt({ contextTitle: "Plan", advisories }),
    ).toContain(ADVISORY_NON_BINDING_FRAMING);
  });

  it("names every advisory by its engine-stamped identity in the response turn", () => {
    const advisories = stampAdvisoryIdentities({
      roundSeq: 2,
      assignmentId: "security-reviewer",
      advisories: [advisory({ title: "Rotate the token" })],
    });

    const prompt = buildAdvisoryResponsePrompt({
      contextTitle: "Plan",
      advisories,
    });
    expect(prompt).toContain("2:security-reviewer:1");
    expect(prompt).toContain("Rotate the token");
  });
});

describe("dispositions output schema", () => {
  const advisories = stampAdvisoryIdentities({
    roundSeq: 4,
    assignmentId: "general",
    advisories: [advisory({ title: "one" }), advisory({ title: "two" })],
  });
  const schema = buildAdvisoryDispositionsOutputSchema(advisories);

  function validate(dispositions: unknown[]): { valid: boolean } {
    return validateJsonSchemaSubset(schema, { dispositions });
  }

  const identityOne = { roundSeq: 4, assignmentId: "general", ordinal: 1 };
  const identityTwo = { roundSeq: 4, assignmentId: "general", ordinal: 2 };

  it("accepts addressed and deferred entries carrying a null reason", () => {
    expect(
      validate([
        { identity: identityOne, disposition: "addressed", reason: null },
        { identity: identityTwo, disposition: "deferred", reason: null },
      ]).valid,
    ).toBe(true);
  });

  it("refuses an entry that omits the reason field", () => {
    expect(
      validate([
        { identity: identityOne, disposition: "addressed" },
        { identity: identityTwo, disposition: "deferred", reason: null },
      ]).valid,
    ).toBe(false);
  });

  it("accepts a declined entry carrying a reason", () => {
    expect(
      validate([
        {
          identity: identityOne,
          disposition: "declined",
          reason: "The duplication is deliberate.",
        },
        { identity: identityTwo, disposition: "addressed", reason: null },
      ]).valid,
    ).toBe(true);
  });

  it("refuses an entry count other than one per delivered advisory", () => {
    expect(
      validate([
        { identity: identityOne, disposition: "addressed", reason: null },
      ]).valid,
    ).toBe(false);
  });

  it("refuses a disposition outside the approved vocabulary", () => {
    expect(
      validate([
        { identity: identityOne, disposition: "acknowledged", reason: null },
        { identity: identityTwo, disposition: "addressed", reason: null },
      ]).valid,
    ).toBe(false);
  });
});

describe("parseAdvisoryDispositions", () => {
  const delivered = stampAdvisoryIdentities({
    roundSeq: 5,
    assignmentId: "general",
    advisories: [advisory({ title: "one" }), advisory({ title: "two" })],
  });
  const identityOne = { roundSeq: 5, assignmentId: "general", ordinal: 1 };
  const identityTwo = { roundSeq: 5, assignmentId: "general", ordinal: 2 };

  it("accepts one disposition per delivered advisory", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          { identity: identityTwo, disposition: "deferred", reason: null },
          {
            identity: identityOne,
            disposition: "declined",
            reason: "Out of this context's scope.",
          },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dispositions).toEqual([
      {
        identity: identityOne,
        disposition: "declined",
        reason: "Out of this context's scope.",
      },
      { identity: identityTwo, disposition: "deferred", reason: null },
    ]);
  });

  it("refuses a set that misses a delivered advisory", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          { identity: identityOne, disposition: "addressed", reason: null },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(" ")).toContain("5:general:2");
  });

  it("refuses a set naming an advisory that was never delivered", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          { identity: identityOne, disposition: "addressed", reason: null },
          { identity: identityTwo, disposition: "addressed", reason: null },
          {
            identity: { roundSeq: 5, assignmentId: "general", ordinal: 3 },
            disposition: "addressed",
            reason: null,
          },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(" ")).toContain("5:general:3");
  });

  it("refuses the same advisory disposed twice", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          { identity: identityOne, disposition: "addressed", reason: null },
          { identity: identityOne, disposition: "deferred", reason: null },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(" ")).toContain("5:general:1");
  });

  it("refuses a declined disposition with no reason, naming only that advisory", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          { identity: identityOne, disposition: "declined", reason: null },
          { identity: identityTwo, disposition: "addressed", reason: null },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toContain("5:general:1");
  });

  it("refuses a declined disposition whose reason is blank", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          { identity: identityOne, disposition: "declined", reason: "   " },
          { identity: identityTwo, disposition: "addressed", reason: null },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toContain("5:general:1");
  });

  it("records a reason trimmed, and a blank one as none", () => {
    const parsed = parseAdvisoryDispositions({
      structuredOutput: {
        dispositions: [
          {
            identity: identityOne,
            disposition: "declined",
            reason: "  Deliberate duplication.  ",
          },
          { identity: identityTwo, disposition: "addressed", reason: "" },
        ],
      },
      delivered,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dispositions).toEqual([
      {
        identity: identityOne,
        disposition: "declined",
        reason: "Deliberate duplication.",
      },
      { identity: identityTwo, disposition: "addressed", reason: null },
    ]);
  });

  it("refuses a payload that is not the dispositions envelope", () => {
    expect(
      parseAdvisoryDispositions({ structuredOutput: null, delivered }).ok,
    ).toBe(false);
  });
});
