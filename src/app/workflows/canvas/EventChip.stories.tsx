import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import EventChip from "./EventChip";

const meta = {
  title: "Workflows/Canvas/EventChip",
  component: EventChip,
  args: {
    x: 100,
    y: 60,
    label: "SUBMIT_PROMPT",
  },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: 240,
          height: 120,
          background: "var(--bg-base)",
          borderRadius: 8,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EventChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Solid = {
  args: { variant: "solid" },
} satisfies Story;

export const Subtle = {
  args: { variant: "subtle", label: "onDone" },
} satisfies Story;

export const WithGuard = {
  args: { label: "onError", guard: "hasFixRetriesRemaining" },
} satisfies Story;

export const Active = {
  args: { active: true },
} satisfies Story;
