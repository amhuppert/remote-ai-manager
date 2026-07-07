import { describe, expect, it } from "vitest";
import {
  workflowDefinitionEditOperationSchema,
  type DefinitionEditOperation,
  type ParameterDeclaration,
  type WorkflowPrerequisite,
} from "@/lib/workflows/schemas";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "./test-fixtures";
import {
  applyDefinitionEdits,
  formatDefinitionEditIssue,
} from "./definition-edits";

/** Parse ops through the shared schema so the tests exercise the real vocabulary. */
function ops(...raw: unknown[]): DefinitionEditOperation[] {
  return raw.map((entry) => workflowDefinitionEditOperationSchema.parse(entry));
}

function tasksOf(
  definition: ReturnType<typeof createWorkflowDefinition>,
  contextId: string,
) {
  return definition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((a, b) => a.order - b.order);
}

describe("applyDefinitionEdits", () => {
  it("updates a single task's instructions, touching nothing else", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops({
        type: "update-task",
        taskId: "task-plan-1",
        instructions: "Read the NEW relevant files.",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.record.definition.tasks.find(
      (t) => t.id === "task-plan-1",
    );
    expect(task?.instructions).toBe("Read the NEW relevant files.");
    expect(task?.title).toBe("Inspect code");
    // Pure function does not touch record identity/revision (storage owns that).
    expect(result.record.revision).toBe(record.revision);
    // The source record is not mutated.
    expect(
      record.definition.tasks.find((t) => t.id === "task-plan-1")?.instructions,
    ).toBe("Read the relevant files.");
  });

  it("adds a context, its task, and its edge in one ordered batch", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops(
        {
          type: "add-context",
          id: "context-docs",
          title: "Document",
          acceptanceCriteria: "Docs describe the change.",
        },
        {
          type: "add-task",
          id: "task-docs-1",
          contextId: "context-docs",
          title: "Write docs",
          instructions: "Document the new behavior.",
        },
        {
          type: "add-edge",
          sourceContextId: "context-verify",
          targetContextId: "context-docs",
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const def = result.record.definition;
    expect(def.executionContexts.map((c) => c.id)).toContain("context-docs");
    expect(tasksOf(def, "context-docs").map((t) => t.id)).toEqual([
      "task-docs-1",
    ]);
    expect(
      def.edges.some(
        (e) =>
          e.sourceContextId === "context-verify" &&
          e.targetContextId === "context-docs",
      ),
    ).toBe(true);
    // The added context gets a layout position; existing ones are preserved.
    expect(result.record.layout.contextPositions["context-docs"]).toBeDefined();
    expect(result.record.layout.contextPositions["context-plan"]).toEqual(
      record.layout.contextPositions["context-plan"],
    );
  });

  it("inserts tasks by relative position and densely renumbers 1..n", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops(
        {
          type: "add-task",
          id: "task-plan-2",
          contextId: "context-plan",
          title: "Second",
          instructions: "Second step.",
          position: { at: "start" },
        },
        {
          type: "add-task",
          id: "task-plan-3",
          contextId: "context-plan",
          title: "Third",
          instructions: "Third step.",
          position: { after: "task-plan-1" },
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ordered = tasksOf(result.record.definition, "context-plan");
    expect(ordered.map((t) => t.id)).toEqual([
      "task-plan-2",
      "task-plan-1",
      "task-plan-3",
    ]);
    expect(ordered.map((t) => t.order)).toEqual([1, 2, 3]);
  });

  it("reorders a context by exact permutation and rejects a mismatch", () => {
    const record = createWorkflowDefinitionRecord({
      definition: createWorkflowDefinition({
        tasks: [
          {
            id: "a",
            contextId: "context-plan",
            order: 1,
            title: "A",
            instructions: "a",
            source: "user",
          },
          {
            id: "b",
            contextId: "context-plan",
            order: 2,
            title: "B",
            instructions: "b",
            source: "user",
          },
          {
            id: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            title: "Write code",
            instructions: "Implement the feature.",
            source: "user",
          },
          {
            id: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            title: "Run checks",
            instructions: "Verify behavior.",
            source: "user",
          },
        ],
      }),
    });
    const good = applyDefinitionEdits(
      record,
      ops({
        type: "reorder-tasks",
        contextId: "context-plan",
        orderedTaskIds: ["b", "a"],
      }),
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(
        tasksOf(good.record.definition, "context-plan").map((t) => t.id),
      ).toEqual(["b", "a"]);
    }

    const bad = applyDefinitionEdits(
      record,
      ops({
        type: "reorder-tasks",
        contextId: "context-plan",
        orderedTaskIds: ["b"],
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues[0]?.code).toBe("reorder-mismatch");
      expect(bad.issues[0]?.operationIndex).toBe(0);
    }
  });

  it("moves a task to another context and renumbers both", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops({
        type: "move-task",
        taskId: "task-plan-1",
        contextId: "context-implement",
        position: { before: "task-implement-1" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const def = result.record.definition;
    expect(tasksOf(def, "context-plan")).toHaveLength(0);
    expect(tasksOf(def, "context-implement").map((t) => t.id)).toEqual([
      "task-plan-1",
      "task-implement-1",
    ]);
    expect(tasksOf(def, "context-implement").map((t) => t.order)).toEqual([
      1, 2,
    ]);
  });

  it("removes a task and resequences its context", () => {
    const record = createWorkflowDefinitionRecord({
      definition: createWorkflowDefinition({
        tasks: [
          {
            id: "a",
            contextId: "context-plan",
            order: 1,
            title: "A",
            instructions: "a",
            source: "user",
          },
          {
            id: "b",
            contextId: "context-plan",
            order: 2,
            title: "B",
            instructions: "b",
            source: "user",
          },
          {
            id: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            title: "Write code",
            instructions: "Implement the feature.",
            source: "user",
          },
          {
            id: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            title: "Run checks",
            instructions: "Verify behavior.",
            source: "user",
          },
        ],
      }),
    });
    const result = applyDefinitionEdits(
      record,
      ops({ type: "remove-task", taskId: "a" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ordered = tasksOf(result.record.definition, "context-plan");
    expect(ordered.map((t) => t.id)).toEqual(["b"]);
    expect(ordered.map((t) => t.order)).toEqual([1]);
  });

  it("refuses to remove a non-empty context without deleteTasks", () => {
    const record = createWorkflowDefinitionRecord();
    const refused = applyDefinitionEdits(
      record,
      ops({ type: "remove-context", contextId: "context-plan" }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.issues[0]?.code).toBe("context-not-empty");
  });

  it("removes a context with deleteTasks, cascading its tasks and edges", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops({
        type: "remove-context",
        contextId: "context-implement",
        deleteTasks: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const def = result.record.definition;
    expect(def.executionContexts.map((c) => c.id)).not.toContain(
      "context-implement",
    );
    expect(def.tasks.some((t) => t.contextId === "context-implement")).toBe(
      false,
    );
    // Both edges touched context-implement, so both cascade away.
    expect(def.edges).toHaveLength(0);
    expect(
      result.record.layout.contextPositions["context-implement"],
    ).toBeUndefined();
  });

  it("rejects a duplicate edge and removes an edge by pair", () => {
    const record = createWorkflowDefinitionRecord();
    const dup = applyDefinitionEdits(
      record,
      ops({
        type: "add-edge",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      }),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.issues[0]?.code).toBe("edge-already-exists");

    const removed = applyDefinitionEdits(
      record,
      ops({
        type: "remove-edge",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      }),
    );
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(
        removed.record.definition.edges.some(
          (e) =>
            e.sourceContextId === "context-plan" &&
            e.targetContextId === "context-implement",
        ),
      ).toBe(false);
    }
  });

  it("rejects the whole batch on the first precondition failure (atomic)", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops(
        {
          type: "update-task",
          taskId: "task-plan-1",
          title: "Renamed",
        },
        {
          type: "update-task",
          taskId: "task-missing",
          title: "Nope",
        },
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("unknown-task-id");
    expect(result.issues[0]?.operationIndex).toBe(1);
    // Nothing persisted: the source record is untouched.
    expect(
      record.definition.tasks.find((t) => t.id === "task-plan-1")?.title,
    ).toBe("Inspect code");
  });

  it("catches a cycle introduced by the batch in post-batch validation", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops({
        type: "add-edge",
        sourceContextId: "context-verify",
        targetContextId: "context-plan",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "cycle-detected")).toBe(true);
    }
  });

  it("edits record metadata via update-workflow", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops({
        type: "update-workflow",
        name: "Renamed Flow",
        description: "A better description",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.name).toBe("Renamed Flow");
      expect(result.record.description).toBe("A better description");
    }
  });

  it("replaces charter arrays wholesale and rejects duplicate source ranks", () => {
    const record = createWorkflowDefinitionRecord();
    const ok = applyDefinitionEdits(
      record,
      ops({
        type: "update-charter",
        mission: "New mission statement",
        conventions: ["one", "two"],
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.record.definition.charter.mission).toBe(
        "New mission statement",
      );
      expect(ok.record.definition.charter.conventions).toEqual(["one", "two"]);
    }

    const badRanks = applyDefinitionEdits(
      record,
      ops({
        type: "update-charter",
        sourcesOfTruth: [
          {
            rank: 1,
            id: "s1",
            label: "First",
            type: "document",
            locator: "a.md",
            description: "d",
            accessPolicy: "worktree-relative",
          },
          {
            rank: 1,
            id: "s2",
            label: "Second",
            type: "document",
            locator: "b.md",
            description: "d",
            accessPolicy: "worktree-relative",
          },
        ],
      }),
    );
    expect(badRanks.ok).toBe(false);
  });

  it("sets and clears a workflow-config override block (null clears)", () => {
    const record = createWorkflowDefinitionRecord({
      definition: createWorkflowDefinition({
        workflowConfig: {
          scriptValidator: { enabled: true },
        },
      }),
    });
    const cleared = applyDefinitionEdits(
      record,
      ops({ type: "update-workflow-config", scriptValidator: null }),
    );
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(
        cleared.record.definition.workflowConfig.scriptValidator,
      ).toBeUndefined();
    }

    const set = applyDefinitionEdits(
      record,
      ops({
        type: "update-workflow-config",
        circuitBreaker: { consecutiveFailureThreshold: 5 },
      }),
    );
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(
        set.record.definition.workflowConfig.circuitBreaker
          ?.consecutiveFailureThreshold,
      ).toBe(5);
    }
  });

  it("clears a per-context override with null on update-context", () => {
    const record = createWorkflowDefinitionRecord();
    const result = applyDefinitionEdits(
      record,
      ops({
        type: "update-context",
        contextId: "context-plan",
        implementer: null,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ctx = result.record.definition.executionContexts.find(
        (c) => c.id === "context-plan",
      );
      expect(ctx?.implementer).toBeUndefined();
    }
  });

  it("adds a parameter and rejects removing one still referenced by a token", () => {
    const declaration: ParameterDeclaration = {
      type: "string",
      name: "feature-name",
      label: "Feature name",
      required: true,
    };
    const record = createWorkflowDefinitionRecord({
      definition: createWorkflowDefinition({
        parameters: [declaration],
        tasks: [
          {
            id: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            title: "Inspect",
            instructions: "Work on {{inputs.feature-name}} now.",
            source: "user",
          },
          {
            id: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            title: "Write code",
            instructions: "Implement the feature.",
            source: "user",
          },
          {
            id: "task-verify-1",
            contextId: "context-verify",
            order: 1,
            title: "Run checks",
            instructions: "Verify behavior.",
            source: "user",
          },
        ],
      }),
    });

    const added = applyDefinitionEdits(
      record,
      ops({
        type: "add-parameter",
        declaration: {
          type: "enum",
          name: "mode",
          label: "Mode",
          options: ["a", "b"],
        },
      }),
    );
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.record.definition.parameters.map((p) => p.name)).toContain(
        "mode",
      );
    }

    const removedStillReferenced = applyDefinitionEdits(
      record,
      ops({ type: "remove-parameter", name: "feature-name" }),
    );
    expect(removedStillReferenced.ok).toBe(false);
  });

  it("adds and removes a prerequisite matched by identity", () => {
    const prerequisite: WorkflowPrerequisite = {
      kind: "path",
      path: ".kiro/steering/tech.md",
    };
    const withPrereq = createWorkflowDefinitionRecord({
      definition: createWorkflowDefinition({ prerequisites: [prerequisite] }),
    });
    const removed = applyDefinitionEdits(
      withPrereq,
      ops({
        type: "remove-prerequisite",
        kind: "path",
        path: ".kiro/steering/tech.md",
      }),
    );
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.record.definition.prerequisites).toHaveLength(0);
    }

    const unknown = applyDefinitionEdits(
      createWorkflowDefinitionRecord(),
      ops({ type: "remove-prerequisite", kind: "path", path: "nope.md" }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.issues[0]?.code).toBe("unknown-prerequisite");
    }
  });

  it("formats per-op and graph issues with locator-first paths", () => {
    expect(
      formatDefinitionEditIssue({
        code: "unknown-task-id",
        message: 'no task "impl-9" in this definition',
        operationIndex: 0,
      }),
    ).toEqual({
      path: "operations[0]",
      message: 'unknown-task-id — no task "impl-9" in this definition',
    });

    expect(
      formatDefinitionEditIssue({
        code: "cycle-detected",
        message: "plan → impl → plan",
      }),
    ).toEqual({
      path: "graph",
      message: "cycle-detected — plan → impl → plan",
    });
  });
});
