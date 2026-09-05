import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { TicketBundleReview } from "./TicketBundleControl";

const meta = {
  title: "Tickets/Portable bundle review",
  component: TicketBundleReview,
  decorators: [
    (Story) => (
      <div className="max-w-[560px] rounded-md bg-bg-base p-lg">
        <Story />
      </div>
    ),
  ],
  args: {
    busy: false,
    onProceed: () => {},
    transfer: {
      id: "11111111-1111-4111-8111-111111111111",
      mode: "export",
      status: "ready",
      title: "Portable ticket context",
      documentCount: 24,
      omissions: [],
      digest: "a".repeat(64),
      error: null,
      ticketNumber: null,
    },
  },
} satisfies Meta<typeof TicketBundleReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Complete: Story = {};
export const MissingContext: Story = {
  args: {
    transfer: {
      ...meta.args.transfer,
      omissions: [
        {
          source: "conversation:research-session",
          reason:
            "Transcript is unavailable; the retained summary is included.",
        },
        {
          source: "/source/repo/.cc/review/design.md",
          reason: "Registered document is missing.",
        },
      ],
    },
  },
};
export const DuplicateImport: Story = {
  args: {
    transfer: {
      ...meta.args.transfer,
      mode: "import",
      status: "duplicate",
      error: "This source ticket was already imported into this project.",
    },
  },
};
