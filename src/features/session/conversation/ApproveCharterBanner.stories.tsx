import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { ApproveCharterBannerView } from "@/features/session/conversation/ApproveCharterBanner";

const meta = {
  title: "Session/ApproveCharterBanner",
  component: ApproveCharterBannerView,
  args: {
    pendingAction: null,
    onApprove: fn(),
    onReject: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: "680px", background: "var(--bg-base)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ApproveCharterBannerView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const Approving = {
  args: { pendingAction: "approve" },
} satisfies Story;

export const Rejecting = {
  args: { pendingAction: "reject" },
} satisfies Story;
