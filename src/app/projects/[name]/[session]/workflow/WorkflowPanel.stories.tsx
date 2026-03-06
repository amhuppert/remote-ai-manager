import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import WorkflowPanel from "./WorkflowPanel";
import type {
  RalphLoopWorkflow,
  FixPlanTask,
  IterationMeta,
  RalphLoopConfig,
  CircuitBreakerState,
} from "./types";

// ---------------------------------------------------------------------------
// Shared Defaults
// ---------------------------------------------------------------------------

const defaultConfig: RalphLoopConfig = {
  maxIterations: 20,
  iterationTimeoutMs: 3_600_000,
  contextSoftLimitTokens: 160_000,
  contextHardLimitTokens: 180_000,
  circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
};

const closedCB: CircuitBreakerState = {
  state: "closed",
  consecutiveNoProgress: 0,
  consecutiveSameError: 0,
  lastErrorPattern: null,
  lastProgressIteration: 0,
};

// ---------------------------------------------------------------------------
// Task Factories
// ---------------------------------------------------------------------------

function task(
  id: string,
  description: string,
  overrides?: Partial<FixPlanTask>,
): FixPlanTask {
  return {
    id,
    description,
    group: 1,
    status: "pending",
    createdAt: "2026-02-25T10:00:00Z",
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Iteration Factory
// ---------------------------------------------------------------------------

function iteration(
  n: number,
  overrides?: Partial<IterationMeta>,
): IterationMeta {
  return {
    iterationNumber: n,
    conversationId: `conv-iter-${n}`,
    status: "completed",
    startedAt: new Date(Date.now() - (20 - n) * 200_000).toISOString(),
    completedAt: new Date(
      Date.now() - (20 - n) * 200_000 + 134_000,
    ).toISOString(),
    durationMs: 100_000 + Math.floor(Math.random() * 140_000),
    costUsd: +(0.15 + Math.random() * 0.4).toFixed(2),
    turns: 8 + Math.floor(Math.random() * 20),
    gitMetrics: {
      filesChanged: 2 + Math.floor(Math.random() * 8),
      linesAdded: 20 + Math.floor(Math.random() * 180),
      linesRemoved: 5 + Math.floor(Math.random() * 40),
      changedFiles: ["src/auth/login.ts", "src/db/schema.ts"],
    },
    statusReport: {
      status: "in_progress",
      exit_signal: false,
      work_summary: `Iteration ${n} — implemented feature changes`,
      work_type: "implementation",
    },
    tasksCompleted: [],
    tasksSkipped: [],
    tasksAdded: [],
    progressClassification: "progress",
    peakContextTokens: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Workflow Factory
// ---------------------------------------------------------------------------

function workflow(overrides?: Partial<RalphLoopWorkflow>): RalphLoopWorkflow {
  return {
    status: "planning",
    objective: "",
    fixPlan: [],
    config: defaultConfig,
    circuitBreaker: closedCB,
    iterations: [],
    haltReason: null,
    generatingPlan: false,
    createdAt: "2026-02-25T10:00:00Z",
    startedAt: null,
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    currentIterationConversationId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Preset Workflows
// ---------------------------------------------------------------------------

const planningEmpty = workflow();

const planningWithTasks = workflow({
  objective:
    "Implement a complete user authentication system with JWT tokens, email verification, password reset, and role-based access control.",
  fixPlan: [
    task("t1", "Implement JWT token generation and validation", {
      group: 1,
    }),
    task("t2", "Create user profile database schema and migrations", {
      group: 1,
    }),
    task("t3", "Add registration form with Zod validation", {
      group: 2,
    }),
    task("t4", "Implement email verification flow", { group: 2 }),
    task("t5", "Add password reset via email link", { group: 2 }),
    task("t6", "Implement role-based access control middleware", {
      group: 3,
    }),
    task("t7", "Write integration tests for auth endpoints", {
      group: 3,
    }),
  ],
});

const runningEarly = workflow({
  status: "running",
  objective: planningWithTasks.objective,
  fixPlan: [
    task("t1", "Implement JWT token generation and validation", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:30:00Z",
    }),
    task("t2", "Create user profile database schema and migrations", {
      group: 1,
      status: "in_progress",
    }),
    task("t3", "Add registration form with Zod validation", {
      group: 2,
    }),
    task("t4", "Implement email verification flow", { group: 2 }),
    task("t5", "Add password reset via email link", { group: 2 }),
    task("t6", "Implement role-based access control middleware", {
      group: 3,
    }),
    task("t7", "Write integration tests for auth endpoints", {
      group: 3,
    }),
  ],
  iterations: [
    iteration(1, {
      durationMs: 247_000,
      costUsd: 0.42,
      statusReport: {
        status: "in_progress",
        exit_signal: false,
        work_summary:
          "Implemented JWT token generation with RS256 signing, token validation middleware, and refresh token rotation",
        work_type: "implementation",
      },
      tasksCompleted: ["t1"],
      gitMetrics: {
        filesChanged: 8,
        linesAdded: 245,
        linesRemoved: 12,
        changedFiles: [
          "src/auth/jwt.ts",
          "src/auth/middleware.ts",
          "src/auth/refresh.ts",
        ],
      },
    }),
  ],
  startedAt: "2026-02-25T10:05:00Z",
  totalCostUsd: 0.42,
  totalDurationMs: 247_000,
});

const runningMidProgress = workflow({
  status: "running",
  objective: planningWithTasks.objective,
  fixPlan: [
    task("t1", "Implement JWT token generation and validation", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:30:00Z",
    }),
    task("t2", "Create user profile database schema and migrations", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:50:00Z",
    }),
    task("t3", "Add registration form with Zod validation", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T11:15:00Z",
    }),
    task("t4", "Implement email verification flow", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T11:40:00Z",
    }),
    task("t5", "Add password reset via email link", {
      group: 2,
      status: "in_progress",
    }),
    task("t6", "Implement role-based access control middleware", {
      group: 3,
    }),
    task("t7", "Write integration tests for auth endpoints", {
      group: 3,
    }),
    task("t8", "Fix CORS configuration for OAuth callbacks", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T11:50:00Z",
      addedByIteration: 3,
    }),
  ],
  iterations: [
    iteration(1, {
      durationMs: 247_000,
      costUsd: 0.42,
      tasksCompleted: ["t1"],
      statusReport: {
        status: "in_progress",
        exit_signal: false,
        work_summary:
          "Implemented JWT token generation, validation, and refresh rotation",
        work_type: "implementation",
      },
    }),
    iteration(2, {
      durationMs: 183_000,
      costUsd: 0.31,
      tasksCompleted: ["t2"],
      statusReport: {
        status: "in_progress",
        exit_signal: false,
        work_summary:
          "Created user profile schema with Drizzle ORM and ran migrations",
        work_type: "implementation",
      },
    }),
    iteration(3, {
      durationMs: 195_000,
      costUsd: 0.35,
      tasksCompleted: ["t3"],
      tasksAdded: ["t8"],
      statusReport: {
        status: "in_progress",
        exit_signal: false,
        work_summary:
          "Added Zod validation for registration form and discovered CORS issue needing fix",
        work_type: "implementation",
      },
    }),
    iteration(4, {
      durationMs: 168_000,
      costUsd: 0.28,
      tasksCompleted: ["t4", "t8"],
      statusReport: {
        status: "in_progress",
        exit_signal: false,
        work_summary:
          "Implemented email verification with token expiry and fixed CORS for OAuth",
        work_type: "implementation",
      },
    }),
  ],
  circuitBreaker: { ...closedCB, lastProgressIteration: 4 },
  startedAt: "2026-02-25T10:05:00Z",
  totalCostUsd: 1.36,
  totalDurationMs: 793_000,
});

