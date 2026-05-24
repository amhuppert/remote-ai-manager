import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { GraphWorkflowLauncher } from "@/features/session/conversation/GraphWorkflowCard";

const meta = {
  title: "Session/GraphWorkflowLauncher",
  component: GraphWorkflowLauncher,
  args: {
    projectName: "my-project",
    onRun: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GraphWorkflowLauncher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithDefinitions: Story = {
  args: {
    definitions: [
      { id: "def-1", name: "Feature Implementation", revision: 3 },
      { id: "def-2", name: "Bug Fix Pipeline", revision: 1 },
      { id: "def-3", name: "Refactoring Workflow", revision: 7 },
    ],
  },
};

export const NoDefinitions: Story = {
  args: {
    definitions: [],
  },
};

export const Loading: Story = {
  args: {
    definitions: [],
    loading: true,
  },
};

export const Starting: Story = {
  args: {
    definitions: [{ id: "def-1", name: "Feature Implementation", revision: 3 }],
    starting: true,
  },
};

export const WithError: Story = {
  args: {
    definitions: [{ id: "def-1", name: "Feature Implementation", revision: 3 }],
    error: "Session already has an active graph workflow execution",
  },
};
