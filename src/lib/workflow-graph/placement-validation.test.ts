import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import type {
  ContextPlacement,
  GraphWorkflowContextEdge,
  GraphWorkflowExecutionContextDefinition,
  WorkflowSemanticDefinition,
} from "./definition-schemas";
import { validateAuthoredDefinition } from "./validation";

function makeContext(
  id: string,
  placement: ContextPlacement,
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id,
    title: id,
    acceptanceCriteria: `${id} is done`,
    placement,
    ...overrides,
  };
}

function definitionOf(
  contexts: GraphWorkflowExecutionContextDefinition[],
  edges: GraphWorkflowContextEdge[] = [],
): WorkflowSemanticDefinition {
  return createWorkflowDefinition({
    executionContexts: contexts,
    tasks: contexts.map((context) => ({
      id: `task-${context.id}`,
      contextId: context.id,
      order: 1,
      title: "Do the work",
      instructions: "Do the work.",
      source: "user" as const,
    })),
    edges,
  });
}

function edge(sourceContextId: string, targetContextId: string) {
  return {
    id: `edge-${sourceContextId}-${targetContextId}`,
    sourceContextId,
    targetContextId,
  };
}

/** The create/replace/validate request body every authoring surface parses. */
function makePlan(definition: WorkflowSemanticDefinition) {
  return {
    name: "Placement Workflow",
    description: "A workflow under test",
    definition,
    layout: createWorkflowLayout(),
  };
}

/**
 * A raw plan body whose contexts are stripped of a field — the shape an author
 * (or a planning agent) actually submits when they omit placement entirely.
 */
function planWithoutContextField(
  definition: WorkflowSemanticDefinition,
  field: keyof GraphWorkflowExecutionContextDefinition,
): unknown {
  const body = makePlan(definition);
  return {
    ...body,
    definition: {
      ...body.definition,
      executionContexts: body.definition.executionContexts.map((context) => {
        const copy: Record<string, unknown> = { ...context };
        delete copy[field];
        return copy;
      }),
    },
  };
}

function messagesFrom(definition: WorkflowSemanticDefinition): string[] {
  return validateAuthoredDefinition(definition).errors.map(
    (error) => error.message,
  );
}

