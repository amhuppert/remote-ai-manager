import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import { Button } from "@/components/ui/Button";

import ManagedDeliveryWorkflowHeader from "./ManagedDeliveryWorkflowHeader";
import { managedDeliveryStory } from "./story-fixtures";

const meta = {
  title: "Workflows/Builder/ManagedDelivery/Header",
  component: ManagedDeliveryWorkflowHeader,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  args: {
    management: managedDeliveryStory("draft"),
    definitionRevision: 3,
    onPropose: fn(),
    onSignOff: fn(),
    onReopen: fn(),
    onAbandon: fn(),
    launchControl: (
      <Button type="button" size="sm" variant="primary">
        Launch
      </Button>
    ),
  },
} satisfies Meta<typeof ManagedDeliveryWorkflowHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Draft: Story = {};
export const InReview: Story = {
  args: { management: managedDeliveryStory("in_review") },
};
export const Approved: Story = {
  args: { management: managedDeliveryStory("approved") },
};
export const Launched: Story = {
  args: { management: managedDeliveryStory("launched") },
};
export const Superseded: Story = {
  args: { management: managedDeliveryStory("superseded") },
};
export const Abandoned: Story = {
  args: { management: managedDeliveryStory("abandoned") },
};