const paused = workflow({
  status: "paused",
  objective: planningWithTasks.objective,
  fixPlan: runningMidProgress.fixPlan,
  iterations: runningMidProgress.iterations,
  circuitBreaker: runningMidProgress.circuitBreaker,
  startedAt: "2026-02-25T10:05:00Z",
  totalCostUsd: 1.36,
  totalDurationMs: 793_000,
});

const haltedCircuitBreaker = workflow({
  status: "halted",
  objective: planningWithTasks.objective,
  fixPlan: [
    task("t1", "Implement JWT token generation", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:30:00Z",
    }),
    task("t2", "Create database schema", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:50:00Z",
    }),
    task("t3", "Fix flaky E2E test for login flow", {
      group: 2,
      status: "in_progress",
    }),
    task("t4", "Write integration tests", { group: 2 }),
    task("t5", "Add rate limiting", { group: 3 }),
  ],
  iterations: [
    iteration(1, { durationMs: 247_000, costUsd: 0.42 }),
    iteration(2, { durationMs: 183_000, costUsd: 0.31 }),
    iteration(3, {
      durationMs: 165_000,
      costUsd: 0.29,
      gitMetrics: {
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changedFiles: [],
      },
      progressClassification: "no_progress",
      statusReport: {
        status: "blocked",
        exit_signal: false,
        work_summary:
          "Attempting to fix flaky E2E test but unable to reproduce consistently",
        work_type: "testing",
      },
    }),
    iteration(4, {
      durationMs: 172_000,
      costUsd: 0.25,
      gitMetrics: {
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changedFiles: [],
      },
      progressClassification: "no_progress",
      statusReport: {
        status: "blocked",
        exit_signal: false,
        work_summary:
          "Still unable to fix flaky test — may be a timing issue in CI",
        work_type: "testing",
      },
    }),
    iteration(5, {
      durationMs: 140_000,
      costUsd: 0.22,
      gitMetrics: {
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changedFiles: [],
      },
      progressClassification: "no_progress",
      statusReport: {
        status: "blocked",
        exit_signal: false,
        work_summary:
          "No progress on flaky test fix. Circuit breaker entering recovery mode.",
        work_type: "testing",
      },
    }),
  ],
  circuitBreaker: {
    state: "open",
    consecutiveNoProgress: 3,
    consecutiveSameError: 0,
    lastErrorPattern: null,
    lastProgressIteration: 2,
  },
  haltReason: { type: "circuit_breaker", reason: "no_progress" },
  startedAt: "2026-02-25T10:05:00Z",
  totalCostUsd: 1.49,
  totalDurationMs: 907_000,
});

