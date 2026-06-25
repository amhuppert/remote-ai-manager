import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import HotkeyHelpModal from "./HotkeyHelpModal";
import "@/features/_root/styles/keyboard-shortcuts-modal.css";

const meta = {
  title: "Components/HotkeyHelpModal",
  component: HotkeyHelpModal,
  args: {
    open: true,
    onClose: fn(),
  },
} satisfies Meta<typeof HotkeyHelpModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const Closed = {
  args: { open: false },
} satisfies Story;
