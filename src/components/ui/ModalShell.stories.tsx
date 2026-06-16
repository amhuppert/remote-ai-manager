import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { ModalShell, ModalTitle, ModalActions } from "./ModalShell";
import { Button } from "./Button";

const meta = {
  title: "UI/ModalShell",
  component: ModalShell,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
} satisfies Meta<typeof ModalShell>;

export default meta;
type Story = StoryObj<typeof meta>;

const body: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.82rem",
  lineHeight: 1.55,
  marginBottom: 16,
};

/** Default modal shell with title, body, and right-aligned actions. */
export const Default: Story = {
  render: () => (
    <ModalShell role="dialog" aria-labelledby="ms-default-title">
      <ModalTitle id="ms-default-title">Create session</ModalTitle>
      <p style={body}>
        Spawns a worktree and branch for the selected project. This action is
        reversible.
      </p>
      <ModalActions>
        <Button variant="ghost" size="sm" onClick={fn()}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={fn()}>
          Create
        </Button>
      </ModalActions>
    </ModalShell>
  ),
};

/** Confirm size narrows the card to 400px. */
export const Confirm: Story = {
  render: () => (
    <ModalShell size="confirm" role="dialog" aria-labelledby="ms-confirm-title">
      <ModalTitle id="ms-confirm-title">Delete session?</ModalTitle>
      <p style={body}>
        This removes the worktree and branch. It cannot be undone.
      </p>
      <ModalActions>
        <Button variant="ghost" size="sm" onClick={fn()}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" onClick={fn()}>
          Delete
        </Button>
      </ModalActions>
    </ModalShell>
  ),
};

/** layoutClassName widens the card via external geometry (max-width). */
export const LayoutPlacement: Story = {
  render: () => (
    <ModalShell
      role="dialog"
      aria-labelledby="ms-wide-title"
      layoutClassName="max-w-[640px]"
    >
      <ModalTitle id="ms-wide-title">Wide shell</ModalTitle>
      <p style={body}>
        The card is stretched to 640px through layoutClassName.
      </p>
    </ModalShell>
  ),
};