const haltedStalledExitSignal = workflow({
  status: "halted",
  objective: planningWithTasks.objective,
  fixPlan: [
    task("t1", "Implement JWT tokens", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:30:00Z",
    }),
    task("t2", "Create database schema", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:50:00Z",
    }),
    task("t3", "Add form validation", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T11:15:00Z",
    }),
    task("t4", "Implement email verification", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T11:40:00Z",
    }),
    task("t5", "Add password reset flow", { group: 2 }),
    task("t6", "Add role-based access control", { group: 3 }),
  ],
  iterations: [
    iteration(1, { durationMs: 247_000, costUsd: 0.42 }),
    iteration(2, { durationMs: 183_000, costUsd: 0.31 }),
    iteration(3, { durationMs: 195_000, costUsd: 0.35 }),
    iteration(4, { durationMs: 168_000, costUsd: 0.28 }),
    iteration(5, {
      durationMs: 212_000,
      costUsd: 0.38,
      statusReport: {
        status: "complete",
        exit_signal: true,
        work_summary:
          "All core authentication features are implemented and tested. The remaining tasks are nice-to-haves.",
        work_type: "implementation",
      },
    }),
    iteration(6, {
      durationMs: 98_000,
      costUsd: 0.18,
      statusReport: {
        status: "complete",
        exit_signal: true,
        work_summary:
          "Reviewed remaining tasks — password reset and RBAC are optional for the initial release.",
        work_type: "documentation",
      },
      gitMetrics: {
        filesChanged: 1,
        linesAdded: 8,
        linesRemoved: 0,
        changedFiles: ["README.md"],
      },
    }),
  ],
  haltReason: { type: "stalled_exit_signal", remainingTasks: 2 },
  startedAt: "2026-02-25T10:05:00Z",
  totalCostUsd: 1.92,
  totalDurationMs: 1_103_000,
});

