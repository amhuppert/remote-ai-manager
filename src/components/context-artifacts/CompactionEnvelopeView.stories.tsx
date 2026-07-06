import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import CompactionEnvelopeView from "./CompactionEnvelopeView";
import {
  buildMaximalEnvelope,
  buildMinimalEnvelope,
  buildProvenance,
} from "./fixtures";

/**
 * The layout is container-query driven: ≥880px shows the two-column grid with
 * the sticky meta rail; narrower containers collapse to one column with a
 * compact meta line + mono footer. The decorator width selects the variant.
 */
function surfaceDecorator(widthClass: string) {
  return function SurfaceDecorator(Story: React.ComponentType) {
    return (
      <div
        className={`${widthClass} rounded-lg border border-solid border-border-subtle bg-bg-surface px-[28px] py-xl`}
      >
        <Story />
      </div>
    );
  };
}

const meta = {
  title: "Components/ContextArtifacts/CompactionEnvelopeView",
  component: CompactionEnvelopeView,
  parameters: { a11y: { test: "error" }, layout: "padded" },
} satisfies Meta<typeof CompactionEnvelopeView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every section populated at the designed 1200px width: two-column grid,
 * sticky rail (status pill, coverage, TOC, provenance, raw JSON), collapsible
 * section cards, interactive ref chips. Ref chips use text-text-secondary
 * (#7b899f on bg-raised #172033 = 4.59:1, WCAG AA compliant — tertiary fails).
 */
export const Wide = {
  args: {
    envelope: buildMaximalEnvelope(),
    provenance: buildProvenance(),
    onNavigateToMessage: fn(),
  },
  decorators: [surfaceDecorator("w-[1200px]")],
} satisfies Story;

/** The same payload in a narrow pane: rail collapsed into meta line + footer. */
export const Narrow = {
  args: {
    envelope: buildMaximalEnvelope(),
    provenance: buildProvenance(),
    onNavigateToMessage: fn(),
  },
  decorators: [surfaceDecorator("w-[420px]")],
} satisfies Story;

/** Sparse message-compaction payload; no provenance, non-interactive chips. */
export const Minimal = {
  args: {
    envelope: buildMinimalEnvelope(),
  },
  decorators: [surfaceDecorator("w-[720px]")],
} satisfies Story;
