import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import CompactionEnvelopeView from "./CompactionEnvelopeView";
import {
  buildMaximalEnvelope,
  buildMinimalEnvelope,
  buildProvenance,
} from "./fixtures";

const meta = {
  title: "Components/ContextArtifacts/CompactionEnvelopeView",
  component: CompactionEnvelopeView,
  parameters: { a11y: { test: "error" }, layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[760px] bg-bg-base p-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CompactionEnvelopeView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every section populated, long agentBrief, interactive ref chips. Ref chips
 * use text-text-secondary (#7b899f on bg-raised #172033 = 4.59:1, WCAG AA
 * compliant at their 10.5px size — text-text-tertiary is 4.33:1 and fails).
 */
export const Maximal = {
  args: {
    envelope: buildMaximalEnvelope(),
    provenance: buildProvenance(),
    onNavigateToMessage: fn(),
  },
} satisfies Story;

/** Sparse message-compaction payload; no provenance, non-interactive chips. */
export const Minimal = {
  args: {
    envelope: buildMinimalEnvelope(),
  },
} satisfies Story;
