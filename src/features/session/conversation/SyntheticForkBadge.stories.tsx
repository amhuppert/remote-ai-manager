import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import SyntheticForkBadge from "@/features/session/conversation/SyntheticForkBadge";

const meta = {
  title: "Components/SyntheticForkBadge",
  component: SyntheticForkBadge,
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
        <span className="panel-title">Conversation</span>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof SyntheticForkBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;
