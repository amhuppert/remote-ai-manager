import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CopyIcon } from "@/components/icons";
import { IconButton } from "./IconButton";
import { WithTooltip } from "./WithTooltip";

// WithTooltip composes the Radix Tooltip triad (Root/Trigger/Content) around a
// single trigger element — the ergonomic replacement for the legacy
// `data-tooltip` attribute. It carries its own provider, so a story needs no
// TooltipProvider decorator. a11y violations fail the Storybook test project.
const meta = {
  title: "UI/WithTooltip",
  component: WithTooltip,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof WithTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An icon-only trigger with a text label; reveals on hover and keyboard focus. */
export const IconTrigger: Story = {
  args: {
    label: "Copy to clipboard",
    children: (
      <IconButton aria-label="Copy to clipboard">
        <CopyIcon size={16} />
      </IconButton>
    ),
  },
};

/** A nullish label renders the child bare, with no tooltip wiring. */
export const NoLabel: Story = {
  args: {
    label: null,
    children: (
      <IconButton aria-label="Copy to clipboard">
        <CopyIcon size={16} />
      </IconButton>
    ),
  },
};
