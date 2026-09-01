import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, userEvent, within } from "storybook/test";

import WorkflowBuilderInspectorRail from "./WorkflowBuilderInspectorRail";
import { managedDeliveryStory } from "./story-fixtures";

const meta = {
  title: "Workflows/Builder/ManagedDelivery/Inspector",
  component: WorkflowBuilderInspectorRail,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  args: {
    management: managedDeliveryStory("draft"),
    config: <div className="p-md">Workflow configuration</div>,
    onReaffirm: fn(),
    onComment: fn(),
  },
  decorators: [
    (Story) => (
      <div className="ml-auto h-screen w-[420px] border-l border-solid border-border-dim bg-bg-base">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowBuilderInspectorRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Config: Story = {};
export const Scope: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("tab", { name: "Scope" }),
    );
  },
};
export const Changes: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("tab", { name: "Changes" }),
    );
  },
};
export const FirstDelivery: Story = {
  args: {
    management: {
      ...managedDeliveryStory("draft"),
      approvedBaseline: null,
    },
  },
  play: Changes.play,
};
