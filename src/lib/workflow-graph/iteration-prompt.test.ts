import { describe, expect, it } from "vitest";
import { buildIterationPrompt, buildFollowUpPrompt } from "./iteration-prompt";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowTaskState,
} from "@/lib/workflows/schemas";
function makeContext(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    id: "context-plan",
    title: "Plan",
    description: "Plan the implementation",
    acceptanceCriteria: "Planning complete.",
    implementer: { backend: "claude", model: "opus", reasoningEffort: "high" },
    contextValidator: null,
    scriptValidator: { enabled: false },
    mutability: { allowAgentTaskAdd: true },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
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

function makeTaskState(
  overrides: Partial<GraphWorkflowTaskState> = {},
): GraphWorkflowTaskState {
  return {
    taskId: "task-plan-1",
    contextId: "context-plan",
    order: 1,
    status: "pending",
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

function makeLatestContextValidationFailure() {
  return {
    summary: "Validation failed because rollback notes are missing.",
    reopenedTasks: [
      { taskId: "task-plan-2", title: "Write plan" },
      { taskId: "task-plan-3", title: "Add rollout checklist" },
    ],
    groupedIssues: [
      {
        heading: "Task `task-plan-2` - Write plan",
        issues: [
          {
            title: "Missing rollback notes",
            description: "Add rollback guidance to the plan.",
          },
        ],
      },
      {
        heading: "General Issues",
        issues: [
          {
            title: "Incomplete validation",
            description: "Verify the rollout checklist against the runbook.",
          },
        ],
      },
    ],
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
        "task-1": makeTaskState({ taskId: "task-1" }),
        "task-2": makeTaskState({ taskId: "task-2", order: 2 }),
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

  it("renders full failure history when multiple validation failures exist", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({
          taskId: "task-1",
          status: "interrupted",
          startedAt: "2026-03-27T16:00:00.000Z",
          failureHistory: [
            {
              message: "Missing test coverage for edge cases.",
              timestamp: "2026-03-27T16:05:00.000Z",
            },
            {
              message: "Tests still do not exercise the service path.",
              timestamp: "2026-03-27T16:15:00.000Z",
            },
          ],
        }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Attempt 1");
    expect(prompt).toContain("Missing test coverage for edge cases.");
    expect(prompt).toContain("Attempt 2");
    expect(prompt).toContain("Tests still do not exercise the service path.");
  });

  it("falls back to failureMessage when failureHistory is empty", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({
          taskId: "task-1",
          status: "interrupted",
          startedAt: "2026-03-27T16:00:00.000Z",
          failureMessage:
            "Task validation blocked completion.\n- Missing test coverage: Add unit tests for the new parser.",
          failureHistory: [],
        }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Missing test coverage");
    expect(prompt).toContain("Add unit tests for the new parser");
  });

  it("does not include failure feedback section when no failures exist", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toMatch(
      /previous.+attempt|validation.+failure|failure.+history/i,
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

  it("includes acceptance criteria when contextValidationAcceptanceCriteria is provided", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      contextValidationAcceptanceCriteria:
        "Verify test coverage exists and all tests pass.",
    });

    expect(prompt).toContain("Acceptance Criteria");
    expect(prompt).toContain("Verify test coverage exists and all tests pass.");
  });

  it("omits validation criteria section when no instructions provided", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("Validation Criteria");
  });

  it("includes the latest failed context validation summary, reopened tasks, and grouped issues", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      latestContextValidationFailure: makeLatestContextValidationFailure(),
    });

    expect(prompt).toContain("Latest Context Validation Failure");
    expect(prompt).toContain(
      "Validation failed because rollback notes are missing.",
    );
    expect(prompt).toContain("`task-plan-2` - Write plan");
    expect(prompt).toContain("Task `task-plan-2` - Write plan");
    expect(prompt).toContain("Missing rollback notes");
    expect(prompt).toContain("General Issues");
  });
});

describe("buildFollowUpPrompt", () => {
  it("lists remaining task details and reminds the agent to continue", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [
        makeTask({
          id: "task-plan-1",
          title: "Inspect code",
          instructions: "Read files.",
        }),
        makeTask({
          id: "task-plan-2",
          order: 2,
          title: "Write plan",
          instructions: "Document plan.",
        }),
      ],
      taskStates: {
        "task-plan-1": makeTaskState({
          taskId: "task-plan-1",
        }),
        "task-plan-2": makeTaskState({
          taskId: "task-plan-2",
          order: 2,
          status: "interrupted",
        }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain("task-plan-1");
    expect(prompt).toContain("task-plan-2");
    expect(prompt).toContain("Inspect code");
    expect(prompt).toContain("Write plan");
    expect(prompt).toContain("Read files.");
    expect(prompt).toContain("Document plan.");
    expect(prompt).toContain("interrupted");
    expect(prompt).toContain("complete_task");
  });

  it("includes the attempt number and max attempts", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(prompt).toMatch(/2/);
    expect(prompt).toMatch(/3/);
  });

  it("warns that workflow will stall without tool call", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toMatch(/stall|block|halt|cannot.+progress/i);
  });

  it("includes validation failure feedback for remaining tasks", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "fix-1234", title: "Fix tests" })],
      taskStates: {
        "fix-1234": makeTaskState({
          taskId: "fix-1234",
          failureMessage: "Previous patch missed regression coverage.",
        }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain("Previous Attempt Failed");
    expect(prompt).toContain("Previous patch missed regression coverage.");
  });

  it("includes latest failed context validation feedback during follow-up prompts", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-plan-2", title: "Write plan" })],
      taskStates: {
        "task-plan-2": makeTaskState({ taskId: "task-plan-2" }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
      latestContextValidationFailure: makeLatestContextValidationFailure(),
    });

    expect(prompt).toContain("Latest Context Validation Failure");
    expect(prompt).toContain("`task-plan-2` - Write plan");
    expect(prompt).toContain("Missing rollback notes");
  });
});
