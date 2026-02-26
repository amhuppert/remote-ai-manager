import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import IterationTimeline from "./IterationTimeline";
import type { IterationMeta } from "./types";

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

function createIteration(n: number, overrides?: Partial<IterationMeta>): IterationMeta {
  return {
    iterationNumber: n,
    conversationId: `conv-iter-${n}`,
    status: "completed",
    startedAt: new Date(Date.now() - (10 - n) * 180000).toISOString(),
    completedAt: new Date(Date.now() - (10 - n) * 180000 + 134000).toISOString(),
    durationMs: 120000 + Math.floor(Math.random() * 120000),
    costUsd: 0.15 + Math.random() * 0.45,
    turns: 8 + Math.floor(Math.random() * 20),
    gitMetrics: {
      filesChanged: 2 + Math.floor(Math.random() * 10),
      linesAdded: 20 + Math.floor(Math.random() * 200),
      linesRemoved: 5 + Math.floor(Math.random() * 50),
      changedFiles: ["src/auth/login.ts", "src/auth/register.ts", "src/db/schema.ts"].slice(0, 1 + Math.floor(Math.random() * 3)),
    },
    statusReport: {
      status: "in_progress",
      exit_signal: false,
      work_summary: [
        "Implemented JWT token generation and validation",
        "Created user profile database schema and migrations",
        "Added form validation with Zod schemas",
        "Refactored authentication middleware for clarity",
        "Wrote unit tests for token refresh flow",
        "Updated API documentation for auth endpoints",
      ][n % 6] ?? "Completed iteration work",
      work_type: (["implementation", "implementation", "testing", "implementation", "refactoring", "documentation"] as const)[n % 6] ?? "implementation",
    },
    tasksCompleted: [],
    tasksSkipped: [],
    tasksAdded: [],
    progressClassification: "progress",
    ...overrides,
  };
}

const fewIterations: IterationMeta[] = [
  createIteration(1, { durationMs: 247000, costUsd: 0.42 }),
  createIteration(2, { durationMs: 183000, costUsd: 0.31 }),
  createIteration(3, { durationMs: 195000, costUsd: 0.28 }),
];

const manyIterations: IterationMeta[] = Array.from({ length: 8 }, (_, i) =>
  createIteration(i + 1),
);

const withErrors: IterationMeta[] = [
  createIteration(1, { durationMs: 247000, costUsd: 0.42 }),
  createIteration(2, { durationMs: 183000, costUsd: 0.31 }),
  createIteration(3, {
    status: "error",
    durationMs: 45000,
    costUsd: 0.08,
    gitMetrics: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, changedFiles: [] },
    statusReport: null,
    progressClassification: "no_progress",
  }),
  createIteration(4, { durationMs: 195000, costUsd: 0.35 }),
  createIteration(5, {
    status: "timeout",
    durationMs: 3600000,
    costUsd: 0.92,
    gitMetrics: { filesChanged: 1, linesAdded: 12, linesRemoved: 0, changedFiles: ["src/config.ts"] },
    statusReport: { status: "blocked", exit_signal: false, work_summary: "Timed out while running complex test suite", work_type: "testing" },
    progressClassification: "progress",
  }),
  createIteration(6, {
    durationMs: 154000,
    costUsd: 0.22,
    gitMetrics: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, changedFiles: [] },
    progressClassification: "no_progress",
  }),
];

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Workflow/IterationTimeline",
  component: IterationTimeline,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, background: "var(--bg-base)", padding: "var(--space-md)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IterationTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const FewIterations: Story = {
  args: { iterations: fewIterations },
};

export const ManyIterations: Story = {
  args: { iterations: manyIterations },
};

export const WithErrors: Story = {
  args: { iterations: withErrors },
};
