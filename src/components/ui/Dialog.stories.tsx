import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { CloseIcon } from "@/components/icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { FormGroup, FormLabel, FormInput } from "./FormField";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogActions,
  DialogClose,
} from "./Dialog";

const meta = {
  title: "UI/Dialog",
  component: Dialog,
  parameters: {
    // Radix drives the WAI-ARIA Dialog (Modal) pattern (focus trap + return,
    // Escape/outside-click dismissal, aria-modal/labelledby/describedby, inert
    // background); a11y violations fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The canonical content modal: a trigger (composing the `Button` primitive via
 * `asChild`) opening a 480px card with a title, a form body, and a right-aligned
 * actions row. The footer `DialogClose` cancels; the primary `Button` confirms.
 */
export const Default: Story = {
  render: () => {
    const [name, setName] = useState("auth-refactor");
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button>Edit session</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Edit session</DialogTitle>
          <DialogDescription>
            Rename this session. The git branch is unaffected.
          </DialogDescription>
          <FormGroup>
            <FormLabel htmlFor="session-name">Name</FormLabel>
            <FormInput
              id="session-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormGroup>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="default" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="primary" size="sm" onClick={fn()}>
                Save
              </Button>
            </DialogClose>
          </DialogActions>
        </DialogContent>
      </Dialog>
    );
  },
};

/**
 * A corner icon-only close affordance (composing `IconButton` via `asChild`) in
 * addition to the footer actions — the shape used by the longer reference
 * modals (HotkeyHelpModal, McpServersModal).
 */
export const WithCornerClose: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open details</Button>
      </DialogTrigger>
      <DialogContent>
        <div className="absolute top-md right-md">
          <DialogClose asChild>
            <IconButton aria-label="Close">
              <CloseIcon size={16} />
            </IconButton>
          </DialogClose>
        </div>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Press the highlighted keys anywhere in the app.
        </DialogDescription>
        <DialogActions>
          <DialogClose asChild>
            <Button variant="default" size="sm">
              Done
            </Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  ),
};

/** Scrollable mobile bottom-sheet variant (`mobileSheet`); review in landscape. */
export const MobileSheet: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>New session</Button>
      </DialogTrigger>
      <DialogContent mobileSheet>
        <DialogTitle>New session</DialogTitle>
        <DialogDescription>
          Docked as a bottom sheet on narrow viewports. Every field and action
          stays reachable when the content is taller than the viewport.
        </DialogDescription>
        {[
          ["project", "Project"],
          ["title", "Title"],
          ["owner", "Owner"],
          ["branch", "Branch"],
          ["status", "Status"],
          ["type", "Work type"],
          ["context", "Context"],
        ].map(([id, label]) => (
          <FormGroup key={id}>
            <FormLabel htmlFor={`mobile-sheet-${id}`}>{label}</FormLabel>
            <FormInput id={`mobile-sheet-${id}`} defaultValue={label} />
          </FormGroup>
        ))}
        <DialogActions>
          <DialogClose asChild>
            <Button variant="default" size="sm" touch>
              Cancel
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="primary" size="sm" touch>
              Create
            </Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  ),
};

/**
 * The `unstyled` + `anchor="stretch"` escape hatch: a right-edge slide-over that
 * owns its own box model via `layoutClassName` while Radix keeps the focus trap,
 * Escape/outside-press dismissal, scroll-lock, and `role="dialog"` wiring — the
 * shape the bespoke `DiffSlideover`/agent-capabilities drawers now compose
 * instead of hand-rolling a `role="dialog"` div with a manual keydown loop.
 */
export const UnstyledSlideOver: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open slide-over</Button>
      </DialogTrigger>
      <DialogContent
        unstyled
        anchor="stretch"
        scrimClassName="fixed inset-0 z-dropdown bg-[var(--cc-bg-void-a60)] [backdrop-filter:blur(4px)_saturate(120%)]"
        contentClassName="fixed top-0 right-0 bottom-0 flex w-[min(480px,100vw)] flex-col border-y-0 border-r-0 border-l border-solid border-border-default bg-bg-base shadow-[-16px_0_48px_var(--cc-black-a55)]"
        aria-label="Slide-over panel"
      >
        <div className="flex items-center gap-md border-x-0 border-t-0 border-b border-solid border-border-default px-lg py-md">
          <DialogTitle layoutClassName="mb-0">Review</DialogTitle>
          <DialogClose asChild>
            <IconButton aria-label="Close" layoutClassName="ml-auto">
              <CloseIcon size={16} />
            </IconButton>
          </DialogClose>
        </div>
        <div className="flex-1 overflow-y-auto px-lg py-md font-mono text-[0.85rem] text-text-secondary">
          Edge-anchored body. The card positions itself; the primitive supplies
          Portal + scrim + focus trap + dismissal.
        </div>
      </DialogContent>
    </Dialog>
  ),
};

/** Opened on mount so the card + scrim are reviewable without interaction. */
export const StaticOpen: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button>Edit session</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Edit session</DialogTitle>
        <DialogDescription>
          The dialog renders open so the surface is reviewable statically.
        </DialogDescription>
        <DialogActions>
          <DialogClose asChild>
            <Button variant="default" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="primary" size="sm">
              Save
            </Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  ),
};
