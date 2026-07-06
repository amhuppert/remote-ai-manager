import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CompactionStatusChip from "@/features/session/conversation/CompactionStatusChip";

const meta = {
  title: "Components/CompactionStatusChip",
  component: CompactionStatusChip,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  args: { onOpen: fn() },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-md bg-bg-base p-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CompactionStatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoCompact = {
  args: { state: { kind: "none" } },
} satisfies Story;

export const Compacting = {
  args: { state: { kind: "pending" } },
} satisfies Story;

export const Fresh = {
  args: { state: { kind: "fresh" } },
} satisfies Story;

export const Stale = {
  args: { state: { kind: "stale", behind: 7 } },
} satisfies Story;

export const Outdated = {
  args: { state: { kind: "outdated" } },
} satisfies Story;

export const Failed = {
  args: { state: { kind: "failed" } },
} satisfies Story;

/** Every state side by side. */
export const Matrix = {
  args: { state: { kind: "none" } },
  render: () => (
    <div className="flex flex-wrap items-center gap-md">
      <CompactionStatusChip state={{ kind: "none" }} onOpen={fn()} />
      <CompactionStatusChip state={{ kind: "pending" }} onOpen={fn()} />
      <CompactionStatusChip state={{ kind: "fresh" }} onOpen={fn()} />
      <CompactionStatusChip
        state={{ kind: "stale", behind: 7 }}
        onOpen={fn()}
      />
      <CompactionStatusChip state={{ kind: "outdated" }} onOpen={fn()} />
      <CompactionStatusChip state={{ kind: "failed" }} onOpen={fn()} />
    </div>
  ),
} satisfies Story;
