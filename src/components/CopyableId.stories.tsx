import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import CopyableId from "./CopyableId";

const meta = {
  title: "Components/CopyableId",
  component: CopyableId,
  decorators: [
    (Story) => (
      <div className="session-info-strip" style={{ padding: 12 }}>
        <div className="si-details" style={{ display: "flex" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof CopyableId>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConversationId = {
  args: {
    label: "Conv ID",
    value: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  },
} satisfies Story;

export const ClaudeSessionId = {
  args: {
    label: "Claude Session",
    value: "sess_01ABC2DEF3GHI4JKL5MNO6PQR",
  },
} satisfies Story;

export const ShortValue = {
  args: {
    label: "ID",
    value: "abc123",
    truncateAt: 8,
  },
} satisfies Story;

export const CustomTruncation = {
  args: {
    label: "Transcript",
    value: "/home/user/.config/cc/transcripts/a1b2c3d4-e5f6.jsonl",
    truncateAt: 20,
  },
} satisfies Story;

export const BranchName = {
  args: {
    label: "Branch",
    value: "csm/more-copyable-fields",
    truncateAt: 999,
  },
} satisfies Story;

export const WorktreePath = {
  args: {
    label: "Worktree",
    value:
      "/home/alex/github/remote-ai-manager/.worktrees/more-copyable-fields",
    truncateAt: 999,
  },
} satisfies Story;
