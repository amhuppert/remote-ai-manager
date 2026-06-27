import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import AlignmentChip from "@/features/session/conversation/AlignmentChip";

const meta = {
  title: "Components/AlignmentChip",
  component: AlignmentChip,
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          padding: "var(--space-md) var(--space-lg)",
          background: "rgba(17, 24, 37, 0.5)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span className="panel-title">Session</span>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AlignmentChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const None = {
  args: { state: "none", activeVersion: null },
} satisfies Story;

export const Active = {
  args: { state: "active", activeVersion: 2 },
} satisfies Story;

export const UpdatePending = {
  args: { state: "pending", activeVersion: 2 },
} satisfies Story;

export const Stale = {
  args: { state: "stale", activeVersion: 4 },
} satisfies Story;
