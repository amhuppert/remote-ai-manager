import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import {
  addAcceptanceCriterion,
  addContextDependency,
  addExecutionContext,
  addTaskToContext,
  clearContextBlockOverride,
  clearWorkflowConfigOverride,
  deleteExecutionContext,
  moveAcceptanceCriterion,
  moveTaskWithinContext,
  removeAcceptanceCriterion,
  setContextBlockOverride,
  setContextOutputSchema,
  setWorkflowConfigOverride,
  updateAcceptanceCriterionStatement,
  updateContextPosition,
  updateExecutionContext,
} from "./builder-draft";
import { validatePlacements } from "./placement-validation";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";

describe("workflow builder draft helpers", () => {
  it("adds an execution context with only id, title, empty acceptance criteria, and a lane of its own", () => {
    const result = addExecutionContext({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });

    expect(result.contextId).toBe("context-4");
    const added = result.definition.executionContexts.at(-1);
    expect(added).toEqual({
      id: "context-4",
      title: "Execution Context 4",
      // Still the empty-prose seed: the inspector panel renders this value as
      // a string until the builder-cli-surfaces slice swaps both together.
      // The criterion mutators below normalize it to records on first edit.
      acceptanceCriteria: "",
      // A single-member lane of its own is what the builder can safely assume
      // for a context nobody has placed yet.
      placement: { lane: "context-4", mode: "full" },
    });
    expect(result.layout.contextPositions["context-4"]).toEqual({
      x: 1080,
      y: 0,
    });
  });

  it("creates contexts whose placement the accept-time gate accepts", () => {
    // Two adds in a row: the second must not land on the first one's lane, or
    // the builder would author a collision the author never asked for.
    const once = addExecutionContext({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });
    const twice = addExecutionContext(once);

    expect(validatePlacements(twice.definition)).toEqual([]);
    expect(
      twice.definition.executionContexts
        .slice(-2)
        .map((context) => context.placement),
    ).toEqual([
      { lane: "context-4", mode: "full" },
      { lane: "context-5", mode: "full" },
    ]);
  });

  it("authors a grouped placement through updateExecutionContext", () => {
    const definition = updateExecutionContext(
      createWorkflowDefinition(),
      "context-plan",
      {
        placement: {
          lane: "delivery",
          mode: "owned",
          ownedPaths: ["docs"],
        },
      },
    );

    expect(
      definition.executionContexts.find(
        (context) => context.id === "context-plan",
      )?.placement,
    ).toEqual({ lane: "delivery", mode: "owned", ownedPaths: ["docs"] });
    expect(validatePlacements(definition)).toEqual([]);
  });

  it("removes an execution context together with its tasks and edges", () => {
    const result = deleteExecutionContext(
      {
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      },
      "context-implement",
    );

    expect(
      result.definition.executionContexts.map((context) => context.id),
    ).toEqual(["context-plan", "context-verify"]);
    expect(result.definition.tasks.map((task) => task.contextId)).toEqual([
      "context-plan",
      "context-verify",
    ]);
    expect(result.definition.edges).toEqual([]);
    expect(result.layout.contextPositions["context-implement"]).toBeUndefined();
  });

  it("rejects duplicate or cyclic dependencies", () => {
    const duplicate = addContextDependency(
      createWorkflowDefinition(),
      "context-plan",
      "context-implement",
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors[0]?.code).toBe("duplicate-edge");

    const cycle = addContextDependency(
      createWorkflowDefinition(),
      "context-verify",
      "context-plan",
    );
    expect(cycle.ok).toBe(false);
    expect(cycle.errors).toContainEqual(
      expect.objectContaining({ code: "cycle-detected" }),
    );
  });

  it("adds tasks and preserves ordered reordering within the selected context", () => {
    const withTask = addTaskToContext(
      createWorkflowDefinition(),
      "context-plan",
    );
    expect(
      withTask.definition.tasks
        .filter((task) => task.contextId === "context-plan")
        .map((task) => [task.id, task.order, task.title]),
    ).toEqual([
      ["task-plan-1", 1, "Inspect code"],
      ["task-context-plan-2", 2, "New Task 2"],
    ]);

    const reordered = moveTaskWithinContext(
      withTask.definition,
      "context-plan",
      "task-context-plan-2",
      "up",
    );

    expect(
      reordered.tasks
        .filter((task) => task.contextId === "context-plan")
        .map((task) => [task.id, task.order]),
    ).toEqual([
      ["task-context-plan-2", 1],
      ["task-plan-1", 2],
    ]);
  });

  it("updates execution-context positions without mutating other nodes", () => {
    const result = updateContextPosition(
      createWorkflowLayout(),
      "context-verify",
      { x: 900, y: 120 },
    );

    expect(result.contextPositions["context-verify"]).toEqual({
      x: 900,
      y: 120,
    });
    expect(result.contextPositions["context-plan"]).toEqual({ x: 0, y: 0 });
  });

  it("setContextBlockOverride writes the named block on the matching context", () => {
    const result = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-implement",
      "implementer",
      {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
      },
    );

    const target = result.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect(target?.implementer).toEqual({
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
    });
    const other = result.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(other?.implementer).toEqual({
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
    });
  });

  it("round-trips a planRepair context override through set/clear", () => {
    const overridden = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-plan",
      "planRepair",
      { enabled: false, maxAttemptsPerContext: 1 },
    );
    expect(
      overridden.executionContexts.find((c) => c.id === "context-plan")
        ?.planRepair,
    ).toEqual({ enabled: false, maxAttemptsPerContext: 1 });

    const cleared = clearContextBlockOverride(
      overridden,
      "context-plan",
      "planRepair",
    );
    expect(
      cleared.executionContexts.find((c) => c.id === "context-plan")
        ?.planRepair,
    ).toBeUndefined();
  });

  it("clearContextBlockOverride deletes the named block so it inherits", () => {
    const overridden = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-plan",
      "iterationPolicy",
      { maxIterations: 9, continuity: { enabled: false } },
    );

    const cleared = clearContextBlockOverride(
      overridden,
      "context-plan",
      "iterationPolicy",
    );

    const target = cleared.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(target).toBeDefined();
    expect(target?.iterationPolicy).toBeUndefined();
    expect("iterationPolicy" in (target ?? {})).toBe(false);
  });

  it("setContextBlockOverride pins a disabled cohort that keeps its assignments", () => {
    const inherited = SEEDED_WORKFLOW_DEFAULTS.contextValidator;
    const result = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-implement",
      "contextValidator",
      { ...inherited, enabled: false },
    );

    const target = result.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect(target?.contextValidator).toEqual({
      enabled: false,
      assignments: inherited.assignments,
    });
  });

  it("clearContextBlockOverride drops the validator override back to inherit", () => {
    const overridden = setContextBlockOverride(
      createWorkflowDefinition(),
      "context-implement",
      "contextValidator",
      { ...SEEDED_WORKFLOW_DEFAULTS.contextValidator, enabled: false },
    );
    const cleared = clearContextBlockOverride(
      overridden,
      "context-implement",
      "contextValidator",
    );

    const target = cleared.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    expect("contextValidator" in (target ?? {})).toBe(false);
  });

  it("setWorkflowConfigOverride writes the workflow-level block", () => {
    const result = setWorkflowConfigOverride(
      createWorkflowDefinition(),
      "implementer",
      {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: { backend: "claude", model: "sonnet", reasoningEffort: "low" },
      },
    );

    expect(result.workflowConfig.implementer).toEqual({
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "low" },
    });
  });

  it("clearWorkflowConfigOverride removes a previously-set workflow block", () => {
    const overridden = setWorkflowConfigOverride(
      createWorkflowDefinition(),
      "iterationPolicy",
      { maxIterations: 7, continuity: { enabled: false } },
    );

    const cleared = clearWorkflowConfigOverride(overridden, "iterationPolicy");

    expect(cleared.workflowConfig.iterationPolicy).toBeUndefined();
    expect("iterationPolicy" in cleared.workflowConfig).toBe(false);
  });

  it("setContextOutputSchema writes the declared document on the named context only", () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
    };

    const result = setContextOutputSchema(
      createWorkflowDefinition(),
      "context-plan",
      schema,
    );

    const target = result.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(target?.outputSchema).toEqual(schema);
    expect(
      result.executionContexts.find(
        (context) => context.id === "context-implement",
      )?.outputSchema,
    ).toBeUndefined();
  });

  it("setContextOutputSchema removes the key on null rather than storing undefined", () => {
    const withSchema = setContextOutputSchema(
      createWorkflowDefinition(),
      "context-plan",
      { type: "object" },
    );

    const cleared = setContextOutputSchema(withSchema, "context-plan", null);

    const target = cleared.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    // An `outputSchema: undefined` key would survive a structural round trip as
    // a declared-but-empty field; the clear must delete it.
    expect("outputSchema" in (target ?? {})).toBe(false);
  });

  it("setContextOutputSchema clones the schema so later edits cannot alias the draft", () => {
    const schema: Record<string, unknown> = { type: "object" };

    const result = setContextOutputSchema(
      createWorkflowDefinition(),
      "context-plan",
      schema,
    );
    schema.type = "array";

    expect(
      result.executionContexts.find((context) => context.id === "context-plan")
        ?.outputSchema,
    ).toEqual({ type: "object" });
  });
});

