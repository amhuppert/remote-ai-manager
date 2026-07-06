import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MessageRefLinkChip from "@/features/session/conversation/MessageRefLinkChip";
import type { MessageRefAttrs } from "@/lib/conversations/schemas";

const baseAttrs: MessageRefAttrs = {
  "project-name": "my-app",
  "session-name": "main",
  "conversation-id": "conv-123",
  "conversation-name": "Refactor parser",
  "message-index": "5",
  role: "assistant",
  timestamp: "2026-07-06T12:00:00Z",
  model: "opus",
  compacted: "true",
  "compact-artifact-id": "art-1",
  "compact-created-at": "2026-07-05T10:30:00Z",
  "compaction-command":
    "cctl conversation compaction get conv-123 --message 5 --json",
  "read-command": "cctl conversation read conv-123 --message 5",
};

const meta = {
  title: "Components/MessageRefLinkChip",
  component: MessageRefLinkChip,
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
} satisfies Meta<typeof MessageRefLinkChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: { attrs: baseAttrs },
} satisfies Story;

export const UnnamedConversation = {
  args: {
    attrs: {
      ...baseAttrs,
      "conversation-name": undefined,
      compacted: "false",
      "compact-artifact-id": undefined,
      "compact-created-at": undefined,
      "compaction-command": undefined,
    },
  },
} satisfies Story;
