import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SubscriptionRows } from "./SubscriptionPrimitives";
import { WorkspaceEmpty } from "./SubscriptionWorkspace";
import { subscriptionFixture } from "./fixtures";
const meta = {
  title: "Subscriptions/Overview",
  component: SubscriptionRows,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SubscriptionRows>;
export default meta;
type Story = StoryObj<typeof meta>;
const base = subscriptionFixture();
const rows = [
  base,
  subscriptionFixture({
    subscription: {
      ...base.subscription,
      id: "subscription-2",
      source: { kind: "validation", id: "validation-1" },
      mode: "active",
      reason: "Continue the review when checks finish.",
    },
    sourceTitle: "Typecheck & focused tests",
    pendingCount: 1,
    holdReason: "A user question is waiting for an answer.",
  }),
  subscriptionFixture({
    subscription: {
      ...base.subscription,
      id: "subscription-3",
      source: { kind: "ticket", id: "ticket-1" },
      pausedAt: "2026-09-30T14:00:00.000Z",
      reason: "Follow changes to the current delivery ticket.",
    },
    sourceTitle: "Expose subscription and inbox controls",
    pendingCount: 0,
  }),
];
export const Populated: Story = {
  args: { items: rows, selectedId: "subscription-1", onSelect: () => {} },
  render: (args) => {
    const [selectedId, setSelectedId] = useState(args.selectedId);
    return (
      <div className="max-w-[850px]">
        <SubscriptionRows
          {...args}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    );
  },
};
export const Empty: Story = {
  args: { items: [], selectedId: null, onSelect: () => {} },
  render: () => (
    <WorkspaceEmpty
      title="Nothing following here yet"
      description="Subscribe a conversation to a source, or let involvement-based follows appear as your agents work."
    />
  ),
};
export const Narrow: Story = {
  ...Populated,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
