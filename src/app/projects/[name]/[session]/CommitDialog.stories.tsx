import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "@storybook/test";
import CommitDialog from "./CommitDialog";

const meta = {
  title: "Session/CommitDialog",
  component: CommitDialog,
  args: {
    open: true,
    onClose: fn(),
    onSuccess: fn(),
    projectName: "my-app",
    sessionName: "implement-auth",
  },
} satisfies Meta<typeof CommitDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const Closed = {
  args: { open: false },
} satisfies Story;
