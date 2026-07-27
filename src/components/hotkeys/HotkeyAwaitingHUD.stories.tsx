import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HotkeyAwaitingHUDPresentation } from "./HotkeyAwaitingHUD";

const meta = {
  title: "Command Center/Hotkeys/HotkeyAwaitingHUD",
  component: HotkeyAwaitingHUDPresentation,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[min(42rem,calc(100vw-2rem))] rounded-lg border border-border-default bg-bg-surface p-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HotkeyAwaitingHUDPresentation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AwaitingCommand: Story = {
  args: {
    attached: false,
  },
};

export const AwaitingLeaderCompletion: Story = {
  args: {
    attached: false,
    prefix: ["g"],
  },
};