// #69 change 4 stage 1: the draft tier represents acceptance criteria as
// {id, statement} records and edits them with list mutators. The builder UI
// consuming these is owned downstream (builder-cli-surfaces); the mutators
// here are UI-agnostic pure functions in the same style as the task helpers.
describe("acceptance-criterion record mutators", () => {
  it("wraps legacy prose once and appends with a deterministic non-colliding id", () => {
    const first = addAcceptanceCriterion(
      createWorkflowDefinition(),
      "context-plan",
      "Rollout notes exist",
    );
    expect(first.criterionId).toBe("ac-2");
    const criteria = first.definition.executionContexts.find(
      (context) => context.id === "context-plan",
    )?.acceptanceCriteria;
    // The fixture's prose became the ac-1 record (same wrap the accept path
    // performs), so the appended record is ac-2, not a second ac-1.
    expect(criteria).toEqual([
      { id: "ac-1", statement: "Plan is documented" },
      { id: "ac-2", statement: "Rollout notes exist" },
    ]);
  });

  it("starts at ac-1 on an empty draft list and skips author-chosen ids", () => {
    const draft = addExecutionContext({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });
    const first = addAcceptanceCriterion(draft.definition, draft.contextId);
    expect(first.criterionId).toBe("ac-1");
    expect(
      first.definition.executionContexts.find(
        (context) => context.id === draft.contextId,
      )?.acceptanceCriteria,
    ).toEqual([{ id: "ac-1", statement: "" }]);

    // An author-chosen non-numeric id neither collides nor advances the
    // counter; a numeric ac-N does.
    const authored = updateExecutionContext(
      createWorkflowDefinition(),
      "context-plan",
      {
        acceptanceCriteria: [
          { id: "docs-updated", statement: "Docs updated" },
          { id: "ac-7", statement: "Authored seventh" },
        ],
      },
    );
    const appended = addAcceptanceCriterion(
      authored,
      "context-plan",
      "One more",
    );
    expect(appended.criterionId).toBe("ac-8");
  });

  it("updates one record's statement and leaves its siblings untouched", () => {
    const seeded = updateExecutionContext(
      createWorkflowDefinition(),
      "context-plan",
      {
        acceptanceCriteria: [
          { id: "docs-updated", statement: "Docs updated" },
          { id: "tests-green", statement: "Tests pass" },
        ],
      },
    );
    const updated = updateAcceptanceCriterionStatement(
      seeded,
      "context-plan",
      "tests-green",
      "Every new test passes",
    );
    expect(
      updated.executionContexts.find((context) => context.id === "context-plan")
        ?.acceptanceCriteria,
    ).toEqual([
      { id: "docs-updated", statement: "Docs updated" },
      { id: "tests-green", statement: "Every new test passes" },
    ]);
  });

  it("removes a record by id, including the wrapped prose record", () => {
    const seeded = updateExecutionContext(
      createWorkflowDefinition(),
      "context-plan",
      {
        acceptanceCriteria: [
          { id: "docs-updated", statement: "Docs updated" },
          { id: "tests-green", statement: "Tests pass" },
        ],
      },
    );
    const removed = removeAcceptanceCriterion(
      seeded,
      "context-plan",
      "docs-updated",
    );
    expect(
      removed.executionContexts.find((context) => context.id === "context-plan")
        ?.acceptanceCriteria,
    ).toEqual([{ id: "tests-green", statement: "Tests pass" }]);

    // Prose normalizes to its wrapped record first, so removing ac-1 empties
    // the list rather than throwing or leaving the prose behind.
    const prose = removeAcceptanceCriterion(
      createWorkflowDefinition(),
      "context-plan",
      "ac-1",
    );
    expect(
      prose.executionContexts.find((context) => context.id === "context-plan")
        ?.acceptanceCriteria,
    ).toEqual([]);
  });

  it("reorders records one step at a time and clamps at the boundaries", () => {
    const seeded = updateExecutionContext(
      createWorkflowDefinition(),
      "context-plan",
      {
        acceptanceCriteria: [
          { id: "first", statement: "First" },
          { id: "second", statement: "Second" },
          { id: "third", statement: "Third" },
        ],
      },
    );
    const criteriaOf = (definition: typeof seeded) =>
      definition.executionContexts.find(
        (context) => context.id === "context-plan",
      )?.acceptanceCriteria;

    const moved = moveAcceptanceCriterion(
      seeded,
      "context-plan",
      "third",
      "up",
    );
    expect(criteriaOf(moved)).toEqual([
      { id: "first", statement: "First" },
      { id: "third", statement: "Third" },
      { id: "second", statement: "Second" },
    ]);

    // Clamped: moving the first record up is a no-op, not a rotation.
    const clamped = moveAcceptanceCriterion(
      seeded,
      "context-plan",
      "first",
      "up",
    );
    expect(criteriaOf(clamped)).toEqual(criteriaOf(seeded));
  });
});
