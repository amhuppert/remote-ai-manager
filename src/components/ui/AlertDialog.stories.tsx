import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { Button } from "./Button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogActions,
  AlertDialogAction,
  AlertDialogCancel,
} from "./AlertDialog";

const meta = {
  title: "UI/AlertDialog",
  component: AlertDialog,
  parameters: {
    // Radix drives the WAI-ARIA Alert Dialog pattern (role=alertdialog, focus
    // trap + return, default focus on the safe cancel action, Escape dismissal);
    // a11y violations fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof AlertDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A non-destructive confirm: neutral cancel + primary confirm. */
export const Confirm: Story = {
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button>Archive session</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Archive session?</AlertDialogTitle>
        <AlertDialogDescription>
          It stays accessible via &ldquo;Include archived&rdquo;.
        </AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={fn()}>Archive</AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

/**
 * A destructive confirm: the action takes the red danger variant, and Radix
 * leaves focus on the safe Cancel button (never the destructive action).
 */
export const Destructive: Story = {
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="danger">Delete session</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete session?</AlertDialogTitle>
        <AlertDialogDescription>
          This permanently removes the worktree, history, and state. The git
          branch is preserved. This cannot be undone.
        </AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction danger onClick={fn()}>
            Delete
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

/** Acknowledge-only (info) dialog — no cancel button. */
export const AcknowledgeOnly: Story = {
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button>Show notice</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Merge complete</AlertDialogTitle>
        <AlertDialogDescription>
          The branch was merged and the worktree cleaned up.
        </AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogAction onClick={fn()}>Got it</AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

/**
 * Pending state — the destructive action is disabled while the confirm is in
 * flight, but Cancel stays enabled. Open focus lands on the enabled, safe Cancel
 * (a focusable target always remains inside the modal); the user can still back
 * out while the operation runs.
 */
export const Pending: Story = {
  render: () => (
    <AlertDialog defaultOpen>
      <AlertDialogTrigger asChild>
        <Button variant="danger">Delete session</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete session?</AlertDialogTitle>
        <AlertDialogDescription>
          Removing the worktree and history…
        </AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction danger disabled>
            Deleting…
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

/** Opened on mount so the destructive card + scrim are reviewable statically. */
export const StaticOpen: Story = {
  render: () => (
    <AlertDialog defaultOpen>
      <AlertDialogTrigger asChild>
        <Button variant="danger">Delete session</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete session?</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction danger>Delete</AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  ),
};
