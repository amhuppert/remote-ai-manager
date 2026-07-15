import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MobileComposerBar from "@/components/session/prompt/MobileComposerBar";

const meta = {
  title: "Prompt/MobileComposerBar",
  component: MobileComposerBar,
  args: {
    placeholder: "Message Claude…",
    onExpand: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 390,
          padding: 8,
          background: "var(--cc-bg-base-a60, var(--bg-base))",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileComposerBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const Codex = {
  args: { placeholder: "Message Codex…" },
} satisfies Story;

export const ReadOnly = {
  args: {
    placeholder: "Session is merged and read-only",
    disabled: true,
  },
} satisfies Story;
