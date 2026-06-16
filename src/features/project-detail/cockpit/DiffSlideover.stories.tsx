import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import DiffSlideover from "./DiffSlideover";

const meta: Meta<typeof DiffSlideover> = {
  title: "Project Cockpit/DiffSlideover",
  component: DiffSlideover,
};
export default meta;

type Story = StoryObj<typeof DiffSlideover>;

export const Open: Story = {
  args: {
    open: true,
    onClose: fn(),
    projectName: "command-center",
    children: (
      <div
        style={{
          padding: 16,
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-secondary)",
        }}
      >
        Read-only diff body
      </div>
    ),
  },
};
