import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { ExecutionStatusCard } from "./GraphWorkflowCard";

const meta = {
  title: "Session/GraphWorkflowExecutionStatus",
  component: ExecutionStatusCard,
  args: {
    projectName: "my-project",
    sessionName: "feature-work",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExecutionStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const completedTask = (taskId: string, contextId: string, order: number) => ({
  taskId,
  contextId,
  order,
  status: "completed" as const,
  summary: "Done",
  startedAt: "2026-03-29T12:00:00Z",
  completedAt: "2026-03-29T12:05:00Z",
  lastConversationId: null,
  failureMessage: null,
  failureHistory: [],
});

const pendingTask = (taskId: string, contextId: string, order: number) => ({
  taskId,
  contextId,
  order,
  status: "pending" as const,
  summary: null,
  startedAt: null,
  completedAt: null,
  lastConversationId: null,
  failureMessage: null,
  failureHistory: [],
});

export const Running: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "running",
      activeContextId: "context-implement",
      taskStates: {
        "task-plan-1": completedTask("task-plan-1", "context-plan", 1),
        "task-implement-1": {
          ...pendingTask("task-implement-1", "context-implement", 1),
          status: "running",
          startedAt: "2026-03-29T12:05:00Z",
        },
        "task-verify-1": pendingTask("task-verify-1", "context-verify", 1),
      },
    }),
  },
};

export const Completed: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "completed",
      completedAt: "2026-03-29T13:00:00Z",
      taskStates: {
        "task-plan-1": completedTask("task-plan-1", "context-plan", 1),
        "task-implement-1": completedTask(
          "task-implement-1",
          "context-implement",
          1,
        ),
        "task-verify-1": completedTask("task-verify-1", "context-verify", 1),
      },
    }),
  },
};

export const Halted: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-implement",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
      taskStates: {
        "task-plan-1": completedTask("task-plan-1", "context-plan", 1),
        "task-implement-1": {
          ...pendingTask("task-implement-1", "context-implement", 1),
          status: "interrupted",
          startedAt: "2026-03-29T12:05:00Z",
          failureMessage: "Circuit breaker triggered",
        },
        "task-verify-1": pendingTask("task-verify-1", "context-verify", 1),
      },
    }),
  },
};

export const Paused: Story = {
  args: {
    execution: createWorkflowExecution({
      status: "paused",
      activeContextId: "context-implement",
      taskStates: {
        "task-plan-1": completedTask("task-plan-1", "context-plan", 1),
        "task-implement-1": {
          ...pendingTask("task-implement-1", "context-implement", 1),
          status: "interrupted",
          startedAt: "2026-03-29T12:05:00Z",
        },
        "task-verify-1": pendingTask("task-verify-1", "context-verify", 1),
      },
    }),
  },
};
