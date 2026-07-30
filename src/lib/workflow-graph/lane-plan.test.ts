import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowContextEdge,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { computeLanePlan, recomputeLanePlanForSubgraph } from "./lane-plan";
import { createResolvedWorkflowDefinition } from "./test-fixtures";

function makeDefinition(
  contexts: Array<{ id: string; taskCount?: number }>,
  edges: Array<[string, string]>,
): ResolvedWorkflowSemanticDefinition {
  const baseEdges: GraphWorkflowContextEdge[] = edges.map(
    ([source, target]) => ({
      id: `edge-${source}-${target}`,
      sourceContextId: source,
      targetContextId: target,
    }),
  );
  const tasks = contexts.flatMap((c) =>
    Array.from({ length: c.taskCount ?? 1 }).map((_, idx) => ({
      id: `${c.id}-task-${idx + 1}`,
      contextId: c.id,
      order: idx + 1,
      title: `Task ${idx + 1}`,
      instructions: "Do work.",
      source: "user" as const,
    })),
  );

  return createResolvedWorkflowDefinition({
    executionContexts: contexts.map((c) => ({
      id: c.id,
      title: c.id,
      acceptanceCriteria: "pass",
      implementer: {
        backend: "claude" as const,
        model: "opus" as const,
        reasoningEffort: "medium" as const,
      },
      contextValidator: null,
      scriptValidator: { enabled: false as const },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 1, continuity: { enabled: true } },
      planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    })),
    tasks,
    edges: baseEdges,
  });
}

describe("computeLanePlan", () => {
  it("returns empty plan for a workflow with no contexts", () => {
    const definition = makeDefinition([], []);
    const plan = computeLanePlan(definition);
    expect(plan.continuationMap).toEqual({});
    expect(plan.longestDownstreamPath).toEqual({});
  });

  it("computes longest downstream path for a linear chain", () => {
    const definition = makeDefinition(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const plan = computeLanePlan(definition);
    expect(plan.longestDownstreamPath).toEqual({ a: 2, b: 1, c: 0 });
  });

  it("creates a continuation entry for each parent with at least one child in a linear chain", () => {
    const definition = makeDefinition(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const plan = computeLanePlan(definition);
    expect(plan.continuationMap).toEqual({ a: "b", b: "c" });
  });

  it("at fan-out picks the child with the longest downstream path", () => {
    // p -> short
    // p -> long -> longer -> longest
    const definition = makeDefinition(
      [
        { id: "p" },
        { id: "short" },
        { id: "long" },
        { id: "longer" },
        { id: "longest" },
      ],
      [
        ["p", "short"],
        ["p", "long"],
        ["long", "longer"],
        ["longer", "longest"],
      ],
    );
    const plan = computeLanePlan(definition);
    expect(plan.continuationMap.p).toBe("long");
  });

  it("uses task count as the secondary tiebreaker when downstream paths tie", () => {
    // p has two children with the same downstream depth (both terminal),
    // but "heavy" has more tasks than "light".
    const definition = makeDefinition(
      [
        { id: "p", taskCount: 1 },
        { id: "light", taskCount: 1 },
        { id: "heavy", taskCount: 5 },
      ],
      [
        ["p", "light"],
        ["p", "heavy"],
      ],
    );
    const plan = computeLanePlan(definition);
    expect(plan.continuationMap.p).toBe("heavy");
  });

  it("uses workflow definition order as the final tiebreaker when path length and task count tie", () => {
    const definition = makeDefinition(
      [
        { id: "p", taskCount: 1 },
        { id: "first", taskCount: 2 },
        { id: "second", taskCount: 2 },
      ],
      [
        ["p", "first"],
        ["p", "second"],
      ],
    );
    const plan = computeLanePlan(definition);
    expect(plan.continuationMap.p).toBe("first");
  });

  it("handles multiple fan-out points independently", () => {
    // a -> b -> c1
    // a -> b -> c2 (b is chosen continuation by definition order tiebreak)
    // d -> e1 (single child)
    // d -> e2 (e1 is chosen by definition order)
    const definition = makeDefinition(
      [
        { id: "a" },
        { id: "b" },
        { id: "c1" },
        { id: "c2" },
        { id: "d" },
        { id: "e1" },
        { id: "e2" },
      ],
      [
        ["a", "b"],
        ["b", "c1"],
        ["b", "c2"],
        ["d", "e1"],
        ["d", "e2"],
      ],
    );
    const plan = computeLanePlan(definition);
    expect(plan.continuationMap.a).toBe("b");
    expect(plan.continuationMap.b).toBe("c1");
    expect(plan.continuationMap.d).toBe("e1");
  });

  it("does not emit continuation entries for terminal contexts", () => {
    const definition = makeDefinition([{ id: "a" }, { id: "b" }], [["a", "b"]]);
    const plan = computeLanePlan(definition);
    expect(Object.keys(plan.continuationMap)).toEqual(["a"]);
  });

  it("is deterministic: repeated computations on the same definition produce equal plans", () => {
    const definition = makeDefinition(
      [
        { id: "p" },
        { id: "x", taskCount: 3 },
        { id: "y", taskCount: 3 },
        { id: "z", taskCount: 3 },
      ],
      [
        ["p", "x"],
        ["p", "y"],
        ["p", "z"],
      ],
    );
    const first = computeLanePlan(definition);
    const second = computeLanePlan(definition);
    expect(first).toEqual(second);
  });
});

describe("recomputeLanePlanForSubgraph", () => {
  it("recomputes affected subgraph entries without touching unaffected entries", () => {
    const definition = makeDefinition(
      [{ id: "p" }, { id: "x" }, { id: "y" }, { id: "q" }, { id: "r" }],
      [
        ["p", "x"],
        ["p", "y"],
        ["q", "r"],
      ],
    );
    const initial = computeLanePlan(definition);

    // Pretend the user adds a runtime edit that affects q's subgraph only.
    const recomputed = recomputeLanePlanForSubgraph({
      definition,
      previousPlan: initial,
      contextIds: ["q"],
    });

    // Unrelated entries are preserved as-is.
    expect(recomputed.continuationMap.p).toBe(initial.continuationMap.p);
    expect(recomputed.continuationMap.q).toBe(initial.continuationMap.q);
  });

  it("recomputed plan equals a from-scratch plan when called over the entire workflow", () => {
    const definition = makeDefinition(
      [{ id: "p" }, { id: "short" }, { id: "long" }, { id: "longer" }],
      [
        ["p", "short"],
        ["p", "long"],
        ["long", "longer"],
      ],
    );
    const fromScratch = computeLanePlan(definition);
    const partial = recomputeLanePlanForSubgraph({
      definition,
      previousPlan: { continuationMap: {}, longestDownstreamPath: {} },
      contextIds: definition.executionContexts.map((c) => c.id),
    });
    expect(partial).toEqual(fromScratch);
  });
});
