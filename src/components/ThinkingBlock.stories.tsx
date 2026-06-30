import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ThinkingBlock from "./ThinkingBlock";

const SAMPLE = `The failing assertion lives in \`MessageRow.test.tsx\`, which checks the **assistant role color**. Two candidates:

- the color regressed during the Tailwind migration
- the test's selector is stale and asserts the old class

I'll read the test to see exactly what it queries, then compare against the component's current \`className\` output before deciding which side is wrong.`;

const meta = {
  title: "Components/ThinkingBlock",
  component: ThinkingBlock,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[560px] bg-bg-void p-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ThinkingBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Resting state — click "Thinking" to expand the reasoning. */
export const Collapsed = {
  args: { text: SAMPLE },
} satisfies Story;

/** Encrypted reasoning the provider won't reveal — label only, no toggle. */
export const Redacted = {
  args: { text: "", redacted: true },
} satisfies Story;

/**
 * In a transcript turn: the reasoning aside sits ahead of the answer and reads
 * as secondary (italic, dimmer) so it never competes with the final response.
 */
export const InContext = {
  args: { text: SAMPLE },
  render: () => (
    <div>
      <div className="mb-md font-mono text-[0.7rem] font-bold tracking-[0.1em] text-cyan uppercase">
        Claude
      </div>
      <ThinkingBlock text={SAMPLE} />
      <p className="mt-md font-body text-[0.92rem] leading-[1.68] text-text-primary">
        The component is correct. The migration moved the assistant role color
        to an arbitrary utility so the Codex override could win the cascade. The
        test still asserted the old class, so I updated the selector to match —
        no component change needed.
      </p>
    </div>
  ),
} satisfies Story;
