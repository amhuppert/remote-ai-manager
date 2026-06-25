import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CopyIcon } from "@/components/icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./Tooltip";

// Radix drives the WAI-ARIA Tooltip pattern (hover + keyboard-focus reveal,
// Escape/blur dismissal, `role="tooltip"` + trigger `aria-describedby` wiring);
// a11y violations fail the Storybook test project. Every story is wrapped in a
// single `TooltipProvider` (the once-per-app delay coordinator) via a decorator,
// and the delay is set to 0 here so screenshots/interaction tests reveal the
// tooltip without waiting.
const meta = {
  title: "UI/Tooltip",
  component: Tooltip,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <TooltipProvider delayDuration={0}>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A labeled text trigger composing the `Button` primitive via `asChild`. */
export const TextTrigger: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm">Hover or focus me</Button>
      </TooltipTrigger>
      <TooltipContent>Reveals on hover and keyboard focus</TooltipContent>
    </Tooltip>
  ),
};

/** An icon-only trigger composing the `IconButton` primitive via `asChild`. */
export const IconButtonTrigger: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton aria-label="Copy to clipboard">
          <CopyIcon size={16} />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>Copy to clipboard</TooltipContent>
    </Tooltip>
  ),
};

/**
 * Long content wraps inside the tooltip's `max-w` (the legacy single-line global
 * system could not wrap). Short labels still render on one line.
 */
export const LongText: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm">Long hint</Button>
      </TooltipTrigger>
      <TooltipContent>
        This tooltip holds a longer explanation that wraps onto multiple lines
        instead of overflowing the viewport, while staying within the collision
        padding Radix computes against the edges.
      </TooltipContent>
    </Tooltip>
  ),
};

/**
 * The floating surface, reviewable without interaction (`defaultOpen`). Use this
 * to inspect appearance — the raised surface, border, radius, and mono caption
 * text — in a static screenshot.
 */
export const StaticOpen: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <Button size="sm">Always-open preview</Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        Static tooltip preview
      </TooltipContent>
    </Tooltip>
  ),
};
