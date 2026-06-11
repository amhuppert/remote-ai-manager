import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ApprovalGatePanel from "./ApprovalGatePanel";

const meta = {
  title: "Components/ApprovalGatePanel",
  component: ApprovalGatePanel,
  args: {
    contextTitle: "Implement auth flow",
    workflowName: "release-hardening",
    requestedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    isSubmitting: false,
    conversationBusy: false,
    executionSuspended: false,
    onApprove: fn(),
    onReject: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 700, background: "var(--bg-base)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalGatePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const WithoutTitles = {
  args: {
    contextTitle: null,
    workflowName: null,
  },
} satisfies Story;

export const ConversationBusy = {
  args: {
    conversationBusy: true,
  },
} satisfies Story;

export const Submitting = {
  args: {
    isSubmitting: true,
  },
} satisfies Story;

export const ExecutionSuspended = {
  args: {
    executionSuspended: true,
  },
} satisfies Story;
