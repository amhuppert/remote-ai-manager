import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import FocusConfirmationBar from "./FocusConfirmationBar";

const meta = {
  title: "Components/FocusConfirmationBar",
  component: FocusConfirmationBar,
  args: {
    onConfirm: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 600, background: "var(--bg-void)", padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FocusConfirmationBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const Disabled = {
  args: {
    disabled: true,
  },
} satisfies Story;

export const Loading = {
  args: {
    loading: true,
  },
} satisfies Story;
