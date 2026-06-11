import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MessageRow from "@/components/conversation/MessageRow";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

function makeMessage(
  overrides: Partial<TranscriptMessage> = {},
): TranscriptMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Inspected the affected module and confirmed the regression repro. Drafting the fix now.",
      },
    ],
    timestamp: "2026-04-12T11:00:00Z",
    model: "opus",
    ...overrides,
  };
}

const meta = {
  title: "Projects/MessageRow",
  component: MessageRow,
  parameters: {
    layout: "padded",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div
        className="conversation"
        data-backend="claude"
        style={{ maxWidth: 720, padding: "var(--space-lg)" }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    messageIndex: 0,
    isLast: false,
    selectedBackend: "claude",
    worktreePath: "/tmp/proj",
    onFork: fn(),
    lastMessageExtras: null,
  },
} satisfies Meta<typeof MessageRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithIterationBadge: Story = {
  name: "Iteration badge — workflow turn",
  args: {
    msg: makeMessage({
      origin: {
        source: "workflow",
        workflow: {
          executionId: "exec-1",
          nodeId: "ctx-impl",
          iterationIndex: 3,
        },
      },
    }),
  },
};

export const NoBadgeLegacyTurn: Story = {
  name: "No badge — legacy turn (origin absent)",
  args: {
    msg: makeMessage(),
  },
};

export const NoBadgeUserOrigin: Story = {
  name: "No badge — user-origin turn",
  args: {
    msg: makeMessage({
      role: "user",
      content: [
        { type: "text", text: "Add a regression test for the navigation bug." },
      ],
      origin: { source: "user" },
    }),
  },
};

export const SystemNotice: Story = {
  name: "System notice — distinct row",
  args: {
    msg: makeMessage({
      role: "notice",
      content: [
        {
          type: "text",
          text: "Commit job started — generating commit message from session changes.",
        },
      ],
      model: undefined,
    }),
  },
};
