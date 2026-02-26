import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import TaskPlanEditor from "./TaskPlanEditor";
import type { FixPlanTask } from "./types";

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const pendingTasks: FixPlanTask[] = [
  { id: "t1", description: "Implement user authentication with JWT tokens", priority: "high", status: "pending", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
  { id: "t2", description: "Create database schema for user profiles", priority: "high", status: "pending", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
  { id: "t3", description: "Add input validation for registration form", priority: "medium", status: "pending", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
  { id: "t4", description: "Write integration tests for auth endpoints", priority: "medium", status: "pending", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
  { id: "t5", description: "Add rate limiting to login endpoint", priority: "low", status: "pending", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
];

const mixedTasks: FixPlanTask[] = [
  { id: "t1", description: "Implement user authentication with JWT tokens", priority: "high", status: "completed", createdAt: "2026-02-25T10:00:00Z", completedAt: "2026-02-25T10:30:00Z", skipReason: null, addedByIteration: null },
  { id: "t2", description: "Create database schema for user profiles", priority: "high", status: "completed", createdAt: "2026-02-25T10:00:00Z", completedAt: "2026-02-25T10:45:00Z", skipReason: null, addedByIteration: null },
  { id: "t3", description: "Add input validation for registration form", priority: "medium", status: "in_progress", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
  { id: "t4", description: "Write integration tests for auth endpoints", priority: "medium", status: "pending", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: null, addedByIteration: null },
  { id: "t5", description: "Add rate limiting to login endpoint", priority: "low", status: "skipped", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: "Already handled by API gateway middleware", addedByIteration: null },
  { id: "t6", description: "Fix CORS configuration for auth callbacks", priority: "high", status: "completed", createdAt: "2026-02-25T11:00:00Z", completedAt: "2026-02-25T11:15:00Z", skipReason: null, addedByIteration: 3 },
];

const allCompleteTasks: FixPlanTask[] = [
  { id: "t1", description: "Implement user authentication", priority: "high", status: "completed", createdAt: "2026-02-25T10:00:00Z", completedAt: "2026-02-25T10:30:00Z", skipReason: null, addedByIteration: null },
  { id: "t2", description: "Create database schema", priority: "high", status: "completed", createdAt: "2026-02-25T10:00:00Z", completedAt: "2026-02-25T11:00:00Z", skipReason: null, addedByIteration: null },
  { id: "t3", description: "Add input validation", priority: "medium", status: "completed", createdAt: "2026-02-25T10:00:00Z", completedAt: "2026-02-25T11:30:00Z", skipReason: null, addedByIteration: null },
  { id: "t4", description: "Legacy migration helper", priority: "low", status: "skipped", createdAt: "2026-02-25T10:00:00Z", completedAt: null, skipReason: "Not needed for v2 architecture", addedByIteration: null },
];

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Workflow/TaskPlanEditor",
  component: TaskPlanEditor,
  args: {
    onTaskAdd: fn(),
    onTaskRemove: fn(),
    onTaskEdit: fn(),
    onTaskReorder: fn(),
    onGeneratePlan: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, background: "var(--bg-base)", padding: "var(--space-md)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskPlanEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Empty: Story = {
  args: {
    tasks: [],
    showGenerateButton: true,
  },
};

export const WithTasks: Story = {
  args: {
    tasks: pendingTasks,
    showGenerateButton: true,
  },
};

export const MixedStatus: Story = {
  args: {
    tasks: mixedTasks,
    showProgress: true,
  },
};

export const ReadOnly: Story = {
  args: {
    tasks: mixedTasks,
    readOnly: true,
    showProgress: true,
  },
};

export const AllComplete: Story = {
  args: {
    tasks: allCompleteTasks,
    readOnly: true,
    showProgress: true,
  },
};

export const Generating: Story = {
  args: {
    tasks: [],
    showGenerateButton: true,
    isGenerating: true,
  },
};
