import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { StatusChip, type StatusChipTone } from "./StatusChip";
import { Spinner } from "./Spinner";

const meta = {
  title: "UI/StatusChip",
  component: StatusChip,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof StatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

const tones: StatusChipTone[] = [
  "neutral",
  "cyan",
  "amber",
  "green",
  "red",
  "violet",
];

/** Every tone renders the same pill; only the border/fill/text triple varies. */
export const Tones: Story = {
  args: { children: "Label" },
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {tones.map((tone) => (
        <StatusChip key={tone} tone={tone}>
          {tone}
        </StatusChip>
      ))}
    </div>
  ),
};

/** A leading icon or spinner renders before the label. */
export const WithIcon: Story = {
  args: { children: "Compacting…" },
  render: () => (
    <StatusChip tone="cyan" icon={<Spinner size="sm" tone="inherit" />}>
      Compacting…
    </StatusChip>
  ),
};

/** `as="button"` makes the chip interactive (pointer + focus ring). */
export const Interactive: Story = {
  args: { children: "View artifact" },
  render: () => (
    <StatusChip as="button" tone="amber" aria-label="View context artifact">
      Stale (behind 3)
    </StatusChip>
  ),
};

/**
 * The three appearance recipes. `solid` (default) is the bordered tone pill;
 * `flat` is a borderless filled accent; `ghost` is a neutral dashed transparent
 * affordance that ignores tone and promotes to cyan on hover.
 */
export const Appearances: Story = {
  args: { children: "Label" },
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      <StatusChip tone="cyan" appearance="solid">
        solid
      </StatusChip>
      <StatusChip tone="green" appearance="flat">
        flat
      </StatusChip>
      <StatusChip as="button" appearance="ghost" aria-label="Ghost affordance">
        ghost
      </StatusChip>
    </div>
  ),
};
