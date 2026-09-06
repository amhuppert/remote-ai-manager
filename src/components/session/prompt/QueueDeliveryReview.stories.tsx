import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { QueueDeliveryReview } from "./QueueDeliveryReview";
import { pendingQueuedMessageSchema } from "@/lib/conversations/message-queue-schemas";

const entry = pendingQueuedMessageSchema.parse({
  id: "held",
  status: "uncertain",
  content: [
    {
      type: "text",
      text: "Review the caching change and run its focused tests.",
    },
  ],
  enqueuedAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
  deliveryStartedAt: "2026-09-05T00:00:00Z",
  deliveryAttemptId: "attempt",
  attemptCount: 1,
  deliveredAt: null,
  failedAt: null,
  cancelledAt: null,
  error: null,
});
const meta = {
  title: "Session/Queue delivery review",
  component: QueueDeliveryReview,
  parameters: { a11y: { test: "error" } },
  args: { entries: [entry], onResolve: fn() },
} satisfies Meta<typeof QueueDeliveryReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Uncertain: Story = {};
export const Stopping: Story = { args: { disabled: true } };
export const Retrying: Story = { args: { pendingId: "held" } };
export const Failed: Story = {
  args: {
    entries: [
      {
        ...entry,
        status: "failed",
        error: "The selected model is unavailable.",
      },
    ],
  },
};
export const RequestError: Story = {
  args: { error: "Could not save the review. Try again." },
};