const completedSuccess = workflow({
  status: "completed",
  objective: planningWithTasks.objective,
  fixPlan: [
    task("t1", "Implement JWT token generation and validation", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:30:00Z",
    }),
    task("t2", "Create user profile database schema", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:50:00Z",
    }),
    task("t3", "Add registration form validation", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T11:15:00Z",
    }),
    task("t4", "Implement email verification flow", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T11:40:00Z",
    }),
    task("t5", "Add password reset via email", {
      group: 2,
      status: "completed",
      completedAt: "2026-02-25T12:10:00Z",
    }),
    task("t6", "Implement role-based access control", {
      group: 3,
      status: "completed",
      completedAt: "2026-02-25T12:45:00Z",
    }),
    task("t7", "Write integration tests", {
      group: 3,
      status: "skipped",
      skipReason: "Covered by existing E2E test suite",
    }),
  ],
  iterations: Array.from({ length: 12 }, (_, i) =>
    iteration(i + 1, {
      statusReport: {
        status: i === 11 ? "complete" : "in_progress",
        exit_signal: i >= 10,
        work_summary:
          [
            "Implemented JWT token generation with RS256 signing",
            "Created user profile schema with Drizzle ORM",
            "Added Zod validation for registration form",
            "Implemented email verification with token expiry",
            "Built password reset flow with secure links",
            "Added RBAC middleware with role hierarchy",
            "Wrote unit tests for JWT and validation",
            "Integration tested email verification",
            "Tested password reset edge cases",
            "Verified RBAC permissions across endpoints",
            "Final cleanup and code review",
            "All tasks complete, all tests passing",
          ][i] ?? `Completed iteration ${i + 1} work`,
        work_type:
          i < 6 ? "implementation" : i < 10 ? "testing" : "refactoring",
      },
    }),
  ),
  haltReason: { type: "plan_complete" },
  startedAt: "2026-02-25T10:05:00Z",
  completedAt: "2026-02-25T12:50:00Z",
  totalCostUsd: 4.23,
  totalDurationMs: 2_820_000,
});

const aborted = workflow({
  status: "aborted",
  objective: planningWithTasks.objective,
  fixPlan: [
    task("t1", "Implement JWT tokens", {
      group: 1,
      status: "completed",
      completedAt: "2026-02-25T10:30:00Z",
    }),
    task("t2", "Create database schema", { group: 1 }),
    task("t3", "Add form validation", { group: 2 }),
  ],
  iterations: [
    iteration(1, { durationMs: 247_000, costUsd: 0.42 }),
    iteration(2, {
      status: "aborted",
      durationMs: 45_000,
      costUsd: 0.08,
      gitMetrics: {
        filesChanged: 1,
        linesAdded: 30,
        linesRemoved: 0,
        changedFiles: ["src/db/schema.ts"],
      },
      statusReport: null,
      progressClassification: "progress",
    }),
  ],
  haltReason: { type: "aborted" },
  startedAt: "2026-02-25T10:05:00Z",
  totalCostUsd: 0.5,
  totalDurationMs: 292_000,
});

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Workflow/WorkflowPanel",
  component: WorkflowPanel,
  args: {
    projectName: "my-project",
    sessionName: "feature-auth",
    onActivate: fn(),
    onObjectiveChange: fn(),
    onConfirmStart: fn(),
    onPause: fn(),
    onResume: fn(),
    onAbort: fn(),
    onTaskAdd: fn(),
    onTaskRemove: fn(),
    onGeneratePlan: fn(),
    onResetCircuitBreaker: fn(),
    isGenerating: false,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 600,
          height: 800,
          background: "var(--bg-base)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** No workflow exists — shows the activation CTA */
export const Activation: Story = {
  args: { workflow: null },
};

/** Planning phase with empty objective and no tasks */
export const PlanningEmpty: Story = {
  args: { workflow: planningEmpty },
};

/** Planning phase with objective and tasks ready to start */
export const PlanningWithTasks: Story = {
  args: { workflow: planningWithTasks },
};

/** Planning phase while AI is generating a task plan */
export const PlanningGenerating: Story = {
  args: {
    workflow: workflow({
      objective: planningWithTasks.objective,
    }),
    isGenerating: true,
  },
};

/** Running — early in the loop, 1 iteration done */
export const RunningEarly: Story = {
  args: { workflow: runningEarly },
};

/** Running — mid-progress with 4 iterations and most tasks done */
export const RunningMidProgress: Story = {
  args: { workflow: runningMidProgress },
};

/** Paused — user paused after 4 iterations */
export const Paused: Story = {
  args: { workflow: paused },
};

/** Halted — circuit breaker tripped due to no progress */
export const HaltedCircuitBreaker: Story = {
  args: { workflow: haltedCircuitBreaker },
};

/** Halted — Claude signals done but tasks remain unresolved */
export const HaltedStalledExitSignal: Story = {
  args: { workflow: haltedStalledExitSignal },
};

/** Completed — all tasks done successfully */
export const CompletedSuccess: Story = {
  args: { workflow: completedSuccess },
};

/** Aborted — user manually aborted during iteration 2 */
export const Aborted: Story = {
  args: { workflow: aborted },
};
