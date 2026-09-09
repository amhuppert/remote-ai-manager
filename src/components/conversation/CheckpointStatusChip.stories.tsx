import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import CheckpointStatusChip from "@/components/conversation/CheckpointStatusChip";

const meta = {
  title: "Components/CheckpointStatusChip",
  component: CheckpointStatusChip,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  args: { onOpen: fn() },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-md bg-bg-base p-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CheckpointStatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoCheckpoint = {
  args: { state: { kind: "none" } },
} satisfies Story;

export const Building = {
  args: { state: { kind: "building" } },
} satisfies Story;

export const Retiring = {
  args: { state: { kind: "retiring" } },
} satisfies Story;

/** Readiness is not acceptance: the seed is frozen, no turn has used it yet. */
export const Ready = {
  args: { state: { kind: "ready" } },
} satisfies Story;

export const Delivering = {
  args: { state: { kind: "delivering" } },
} satisfies Story;

/** Applied: an input receipt confirmed the seed reached a turn. */
export const Applied = {
  args: { state: { kind: "applied" } },
} satisfies Story;

export const Cancelled = {
  args: { state: { kind: "cancelled" } },
} satisfies Story;

export const Failed = {
  args: { state: { kind: "failed", message: "seed exceeded the byte budget" } },
} satisfies Story;

export const NeedsReconciliation = {
  args: {
    state: { kind: "needs_reconciliation", lastStablePhase: "delivering" },
  },
} satisfies Story;

/** Every phase side by side. */
export const Matrix = {
  args: { state: { kind: "none" } },
  render: () => (
    <div className="flex flex-wrap items-center gap-md">
      <CheckpointStatusChip state={{ kind: "none" }} onOpen={fn()} />
      <CheckpointStatusChip state={{ kind: "building" }} onOpen={fn()} />
      <CheckpointStatusChip state={{ kind: "retiring" }} onOpen={fn()} />
      <CheckpointStatusChip state={{ kind: "ready" }} onOpen={fn()} />
      <CheckpointStatusChip state={{ kind: "delivering" }} onOpen={fn()} />
      <CheckpointStatusChip state={{ kind: "applied" }} onOpen={fn()} />
      <CheckpointStatusChip state={{ kind: "cancelled" }} onOpen={fn()} />
      <CheckpointStatusChip
        state={{ kind: "failed", message: "build failed" }}
        onOpen={fn()}
      />
      <CheckpointStatusChip
        state={{ kind: "needs_reconciliation", lastStablePhase: "retiring" }}
        onOpen={fn()}
      />
    </div>
  ),
} satisfies Story;