describe("placement grammar validation (R1)", () => {
  it("rejects a plan whose execution context declares no placement, naming the context id and the field path", () => {
    const definition = definitionOf([
      makeContext("context-solo", { lane: "solo", mode: "full" }),
    ]);

    const result = validateWorkflowPlan(
      planWithoutContextField(definition, "placement"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "definition.executionContexts.0.placement",
      message: expect.stringContaining('context "context-solo"'),
    });
  });

  it("accepts the three placement grades", () => {
    const definition = definitionOf([
      makeContext("context-full", { lane: "build", mode: "full" }),
      makeContext("context-owned", {
        lane: "docs",
        mode: "owned",
        ownedPaths: ["src/lib/workflow-graph", "docs/design/lanes.md"],
      }),
      makeContext(
        "context-reader",
        { lane: "session", mode: "readOnly" },
        {
          outputSchema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
      ),
    ]);

    expect(validateAuthoredDefinition(definition)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects a lane name outside the lane-id charset, naming the context and field path", () => {
    const definition = definitionOf([
      makeContext("context-solo", { lane: "build lane/1", mode: "full" }),
    ]);

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-lane-name-invalid",
        contextId: "context-solo",
        field: "executionContexts.0.placement.lane",
        message: expect.stringContaining("build lane/1"),
      }),
    );
  });

  it.each([
    ["a leading dot", ".hidden"],
    ["a leading dash", "-lane"],
    ["a parent-directory pair", "a..b"],
    ["a trailing dot", "lane."],
    ["a git ref lock suffix", "lane.lock"],
  ])("rejects a lane name with %s", (_label, lane) => {
    const definition = definitionOf([
      makeContext("context-solo", { lane, mode: "full" }),
    ]);

    expect(
      validateAuthoredDefinition(definition).errors.map((e) => e.code),
    ).toContain("placement-lane-name-invalid");
  });

  it("refuses the internal session lane id as an authored lane name", () => {
    const definition = definitionOf([
      makeContext("context-solo", { lane: "__session__", mode: "readOnly" }),
    ]);

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-reserved-lane-name",
        contextId: "context-solo",
        field: "executionContexts.0.placement.lane",
        message: expect.stringContaining("session"),
      }),
    );
  });

  it.each([["full"], ["owned"]] as const)(
    "refuses the reserved session lane as a group lane for a %s context",
    (mode) => {
      const placement: ContextPlacement =
        mode === "full"
          ? { lane: "session", mode: "full" }
          : { lane: "session", mode: "owned", ownedPaths: ["src/lib"] };
      const definition = definitionOf([
        makeContext("context-writer", placement),
      ]);

      const result = validateAuthoredDefinition(definition);

      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "placement-session-lane-write-capable",
          contextId: "context-writer",
          field: "executionContexts.0.placement.lane",
        }),
      );
    },
  );

  it("rejects a read-only context that declares no output schema (R4.2)", () => {
    const definition = definitionOf([
      makeContext("context-reader", { lane: "session", mode: "readOnly" }),
    ]);

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-readonly-missing-output-schema",
        contextId: "context-reader",
        field: "executionContexts.0.outputSchema",
        message: expect.stringContaining("context-reader"),
      }),
    );
  });

  it("accepts a read-only context that declares an output schema (R4.2)", () => {
    const definition = definitionOf([
      makeContext(
        "context-reader",
        { lane: "readers", mode: "readOnly" },
        {
          outputSchema: {
            type: "object",
            properties: { findings: { type: "string" } },
            required: ["findings"],
          },
        },
      ),
    ]);

    expect(validateAuthoredDefinition(definition).ok).toBe(true);
  });

  it("does not require an output schema from write-capable contexts", () => {
    const definition = definitionOf([
      makeContext("context-full", { lane: "build", mode: "full" }),
      makeContext("context-owned", {
        lane: "docs",
        mode: "owned",
        ownedPaths: ["docs"],
      }),
    ]);

    expect(messagesFrom(definition)).toEqual([]);
  });
});

describe("owned path grammar (R1.2)", () => {
  function planWithOwnedPaths(ownedPaths: string[]): unknown {
    return makePlan(
      definitionOf([
        makeContext("context-owned", {
          lane: "build",
          mode: "owned",
          ownedPaths,
        }),
      ]),
    );
  }

  it.each([
    ["an absolute POSIX path", "/etc/passwd"],
    ["a Windows drive path", "C:/repo/src"],
    ["a backslash path", "src\\lib"],
    ["an escaping parent segment", "../outside"],
    ["an interior parent segment", "src/../../outside"],
    ["a non-normalized current segment", "src/./lib"],
    ["a doubled separator", "src//lib"],
    ["a trailing separator", "src/lib/"],
    ["untrimmed whitespace", " src/lib"],
    ["the repository root", "."],
    ["repository metadata", ".git"],
    ["a path under repository metadata", ".git/hooks/pre-commit"],
    ["case-varied repository metadata", ".GIT/config"],
  ])("rejects %s as an owned path", (_label, ownedPath) => {
    const result = validateWorkflowPlan(planWithOwnedPaths([ownedPath]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "definition.executionContexts.0.placement.ownedPaths.0",
      }),
    );
  });

  it("rejects an empty ownedPaths array on an owning context", () => {
    const result = validateWorkflowPlan(planWithOwnedPaths([]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "definition.executionContexts.0.placement.ownedPaths",
        message: expect.stringContaining("readOnly"),
      }),
    );
  });

  it.each([["full"], ["readOnly"]] as const)(
    "rejects ownedPaths declared on a %s placement",
    (mode) => {
      const plan = makePlan(
        definitionOf([
          makeContext("context-solo", { lane: "build", mode: "full" }),
        ]),
      );
      const body = {
        ...plan,
        definition: {
          ...plan.definition,
          executionContexts: plan.definition.executionContexts.map(
            (context) => ({
              ...context,
              placement: { lane: "build", mode, ownedPaths: ["src/lib"] },
              ...(mode === "readOnly"
                ? { outputSchema: { type: "object" } }
                : {}),
            }),
          ),
        },
      };

      const result = validateWorkflowPlan(body);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.issues.some((issue) =>
          issue.path.startsWith("definition.executionContexts.0.placement"),
        ),
      ).toBe(true);
    },
  );

  it("accepts normalized repo-relative file and directory prefixes", () => {
    const result = validateWorkflowPlan(
      planWithOwnedPaths([
        "src/lib/workflow-graph",
        "docs/design/cc-cli/02.md",
        "AGENTS.md",
        ".kiro/steering/workflows.md",
      ]),
    );

    expect(result.ok).toBe(true);
  });
});

