import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ConversationLinkChip from "@/features/session/conversation/ConversationLinkChip";
import type { ConversationRefAttrs } from "@/lib/conversations/schemas";

const baseAttrs: ConversationRefAttrs = {
  "project-name": "my-app",
  "project-path": "/repos/my-app",
  "session-name": "main",
  "worktree-path": "/repos/my-app/.worktrees/main",
  "conversation-id": "conv-123",
  "conversation-name": "Refactor parser",
  backend: "claude",
  "backend-ref": "claude-sess-abc",
  "debug-log-path": "",
  status: "running",
  "last-activity-at": "2024-06-01T12:00:00Z",
};

const meta = {
  title: "Components/ConversationLinkChip",
  component: ConversationLinkChip,
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          padding: "var(--space-md) var(--space-lg)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ConversationLinkChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: { attrs: baseAttrs },
} satisfies Story;

export const LongName = {
  args: {
    attrs: {
      ...baseAttrs,
      "conversation-name":
        "Investigate intermittent flaky test in the orchestrator integration suite",
    },
  },
} satisfies Story;

export const CodexBackend = {
  args: {
    attrs: {
      ...baseAttrs,
      backend: "codex",
      "backend-ref": "thread-xyz",
      "conversation-name": "Codex-powered refactor session",
    },
  },
} satisfies Story;
