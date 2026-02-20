import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ConfirmDialog from "./ConfirmDialog";

const meta = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    open: true,
    onConfirm: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    title: "Confirm Action",
    message: "Are you sure you want to proceed?",
  },
} satisfies Story;

export const Danger = {
  args: {
    title: "Delete Session",
    message:
      "This will permanently delete the session and its worktree. This action cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  },
} satisfies Story;

export const CustomLabels = {
  args: {
    title: "Discard Changes",
    message: "You have unsaved changes. Do you want to discard them?",
    confirmLabel: "Discard",
    cancelLabel: "Keep Editing",
  },
} satisfies Story;

export const Closed = {
  args: {
    open: false,
    title: "Hidden Dialog",
    message: "This dialog is not visible.",
  },
} satisfies Story;
