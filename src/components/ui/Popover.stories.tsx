// Live verification (ui-primitive skill Phase 6, run against this worktree's
// Storybook via Playwright + injected axe):
// - Keyboard: Tab focuses the trigger with the canonical cyan :focus-visible ring
//   (2px solid rgb(0,229,255)); Enter opens the panel and moves focus into it
//   (the baked PopoverClose); Escape closes it and returns focus to the trigger
//   (aria-expanded false). Trigger exposes aria-haspopup="dialog".
// - Dismissal: a real pointerdown outside the panel closes it (non-modal); a
//   click inside keeps it open.
// - Surface: role=dialog, data-side=bottom, bg rgb(26,39,64) (bg-elevated),
//   border rgb(36,48,72) (border-default), border-radius 6px, z-index 1100
//   (z-popover), box-shadow 0 12px 32px rgba(0,0,0,0.35) (shadow-menu), arrow
//   fill rgb(26,39,64) (fill-bg-elevated).
// - Positioning: AlignmentSides renders all four side/align combinations with
//   correct data-side / data-align and arrows.
// - axe (wcag2a/2aa/21a/21aa/22aa): no Popover violations. The only hit is CC's
//   global legacy `.tooltip-portal` (aria-tooltip-name) — an iframe-wide artifact
//   outside this primitive, reported not absorbed. Demo body text uses
//   text-text-primary because muted CC text (secondary/tertiary) fails AA on the
//   lightest bg-elevated surface (a documented design-system limitation).
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { CloseIcon, KebabIcon } from "@/components/icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
  PopoverArrow,
} from "./Popover";

const meta = {
  title: "UI/Popover",
  component: Popover,
  parameters: {
    // Radix drives the non-modal floating-panel behaviour (collision-aware
    // positioning, outside-click/Escape dismissal, focus move-in/return, the
    // dialog role + aria-expanded/aria-controls wiring); a11y violations fail the
    // Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Reusable details panel body shared across the stories. */
function DetailsBody(): React.JSX.Element {
  return (
    <div className="flex w-[260px] flex-col gap-2 font-mono text-[0.74rem]">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-text-primary">Session details</span>
        <PopoverClose asChild>
          <IconButton aria-label="Close details">
            <CloseIcon size={14} />
          </IconButton>
        </PopoverClose>
      </div>
      <dl className="flex flex-col gap-1 text-text-primary">
        <div className="flex justify-between gap-3">
          <dt className="font-normal">Branch</dt>
          <dd className="font-medium">csm/radix-ui-migration</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="font-normal">Created</dt>
          <dd className="font-medium">Jun 24, 2026</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="font-normal">Prompts</dt>
          <dd className="font-medium">42</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The canonical anchored details panel: an icon-only kebab trigger (composing the
 * `IconButton` primitive via `asChild`) opening a non-modal floating panel with a
 * baked-in `PopoverClose`.
 */
export const Default: Story = {
  render: () => (
    <Popover onOpenChange={fn()}>
      <PopoverTrigger asChild>
        <IconButton aria-label="Session details">
          <KebabIcon size={16} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent>
        <DetailsBody />
      </PopoverContent>
    </Popover>
  ),
};

/** A labeled trigger composing the `Button` primitive instead of an icon button. */
export const ButtonTrigger: Story = {
  render: () => (
    <Popover onOpenChange={fn()}>
      <PopoverTrigger asChild>
        <Button size="sm">Details</Button>
      </PopoverTrigger>
      <PopoverContent>
        <DetailsBody />
      </PopoverContent>
    </Popover>
  ),
};

/**
 * Opened on mount so the floating surface is reviewable without interaction.
 * The wrapping box gives the portalled panel room below the trigger.
 */
export const StaticOpen: Story = {
  render: () => (
    <div className="flex h-[320px] items-start justify-center pt-[40px]">
      <Popover defaultOpen onOpenChange={fn()}>
        <PopoverTrigger asChild>
          <Button size="sm">Details</Button>
        </PopoverTrigger>
        <PopoverContent>
          <DetailsBody />
          <PopoverArrow />
        </PopoverContent>
      </Popover>
    </div>
  ),
};

/**
 * Controlled open state — the parent owns `open` and reflects it in adjacent UI,
 * the pattern a bespoke disclosure panel (InfoDetailsPopover) hand-rolls today.
 */
export const Controlled: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <div className="flex flex-col items-center gap-3">
        <span className="font-mono text-[0.72rem] text-text-tertiary">
          panel is {open ? "open" : "closed"}
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm">Toggle details</Button>
          </PopoverTrigger>
          <PopoverContent>
            <DetailsBody />
          </PopoverContent>
        </Popover>
      </div>
    );
  },
};

/**
 * Alignment + side variants. Each panel is anchored on a different side/align so
 * the collision-aware positioning and side offset can be reviewed together. The
 * panels suppress content auto-focus here (`onOpenAutoFocus`) so all four can be
 * shown open at once without stealing focus from one another — interactive,
 * single-panel focus management is covered by `ButtonTrigger`/`Default`.
 */
export const AlignmentSides: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-[120px] p-[120px]">
      {(
        [
          { side: "top", align: "start" },
          { side: "right", align: "center" },
          { side: "bottom", align: "end" },
          { side: "left", align: "center" },
        ] as const
      ).map(({ side, align }) => (
        <Popover key={`${side}-${align}`} defaultOpen onOpenChange={fn()}>
          <PopoverTrigger asChild>
            <Button size="sm">
              {side}/{align}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side={side}
            align={align}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <PopoverArrow />
            <p className="w-[180px] font-mono text-[0.72rem] text-text-primary">
              Anchored {side}, aligned {align}.
            </p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  ),
};

/**
 * Constrained content — a long body inside a width-bounded panel set via
 * `layoutClassName` (layout-only). The baked surface caps the panel to Radix's
 * collision-computed available height, so overflow scrolls inside the panel.
 */
export const Constrained: Story = {
  render: () => (
    <div className="flex h-[320px] items-start justify-center pt-[40px]">
      <Popover defaultOpen onOpenChange={fn()}>
        <PopoverTrigger asChild>
          <Button size="sm">Release notes</Button>
        </PopoverTrigger>
        <PopoverContent layoutClassName="w-[280px]">
          <div className="flex flex-col gap-2 font-mono text-[0.74rem] text-text-primary">
            <span className="font-semibold">What changed</span>
            <p>
              The Popover primitive wraps Radix Popover with the canonical CC
              floating surface, a baked-in Portal, the z-popover tier, collision
              padding, and a motion-safe entry animation.
            </p>
            <p>
              It defaults to non-modal so the page behind it stays interactive
              and the trigger is never aria-hidden.
            </p>
            <p>
              Width is bounded by a layout-only className; appearance stays
              owned by the primitive.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
};
