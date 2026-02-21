import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ConversationNav from "./ConversationNav";

const meta = {
  title: "Components/ConversationNav",
  component: ConversationNav,
  args: {
    onFirst: fn(),
    onPrevious: fn(),
    onNext: fn(),
    onLast: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "rgba(17, 24, 37, 0.5)",
          borderBottom: "1px solid var(--border-subtle)",
          padding: "12px 24px",
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConversationNav>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    currentTurn: 4,
    totalTurns: 12,
  },
} satisfies Story;

export const AtStart = {
  args: {
    currentTurn: 0,
    totalTurns: 12,
  },
} satisfies Story;

export const AtEnd = {
  args: {
    currentTurn: 11,
    totalTurns: 12,
  },
} satisfies Story;

export const Empty = {
  args: {
    currentTurn: 0,
    totalTurns: 0,
  },
} satisfies Story;

export const SingleTurn = {
  args: {
    currentTurn: 0,
    totalTurns: 1,
  },
} satisfies Story;

export const MobileWidth = {
  args: {
    currentTurn: 4,
    totalTurns: 12,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;
