import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import CommandIndicator from "./CommandIndicator";

const meta = {
  title: "Components/CommandIndicator",
  component: CommandIndicator,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof CommandIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleLine = {
  args: {
    name: "/collab",
    args: "find conflicts in the merge",
  },
} satisfies Story;

export const NoArgs = {
  args: {
    name: "/compact",
    args: null,
  },
} satisfies Story;

export const LongSingleLine = {
  args: {
    name: "/kiro:spec-status",
    args: "this is a fairly long argument that should still render on a single line, ellipsizing if it overflows the available width of its container in the conversation view",
  },
} satisfies Story;

export const MultilineMarkdown = {
  args: {
    name: "/collab",
    args: `I want to change a couple of parts of the debug mode flow.

**Change 1: Auto-apply fix after evidence analysis**

When the user has clicked the "Mark Reproduced" button, the agent should analyze the evidence and either apply the fix immediately or perform another hypothesize/instrument pass.

**Change 2: Stop \`fixing\` from being a steady state**

The \`fixing\` phase should not be a user-visible steady state. After the agent acts, it should park back at \`awaiting_reproduction\`.

Open questions:

- How do we surface partial progress?
- Should the timeline still show \`fixing\`?`,
  },
} satisfies Story;

export const MultilineWithList = {
  args: {
    name: "/review",
    args: `Please review the following:

1. State machine transitions in conversation/machine.ts
2. New \`DebugActionCard\` button wiring
3. Prompt text changes

Pay special attention to:
- Edge cases around concurrent button presses
- Backwards compatibility with existing transcripts`,
  },
} satisfies Story;

export const CodexBackend = {
  decorators: [
    (Story) => (
      <div className="conversation" data-backend="codex">
        <Story />
      </div>
    ),
  ],
  args: {
    name: "/collab",
    args: `Codex variant — same component, violet identity rail.

- bullet one
- bullet two`,
  },
} satisfies Story;
