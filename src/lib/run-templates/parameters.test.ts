import { describe, expect, it } from "vitest";
import {
  bindParameterValues,
  lintParameterTokens,
  substituteParameters,
} from "./parameters";

const declared = [
  { name: "ticket", description: "Ticket number", required: true },
  { name: "note", description: "Extra guidance", required: false },
];

/** A template content with a token in every substituted field. */
function content(overrides: Record<string, unknown> = {}) {
  return {
    name: "Fix a ticket",
    description: "Fixes one ticket",
    parameters: declared,
    defaults: {},
    workflow: {
      contexts: [
        {
          key: "fix",
          title: "Fix #{{inputs.ticket}}",
          brief: "Fix ticket {{inputs.ticket}}. {{inputs.note}}",
          tasks: [
            {
              title: "Reproduce {{inputs.ticket}}",
              instructions: "Write a failing test for {{inputs.ticket}}",
            },
          ],
          acceptanceCriteria: ["Ticket {{inputs.ticket}} no longer reproduces"],
        },
      ],
      charter: {
        mission: "Close {{inputs.ticket}}",
        conventions: ["Cite {{inputs.ticket}}"],
        nonGoals: ["Anything beyond {{inputs.ticket}}"],
        vocabulary: ["ticket: {{inputs.ticket}}"],
        testStrategy: "Regression test for {{inputs.ticket}}",
        knownAmbiguities: ["{{inputs.note}}"],
        invariants: [{ id: "scope", statement: "Only {{inputs.ticket}}" }],
        sourcesOfTruth: [
          {
            rank: 1,
            id: "ticket",
            label: "Ticket {{inputs.ticket}}",
            type: "other",
            locator: "tickets/{{inputs.ticket}}",
            description: "The report for {{inputs.ticket}}",
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("parameter lint", () => {
  it("accepts a declared token in every substituted field", () => {
    expect(lintParameterTokens(content())).toEqual([]);
  });

  it("refuses, in a substituted field, any {{ that is not a parameter token", () => {
    const issues = lintParameterTokens(
      content({
        workflow: {
          contexts: [
            {
              key: "fix",
              brief: "Fix {{ inputs.ticket }} and {{input.ticket}}",
              tasks: [{ title: "Deploy with ${{ secrets.TOKEN }}" }],
            },
          ],
        },
      }),
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      "workflow.contexts.0.brief",
      "workflow.contexts.0.brief",
      "workflow.contexts.0.tasks.0.title",
    ]);
    expect(issues[0]?.message).toContain("{{inputs.<name>}}");
  });

  it("refuses a token naming a parameter the template does not declare", () => {
    const issues = lintParameterTokens(
      content({
        workflow: {
          contexts: [{ key: "fix", brief: "Fix {{inputs.tickt}}" }],
        },
      }),
    );

    expect(issues).toEqual([
      {
        path: "workflow.contexts.0.brief",
        message: expect.stringContaining('"tickt"'),
      },
    ]);
  });

  it("refuses a parameter token where nothing is substituted, since it would stay literal", () => {
    const issues = lintParameterTokens(
      content({
        name: "Fix {{inputs.ticket}}",
        defaults: {
          reviewers: [{ authority: "blocking", focus: "{{inputs.note}}" }],
        },
        workflow: {
          contexts: [
            {
              key: "fix",
              brief: "Fix it",
              outputSchema: { description: "{{inputs.ticket}}" },
            },
          ],
          documents: [
            {
              path: "notes.md",
              contents: "See {{inputs.ticket}}",
              description: "Notes",
            },
          ],
        },
      }),
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      "name",
      "defaults.reviewers.0.focus",
      "workflow.contexts.0.outputSchema.description",
      "workflow.documents.0.contents",
    ]);
    expect(issues[0]?.message).toContain("never substituted");
  });

  it("accepts other {{ text where nothing is substituted, such as a frozen GitHub Actions file", () => {
    const issues = lintParameterTokens(
      content({
        workflow: {
          contexts: [{ key: "fix", brief: "Fix it" }],
          documents: [
            {
              path: ".github/workflows/ci.yml",
              contents:
                "run: echo ${{ inputs.ticket }} ${{inputs.ticket}} {{name}} {{ secrets.X }}",
              description: "CI",
            },
          ],
        },
      }),
    );

    expect(issues).toEqual([]);
  });

  it("reports every problem in one pass", () => {
    const issues = lintParameterTokens(
      content({
        workflow: {
          contexts: [
            { key: "a", brief: "{{inputs.missing}}" },
            {
              key: "b",
              brief: "{{bad}}",
              acceptanceCriteria: ["{{inputs.x}}"],
            },
          ],
        },
      }),
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      "workflow.contexts.0.brief",
      "workflow.contexts.1.brief",
      "workflow.contexts.1.acceptanceCriteria.0",
    ]);
  });
});

describe("parameter values at launch", () => {
  it("binds every declared value and leaves an omitted optional one empty", () => {
    expect(bindParameterValues(declared, { ticket: "42" })).toEqual({
      ok: true,
      values: { ticket: "42", note: "" },
    });
  });

  it("refuses unknown names and missing or blank required values, each at its parameter, all at once", () => {
    const bound = bindParameterValues(
      [...declared, { name: "area", description: "Area", required: true }],
      { ticket: "  ", owner: "alex" },
    );

    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.issues.map((issue) => issue.path).sort()).toEqual([
      "parameters.area",
      "parameters.owner",
      "parameters.ticket",
    ]);
  });
});

describe("parameter substitution", () => {
  it("replaces tokens in the substituted fields only", () => {
    const workflow = {
      contexts: [
        {
          key: "{{inputs.ticket}}",
          brief: "Fix {{inputs.ticket}}",
          outputSchema: { title: "{{inputs.ticket}}" },
          tasks: [
            {
              title: "T {{inputs.ticket}}",
              instructions: "I {{inputs.ticket}}",
            },
          ],
          acceptanceCriteria: ["C {{inputs.ticket}}"],
        },
      ],
      charter: {
        mission: "M {{inputs.ticket}}",
        invariants: [
          { id: "{{inputs.ticket}}", statement: "S {{inputs.ticket}}" },
        ],
      },
    };

    expect(substituteParameters(workflow, { ticket: "42" })).toEqual({
      contexts: [
        {
          key: "{{inputs.ticket}}",
          brief: "Fix 42",
          outputSchema: { title: "{{inputs.ticket}}" },
          tasks: [{ title: "T 42", instructions: "I 42" }],
          acceptanceCriteria: ["C 42"],
        },
      ],
      charter: {
        mission: "M 42",
        invariants: [{ id: "{{inputs.ticket}}", statement: "S 42" }],
      },
    });
  });

  it("inserts a value verbatim, never substituting a token the value itself contains", () => {
    const workflow = {
      contexts: [{ key: "a", brief: "{{inputs.a}} {{inputs.b}}" }],
    };

    expect(
      substituteParameters(workflow, { a: "{{inputs.b}}", b: "B" }),
    ).toEqual({ contexts: [{ key: "a", brief: "{{inputs.b}} B" }] });
  });

  it("refuses to leave a token without a value in place", () => {
    expect(() =>
      substituteParameters({ contexts: [{ brief: "{{inputs.x}}" }] }, {}),
    ).toThrow(/x/);
  });
});
