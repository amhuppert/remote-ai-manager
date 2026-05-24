import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";

const meta = {
  title: "Session/LayoutSwitcher",
  component: LayoutSwitcher,
  args: {
    onLayoutChange: fn(),
  },
} satisfies Meta<typeof LayoutSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation = {
  args: { activeLayout: "conversation" },
} satisfies Story;

export const Default = {
  args: { activeLayout: "default" },
} satisfies Story;

export const Split = {
  args: { activeLayout: "split" },
} satisfies Story;

export const Diff = {
  args: { activeLayout: "diff" },
} satisfies Story;
