import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "@storybook/test";
import CardContextMenu from "./CardContextMenu";

const meta = {
  title: "Components/CardContextMenu",
  component: CardContextMenu,
  args: {
    onToggle: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "2rem", position: "relative" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CardContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed = {
  args: {
    open: false,
    items: [
      { label: "Pin Project", onAction: fn() },
      { label: "Archive Project", onAction: fn() },
    ],
  },
} satisfies Story;

export const Open = {
  args: {
    open: true,
    items: [
      { label: "Pin Project", onAction: fn() },
      { label: "Archive Project", onAction: fn() },
    ],
  },
} satisfies Story;

export const WithDangerItem = {
  args: {
    open: true,
    items: [
      { label: "Rename", onAction: fn() },
      { label: "Archive", onAction: fn() },
      { label: "Delete", danger: true, onAction: fn() },
    ],
  },
} satisfies Story;
