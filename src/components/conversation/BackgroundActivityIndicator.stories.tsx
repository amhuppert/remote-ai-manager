import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import BackgroundActivityIndicator from "./BackgroundActivityIndicator";
import type { ConversationBackgroundTaskView } from "@/lib/conversations/schemas";

// Relative to "now" at render time, so the stories read the same on any day.
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function task(
  overrides: Partial<ConversationBackgroundTaskView> = {},
): ConversationBackgroundTaskView {
  return {
    taskId: "task-a",
    description: "full regression suite",
    taskType: null,
    workflowName: null,
    subagentType: null,
    lastToolName: null,
    totalTokens: null,
    toolUses: null,
    startedAt: minutesAgo(9),
    lastActivityAt: minutesAgo(1),
    ...overrides,
  };
}

const meta = {
  title: "Conversation/BackgroundActivityIndicator",
  component: BackgroundActivityIndicator,
  parameters: { layout: "padded" },
  args: { visible: true },
} satisfies Meta<typeof BackgroundActivityIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A backgrounded shell or subagent, named by its description. */
export const SingleTask: Story = {
  args: {
    activity: { tasks: [task()], updatedAt: minutesAgo(0) },
  },
};

/** A Workflow-tool run is named by its workflow instead of its description. */
export const Workflow: Story = {
  args: {
    activity: {
      tasks: [
        task({
          taskType: "local_workflow",
          workflowName: "spec",
          description: "run the spec workflow",
          lastToolName: "Read",
          totalTokens: 42_000,
          toolUses: 31,
        }),
      ],
      updatedAt: minutesAgo(0),
    },
  },
};

/** Several tasks collapse to a count. */
export const ManyTasks: Story = {
  args: {
    activity: {
      tasks: [
        task({ taskId: "a" }),
        task({ taskId: "b", lastActivityAt: minutesAgo(4) }),
        task({ taskId: "c", lastActivityAt: minutesAgo(12) }),
      ],
      updatedAt: minutesAgo(0),
    },
  },
};

/**
 * No progress signal has arrived yet (`lastActivityAt === startedAt`), so the
 * chip reports the start time rather than overstating known liveness.
 */
export const NoProgressYet: Story = {
  args: {
    activity: {
      tasks: [
        task({ startedAt: minutesAgo(3), lastActivityAt: minutesAgo(3) }),
      ],
      updatedAt: minutesAgo(0),
    },
  },
};

/** Suppressed while a turn streams — the typing indicator owns that moment. */
export const HiddenWhileResponding: Story = {
  args: {
    activity: { tasks: [task()], updatedAt: minutesAgo(0) },
    visible: false,
  },
};
