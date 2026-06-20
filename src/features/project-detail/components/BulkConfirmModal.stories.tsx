import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import BulkConfirmModal from "./BulkConfirmModal";

const meta = {
  title: "Sessions/BulkConfirmModal",
  component: BulkConfirmModal,
  args: {
    open: true,
    count: 4,
    isPending: false,
    onConfirm: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof BulkConfirmModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Archive — non-danger (cyan primary) confirm button */
export const Archive = {
  args: { kind: "archive" },
} satisfies Story;

/** Unarchive — non-danger confirm button */
export const Unarchive = {
  args: { kind: "unarchive", count: 2 },
} satisfies Story;

/** Delete — danger (red) confirm button */
export const Delete = {
  args: { kind: "delete", count: 5 },
} satisfies Story;
