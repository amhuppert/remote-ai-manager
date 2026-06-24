import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { GraphWorkflowLauncher } from "@/features/session/conversation/GraphWorkflowCard";

const meta = {
  title: "Session/GraphWorkflowLauncher",
  component: GraphWorkflowLauncher,
  args: {
    projectName: "my-project",
    sessionName: "my-session",
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
      {
        id: "def-1",
        name: "Implement Kiro Tasks",
        revision: 1,
        tier: "global",
      },
      {
        id: "def-2",
        name: "Feature Implementation",
        revision: 3,
        tier: "project",
      },
      { id: "def-3", name: "Bug Fix Pipeline", revision: 1, tier: "project" },
      {
        id: "def-4",
        name: "Refactoring Workflow",
        revision: 7,
        tier: "global",
      },
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
    definitions: [
      {
        id: "def-1",
        name: "Implement Kiro Tasks",
        revision: 1,
        tier: "global",
      },
    ],
    starting: true,
  },
};

export const WithError: Story = {
  args: {
    definitions: [
      {
        id: "def-1",
        name: "Feature Implementation",
        revision: 3,
        tier: "project",
      },
    ],
    error: "Session already has an active graph workflow execution",
  },
};
