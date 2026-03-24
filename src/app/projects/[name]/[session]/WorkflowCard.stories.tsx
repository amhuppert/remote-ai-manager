import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { RalphLoopWorkflow, FixPlanTask } from "@/types";
import WorkflowCard from "./WorkflowCard";

function makeTask(overrides: Partial<FixPlanTask> = {}): FixPlanTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    description: "Implement feature",
    group: 1,
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
    ...overrides,
  };
}

function makeWorkflow(
  overrides: Partial<RalphLoopWorkflow> = {},
): RalphLoopWorkflow {
  return {
    status: "planning",
    objective: "Implement user authentication with OAuth2 support",
    fixPlan: [],
    references: [],
    config: {
      maxIterations: 20,
      iterationTimeoutMs: 3_600_000,
      contextSoftLimitTokens: 160_000,
      contextHardLimitTokens: 180_000,
      circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
      model: "opus",
      effort: "high",
    },
    circuitBreaker: {
      state: "closed",
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
    iterations: [],
    haltReason: null,
    generatingPlan: false,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    currentIterationConversationId: null,
    ...overrides,
  };
}

const meta: Meta<typeof WorkflowCard> = {
  title: "Session/WorkflowCard",
  component: WorkflowCard,
  parameters: {
    nextjs: { appDirectory: true },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 600, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof WorkflowCard>;

export const Planning: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "planning",
      generatingPlan: true,
    }),
  },
};

export const PlanningWithTasks: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "planning",
      fixPlan: [
        makeTask({ description: "Set up OAuth2 provider", group: 1 }),
        makeTask({ description: "Create login form", group: 1 }),
        makeTask({ description: "Add session management", group: 2 }),
      ],
    }),
  },
};

export const Running: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "running",
      startedAt: new Date().toISOString(),
      fixPlan: [
        makeTask({
          status: "completed",
          description: "Set up OAuth2 provider",
        }),
        makeTask({ status: "completed", description: "Create login form" }),
        makeTask({
          status: "in_progress",
          description: "Add session management",
        }),
        makeTask({
          description: "Write integration tests",
          group: 2,
        }),
        makeTask({ description: "Add error handling", group: 3 }),
      ],
      iterations: [
        { iterationNumber: 1 } as RalphLoopWorkflow["iterations"][number],
        { iterationNumber: 2 } as RalphLoopWorkflow["iterations"][number],
        { iterationNumber: 3 } as RalphLoopWorkflow["iterations"][number],
      ],
    }),
  },
};

export const Stopped: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "stopped",
      fixPlan: [
        makeTask({ status: "completed" }),
        makeTask({ status: "completed" }),
        makeTask({ status: "pending" }),
      ],
      iterations: [
        { iterationNumber: 1 } as RalphLoopWorkflow["iterations"][number],
      ],
    }),
  },
};

export const Completed: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "completed",
      completedAt: new Date().toISOString(),
      fixPlan: [
        makeTask({ status: "completed" }),
        makeTask({ status: "completed" }),
        makeTask({ status: "skipped", skipReason: "Not needed" }),
        makeTask({ status: "completed" }),
      ],
      iterations: [
        { iterationNumber: 1 } as RalphLoopWorkflow["iterations"][number],
        { iterationNumber: 2 } as RalphLoopWorkflow["iterations"][number],
        { iterationNumber: 3 } as RalphLoopWorkflow["iterations"][number],
        { iterationNumber: 4 } as RalphLoopWorkflow["iterations"][number],
      ],
      totalCostUsd: 2.45,
      totalDurationMs: 1_800_000,
    }),
  },
};

export const Halted: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "halted",
      haltReason: { type: "circuit_breaker", reason: "no_progress" },
      fixPlan: [
        makeTask({ status: "completed" }),
        makeTask({ status: "pending" }),
        makeTask({ status: "pending" }),
      ],
    }),
  },
};

export const LongObjective: Story = {
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    workflow: makeWorkflow({
      status: "running",
      objective:
        "Implement a comprehensive user authentication system with OAuth2, SAML, and passwordless login support, including rate limiting, session management, token refresh, and multi-factor authentication integration with third-party providers",
      fixPlan: [
        makeTask({ status: "completed" }),
        makeTask({ status: "in_progress" }),
        makeTask({ status: "pending" }),
        makeTask({ status: "pending" }),
        makeTask({ status: "pending" }),
        makeTask({ status: "pending" }),
        makeTask({ status: "pending" }),
      ],
      iterations: [
        { iterationNumber: 1 } as RalphLoopWorkflow["iterations"][number],
      ],
    }),
  },
};
