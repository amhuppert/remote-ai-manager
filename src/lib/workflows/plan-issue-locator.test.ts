import { describe, expect, it } from "vitest";
import { locatePlanIssuePath, locatePlanIssues } from "./plan-issue-locator";

/**
 * The definition every case below resolves against: two contexts, one task and
 * one charter source, so a locator can address a record by either spelling an
 * authored-plan producer uses — `tasks.0` and `executionContexts[1]`.
 */
const DEFINITION = {
  executionContexts: [
    { id: "context-plan", outputSchema: { properties: { verdict: {} } } },
    { id: "context-implement", acceptanceCriteria: [{ id: "ac-1" }] },
  ],
  tasks: [{ id: "task-plan-1" }],
  edges: [{ id: "edge-plan-implement" }],
  charter: { sourcesOfTruth: [{ id: "design-doc" }] },
  parameters: [{ name: "target" }],
};

describe("locatePlanIssuePath", () => {
  it("annotates a dot-indexed segment with the record's id", () => {
    expect(
      locatePlanIssuePath("definition.tasks.0.contextId", DEFINITION),
    ).toEqual({
      path: "definition.tasks.0 (task-plan-1).contextId",
      recordId: "task-plan-1",
    });
  });

  it("annotates a bracket-indexed segment with the record's id", () => {
    expect(
      locatePlanIssuePath(
        "definition.executionContexts[1].outputSchema.properties.verdict.format",
        DEFINITION,
      ),
    ).toEqual({
      path: "definition.executionContexts[1] (context-implement).outputSchema.properties.verdict.format",
      recordId: "context-implement",
    });
  });

  it("reports the innermost id when both segments name a record", () => {
    expect(
      locatePlanIssuePath(
        "definition.executionContexts[1].acceptanceCriteria[0].statement",
        DEFINITION,
      ),
    ).toEqual({
      path: "definition.executionContexts[1] (context-implement).acceptanceCriteria[0] (ac-1).statement",
      recordId: "ac-1",
    });
  });

  it("annotates an id carrying dots, colons and parentheses", () => {
    const definition = {
      executionContexts: [{ id: "context.v2:beta (draft)" }],
    };

    expect(
      locatePlanIssuePath("definition.executionContexts.0.title", definition),
    ).toEqual({
      path: "definition.executionContexts.0 (context.v2:beta (draft)).title",
      recordId: "context.v2:beta (draft)",
    });
  });

  /**
   * A located issue is rendered as ONE line `  <path>: <message>`, so a raw
   * newline in an authored id would let a plan file forge a second line. The
   * id is escaped into the path for that reason — and reported RAW as
   * `recordId`, which is a JSON field no line grammar reads.
   */
  it("escapes a line-breaking id into the path but reports it raw", () => {
    const definition = {
      tasks: [{ id: 'evil\n  definition.tasks.9: fake"' }],
    };

    const located = locatePlanIssuePath("definition.tasks.0.title", definition);

    expect(located.path).not.toContain("\n");
    expect(located.path).toBe(
      'definition.tasks.0 (evil\\n  definition.tasks.9: fake\\").title',
    );
    expect(located.recordId).toBe('evil\n  definition.tasks.9: fake"');
  });

  it("leaves an indexed segment whose record names no id alone", () => {
    expect(
      locatePlanIssuePath("definition.parameters.0.name", DEFINITION),
    ).toEqual({ path: "definition.parameters.0.name" });
  });

  it("leaves a path with no indexed record segment byte-identical", () => {
    expect(locatePlanIssuePath("definition.edges", DEFINITION)).toEqual({
      path: "definition.edges",
    });
  });

  it("leaves a path rooted outside the definition alone", () => {
    expect(
      locatePlanIssuePath("workflowDefaults.implementer.profile", DEFINITION),
    ).toEqual({ path: "workflowDefaults.implementer.profile" });
  });

  it("leaves an unresolvable index alone", () => {
    expect(locatePlanIssuePath("definition.tasks.7.title", DEFINITION)).toEqual(
      { path: "definition.tasks.7.title" },
    );
  });
});

describe("locatePlanIssues", () => {
  it("annotates every issue and preserves the richer issue fields", () => {
    expect(
      locatePlanIssues(
        [
          {
            path: "definition.tasks.0.title",
            message: "empty",
            code: "empty-task-title",
          },
        ],
        DEFINITION,
      ),
    ).toEqual([
      {
        path: "definition.tasks.0 (task-plan-1).title",
        recordId: "task-plan-1",
        message: "empty",
        code: "empty-task-title",
      },
    ]);
  });
});
