import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CreateSessionModal from "./CreateSessionModal";

const meta = {
  title: "Sessions/CreateSessionModal",
  component: CreateSessionModal,
  args: {
    projectName: "my-app",
    open: true,
    onClose: fn(),
  },
} satisfies Meta<typeof CreateSessionModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const Closed = {
  args: { open: false },
} satisfies Story;
