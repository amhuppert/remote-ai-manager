import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { HOTKEY_REGISTRY } from "@/lib/shared/hotkeys";
import { CommandLauncher } from "./CommandLauncher";

const commands = [
  "switchProject",
  "quickTicket",
  "focusComposer",
  "clearInput",
] as const;

const meta = {
  title: "Command Center/Hotkeys/CommandLauncher",
  component: CommandLauncher,
  args: {
    open: true,
    onClose: fn(),
    onRun: fn(),
    commands: commands.map((id) => ({
      definition: HOTKEY_REGISTRY[id],
      registered: true,
      available: true,
    })),
  },
} satisfies Meta<typeof CommandLauncher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoAvailableCommands: Story = {
  args: {
    commands: [],
  },
};