describe("same-lane concurrency and ownership disjointness (R5)", () => {
  function owning(id: string, lane: string, ownedPaths: string[]) {
    return makeContext(id, { lane, mode: "owned", ownedPaths });
  }

  it("rejects a concurrency-comparable same-lane pair whose member declares full access", () => {
    const definition = definitionOf([
      makeContext("context-a", { lane: "shared", mode: "full" }),
      owning("context-b", "shared", ["src/lib/b"]),
    ]);

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-full-access-concurrency",
        contextId: "context-a",
        field: "executionContexts.0.placement",
        message: expect.stringMatching(
          /"context-a".*"context-b"|"context-b".*"context-a"/,
        ),
      }),
    );
  });

  it("rejects two full-access members of one lane that nothing orders", () => {
    const definition = definitionOf([
      makeContext("context-a", { lane: "shared", mode: "full" }),
      makeContext("context-b", { lane: "shared", mode: "full" }),
    ]);

    expect(
      validateAuthoredDefinition(definition).errors.map((e) => e.code),
    ).toContain("placement-full-access-concurrency");
  });

  it("accepts a full-access member dependency-ordered against every other write-capable lane member", () => {
    const definition = definitionOf(
      [
        makeContext("context-a", { lane: "shared", mode: "full" }),
        owning("context-b", "shared", ["src/lib/b"]),
        owning("context-c", "shared", ["src/lib/c"]),
      ],
      [edge("context-a", "context-b"), edge("context-a", "context-c")],
    );

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("rejects a full-access member ordered against one lane member but not every other", () => {
    const definition = definitionOf(
      [
        makeContext("context-a", { lane: "shared", mode: "full" }),
        owning("context-b", "shared", ["src/lib/b"]),
        owning("context-c", "shared", ["src/lib/c"]),
      ],
      [edge("context-a", "context-b")],
    );

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    const messages = result.errors
      .filter((e) => e.code === "placement-full-access-concurrency")
      .map((e) => e.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("context-a");
    expect(messages[0]).toContain("context-c");
    expect(messages[0]).not.toContain("context-b");
  });

  it("orders a full-access member transitively, not just across a direct edge", () => {
    const definition = definitionOf(
      [
        makeContext("context-a", { lane: "shared", mode: "full" }),
        makeContext("context-relay", { lane: "shared", mode: "full" }),
        owning("context-b", "shared", ["src/lib/b"]),
      ],
      [edge("context-a", "context-relay"), edge("context-relay", "context-b")],
    );

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it.each([
    ["equal prefixes", "src/lib/shared", "src/lib/shared"],
    ["a nested prefix", "src/lib", "src/lib/shared"],
    [
      "a nested prefix declared in the other order",
      "src/lib/shared",
      "src/lib",
    ],
    ["a file nested under a claimed directory", "src", "src/index.ts"],
  ])("rejects concurrent owning members sharing %s", (_label, left, right) => {
    const definition = definitionOf([
      owning("context-a", "shared", [left]),
      owning("context-b", "shared", [right]),
    ]);

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-owned-paths-overlap",
        contextId: "context-a",
        field: "executionContexts.0.placement",
        message: expect.stringContaining("context-b"),
      }),
    );
  });

  it("rejects concurrent owning members whose multi-entry prefix sets collide on a single entry, naming that entry pair", () => {
    const definition = definitionOf([
      owning("context-a", "shared", ["src/lib/a", "docs/design", "AGENTS.md"]),
      owning("context-b", "shared", ["src/lib/b", "docs/design/lanes.md"]),
    ]);

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-owned-paths-overlap",
        contextId: "context-a",
        message: expect.stringContaining(
          '"docs/design" and "docs/design/lanes.md"',
        ),
      }),
    );
  });

  it("accepts concurrent owning members whose prefixes only share a name prefix, not a path prefix", () => {
    const definition = definitionOf([
      owning("context-a", "shared", ["src/lib"]),
      owning("context-b", "shared", ["src/libraries"]),
    ]);

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("accepts dependency-ordered members that own the same paths", () => {
    const definition = definitionOf(
      [
        owning("context-a", "shared", ["src/lib/shared"]),
        owning("context-b", "shared", ["src/lib/shared"]),
      ],
      [edge("context-a", "context-b")],
    );

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("exempts read-only members: they are concurrency-safe with anyone on their lane", () => {
    const reader = makeContext(
      "context-reader",
      { lane: "shared", mode: "readOnly" },
      { outputSchema: { type: "object" } },
    );
    const definition = definitionOf([
      makeContext("context-full", { lane: "shared", mode: "full" }),
      reader,
      makeContext(
        "context-reader-2",
        { lane: "shared", mode: "readOnly" },
        { outputSchema: { type: "object" } },
      ),
    ]);

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("scopes the analysis to one lane: identical ownership on different lanes is fine", () => {
    const definition = definitionOf([
      owning("context-a", "lane-one", ["src/lib/shared"]),
      owning("context-b", "lane-two", ["src/lib/shared"]),
    ]);

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("names both contexts of every offending pair when a lane has three concurrent members", () => {
    const definition = definitionOf([
      owning("context-a", "shared", ["src/lib"]),
      owning("context-b", "shared", ["src/lib/b"]),
      owning("context-c", "shared", ["src/lib/c"]),
    ]);

    const messages = validateAuthoredDefinition(definition)
      .errors.filter((e) => e.code === "placement-owned-paths-overlap")
      .map((e) => e.message);

    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.includes("context-b"))).toBe(true);
    expect(messages.some((m) => m.includes("context-c"))).toBe(true);
  });
});

describe("lane dependency acyclicity", () => {
  it("rejects a context DAG whose authored lanes contract into a cycle", () => {
    const definition = definitionOf(
      [
        makeContext("context-a", { lane: "shared", mode: "full" }),
        makeContext("context-x", { lane: "target", mode: "full" }),
        makeContext("context-c", { lane: "target", mode: "full" }),
        makeContext("context-b", { lane: "shared", mode: "full" }),
      ],
      [
        edge("context-a", "context-c"),
        edge("context-x", "context-c"),
        edge("context-c", "context-b"),
      ],
    );

    const result = validateAuthoredDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "placement-lane-dependency-cycle",
        message: expect.stringContaining("shared → target → shared"),
      }),
    );
  });

  it("does not contract the read-only session sentinel into the group-lane graph", () => {
    const definition = definitionOf(
      [
        makeContext("context-a", { lane: "build", mode: "full" }),
        makeContext(
          "context-reader",
          { lane: "session", mode: "readOnly" },
          { outputSchema: { type: "object" } },
        ),
        makeContext("context-b", { lane: "build", mode: "full" }),
      ],
      [
        edge("context-a", "context-reader"),
        edge("context-reader", "context-b"),
      ],
    );

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });
});
