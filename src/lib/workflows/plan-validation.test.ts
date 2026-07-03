import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { validateWorkflowPlan } from "./plan-validation";

/** A well-formed create/replace body: `{ name, description?, definition, layout }`. */
function makePlan(definition = createWorkflowDefinition()) {
  return {
    name: "Test Workflow",
    description: "A workflow under test",
    definition,
    layout: createWorkflowLayout(),
  };
}

describe("validateWorkflowPlan", () => {
  it("accepts a well-formed plan and returns the normalized draft", () => {
    const result = validateWorkflowPlan(makePlan());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.name).toBe("Test Workflow");
      expect(result.draft.description).toBe("A workflow under test");
      expect(result.draft.definition.executionContexts).toHaveLength(3);
    }
  });

  it("rejects a plan whose definition is missing the required charter", () => {
    const { charter: _charter, ...noCharter } = createWorkflowDefinition();

    const result = validateWorkflowPlan(makePlan(noCharter as never));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path)).toContain("definition.charter");
    }
  });

  it("rejects a plan whose charter has duplicate precedence ranks", () => {
    const definition = createWorkflowDefinition();
    const dupRankCharter = {
      ...definition.charter,
      sourcesOfTruth: [
        {
          rank: 1,
          id: "design-doc",
          label: "Design",
          type: "document" as const,
          locator: "design.md",
          description: "primary",
          accessPolicy: "worktree-relative" as const,
        },
        {
          rank: 1,
          id: "acceptance-criteria",
          label: "AC",
          type: "spec" as const,
          locator: "ac",
          description: "secondary",
          accessPolicy: "worktree-relative" as const,
        },
      ],
    };

    const result = validateWorkflowPlan(
      makePlan({ ...definition, charter: dupRankCharter } as never),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) =>
          i.path.startsWith("definition.charter.sourcesOfTruth"),
        ),
      ).toBe(true);
    }
  });

  it("reports a Zod field error with its JSON path", () => {
    const definition = createWorkflowDefinition();
    // A type error the Zod schema rejects (title must be a string).
    const broken = {
      ...definition,
      executionContexts: definition.executionContexts.map((ctx, index) =>
        index === 0 ? { ...ctx, title: 42 } : ctx,
      ),
    };

    const result = validateWorkflowPlan(makePlan(broken as never));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path);
      expect(paths).toContain("definition.executionContexts.0.title");
      for (const issue of result.issues) {
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("reports an unknown contextId reference with a task-scoped JSON path", () => {
    const definition = createWorkflowDefinition();
    const broken = {
      ...definition,
      tasks: definition.tasks.map((task, index) =>
        index === 0 ? { ...task, contextId: "context-does-not-exist" } : task,
      ),
    };

    const result = validateWorkflowPlan(makePlan(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (i) => i.path === "definition.tasks.0.contextId",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/context-does-not-exist/);
    }
  });

  it("reports a dependency cycle with an edges JSON path", () => {
    const definition = createWorkflowDefinition();
    const cyclic = {
      ...definition,
      edges: [
        ...definition.edges,
        {
          id: "edge-verify-plan",
          sourceContextId: "context-verify",
          targetContextId: "context-plan",
        },
      ],
    };

    const result = validateWorkflowPlan(makePlan(cyclic));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.path === "definition.edges");
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/acyclic/i);
    }
  });
});
