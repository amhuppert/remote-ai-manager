import { describe, expect, it } from "vitest";
import {
  buildIterationPrompt,
  buildFollowUpPrompt,
  isContextExhausted,
} from "./iteration-prompt";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
} from "@/types";

function makeContext(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "context-plan",
    title: "Plan",
    description: "Plan the implementation",
    agent: { model: "opus", reasoningEffort: "high" },
    mutability: { allowAgentTaskAdd: true },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 4 },
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<GraphWorkflowTaskDefinition> = {},
): GraphWorkflowTaskDefinition {
  return {
    id: "task-plan-1",
    contextId: "context-plan",
    order: 1,
    title: "Inspect code",
    instructions: "Read the relevant files.",
    source: "user" as const,
    ...overrides,
  };
}

function makeSharedDoc(
  overrides: Partial<GraphWorkflowSharedDocumentEntry> = {},
): GraphWorkflowSharedDocumentEntry {
  return {
    id: "doc-1",
    relativePath: "memory-bank/shared/plan.md",
    description: "Current implementation plan",
    readWhen: "Read before starting implementation tasks.",
    createdAt: "2026-03-27T15:00:00.000Z",
    updatedAt: "2026-03-27T15:00:00.000Z",
    lastUpdatedByConversationId: "conversation-seed",
    ...overrides,
  };
}

describe("buildIterationPrompt", () => {
  it("includes execution context title and goal", () => {
    const prompt = buildIterationPrompt({
      context: makeContext({
        title: "Implement",
        description: "Build the feature",
      }),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Implement");
    expect(prompt).toContain("Build the feature");
  });

  it("documents complete_task MCP tool", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("begin_task");
    expect(prompt).toContain("complete_task");
    expect(prompt).toContain("taskSlug");
    expect(prompt).toContain("summary");
  });

  it("documents upsert_shared_document MCP tool", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("upsert_shared_document");
  });

  it("includes add_task documentation when allowAgentTaskAdd is true", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: true,
    });

    expect(prompt).toContain("add_task");
  });

  it("omits add_task documentation when allowAgentTaskAdd is false", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("add_task");
  });

  it("instructs the agent to work through tasks in order", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [
        makeTask({ id: "task-1", title: "First task" }),
        makeTask({ id: "task-2", order: 2, title: "Second task" }),
      ],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    // Should instruct sequential processing, not single-task focus
    expect(prompt).toMatch(
      /work.+through.+tasks.+in.+order|take.+tasks.+in.+order|work.+through.+them/i,
    );
    expect(prompt).toContain("complete_task");
  });

  it("warns about consequences of not calling complete_task", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toMatch(
      /not.+call.+complete_task|without.+complete_task|fail.+complete/i,
    );
  });

  it("lists remaining tasks with their status and instructions", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [
        makeTask({
          id: "task-1",
          title: "Inspect code",
          instructions: "Read files.",
        }),
        makeTask({
          id: "task-2",
          order: 2,
          title: "Write plan",
          instructions: "Document plan.",
        }),
      ],
      taskStates: {
        "task-1": {
          taskId: "task-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
        "task-2": {
          taskId: "task-2",
          contextId: "context-plan",
          order: 2,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Inspect code");
    expect(prompt).toContain("Write plan");
    expect(prompt).toContain("Read files.");
    expect(prompt).toContain("Document plan.");
    expect(prompt).toContain("pending");
  });

  it("lists shared documents when present", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [
        makeSharedDoc({
          relativePath: "docs/api-contract.md",
          description: "API contract",
          readWhen: "Before implementing routes.",
        }),
      ],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("docs/api-contract.md");
    expect(prompt).toContain("API contract");
    expect(prompt).toContain("Before implementing routes.");
  });

  it("includes task failure feedback for tasks with a failureMessage", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": {
          taskId: "task-1",
          contextId: "context-plan",
          order: 1,
          status: "interrupted",
          summary: null,
          startedAt: "2026-03-27T16:00:00.000Z",
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage:
            "Task validation blocked completion.\n- Missing test coverage: Add unit tests for the new parser.",
        },
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Missing test coverage");
    expect(prompt).toContain("Add unit tests for the new parser");
  });

  it("does not include failure feedback section when no failureMessage exists", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": {
          taskId: "task-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toMatch(
      /previous.+attempt.+failed|validation.+failed|failure.+feedback/i,
    );
  });

  it("does not have a single active task concept", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [
        makeTask({ id: "task-1", title: "First task" }),
        makeTask({ id: "task-2", order: 2, title: "Second task" }),
      ],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    // Should not mark any single task as "active" — the agent works through all of them
    expect(prompt).not.toMatch(/\(active task\)/i);
    expect(prompt).not.toContain("Your Active Task");
  });
});

describe("buildFollowUpPrompt", () => {
  it("lists remaining tasks and reminds the agent to continue", () => {
    const prompt = buildFollowUpPrompt({
      remainingTaskIds: ["task-plan-1", "task-plan-2"],
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain("task-plan-1");
    expect(prompt).toContain("task-plan-2");
    expect(prompt).toContain("complete_task");
  });

  it("includes the attempt number and max attempts", () => {
    const prompt = buildFollowUpPrompt({
      remainingTaskIds: ["task-1"],
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(prompt).toMatch(/2/);
    expect(prompt).toMatch(/3/);
  });

  it("warns that workflow will stall without tool call", () => {
    const prompt = buildFollowUpPrompt({
      remainingTaskIds: ["task-1"],
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toMatch(/stall|block|halt|cannot.+progress/i);
  });
});

describe("isContextExhausted", () => {
  it("returns true when usage exceeds 85% of capacity", () => {
    expect(
      isContextExhausted({ contextTokens: 170_000, contextWindowMax: 200_000 }),
    ).toBe(true);
  });

  it("returns false when usage is below 85%", () => {
    expect(
      isContextExhausted({ contextTokens: 100_000, contextWindowMax: 200_000 }),
    ).toBe(false);
  });

  it("returns false at exactly 85%", () => {
    expect(
      isContextExhausted({ contextTokens: 170_000, contextWindowMax: 200_000 }),
    ).toBe(true);
    expect(
      isContextExhausted({ contextTokens: 169_999, contextWindowMax: 200_000 }),
    ).toBe(false);
  });

  it("returns false when contextTokens is null", () => {
    expect(
      isContextExhausted({ contextTokens: null, contextWindowMax: 200_000 }),
    ).toBe(false);
  });

  it("returns false when contextWindowMax is null", () => {
    expect(
      isContextExhausted({ contextTokens: 170_000, contextWindowMax: null }),
    ).toBe(false);
  });

  it("returns false when both are null", () => {
    expect(
      isContextExhausted({ contextTokens: null, contextWindowMax: null }),
    ).toBe(false);
  });

  it("returns false when contextWindowMax is zero", () => {
    expect(isContextExhausted({ contextTokens: 0, contextWindowMax: 0 })).toBe(
      false,
    );
  });
});
