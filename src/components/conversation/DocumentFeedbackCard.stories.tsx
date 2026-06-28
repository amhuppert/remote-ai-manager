import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import DocumentFeedbackCard from "./DocumentFeedbackCard";

const meta = {
  title: "Conversation/DocumentFeedbackCard",
  component: DocumentFeedbackCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DocumentFeedbackCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A single feedback item — path, section/line, quoted passage, and note. */
export const Single: Story = {
  args: {
    items: [
      {
        docPath: ".kiro/specs/markdown-doc-feedback/design.md",
        path: ".kiro/specs/markdown-doc-feedback/design.md",
        headingLabel: "Prompt pipeline extension",
        line: 487,
        quote:
          "documentFeedback must be threaded through the full conversation-actor send funnel",
        note: "Confirm the queue drain re-emits the block too.",
      },
    ],
  },
};

/** Multiple items as delivered by a bulk send — the header shows the count. */
export const Multiple: Story = {
  args: {
    items: [
      {
        docPath: "README.md",
        path: "README.md",
        headingLabel: "Getting started",
        line: 7,
        quote: "run bun run dev",
        note: "This command is out of date — it's `bun dev` now.",
      },
      {
        docPath: "docs/architecture.md",
        path: "docs/architecture.md",
        headingLabel: "Persistence",
        line: 42,
        quote: "a single SQLite database is the source of truth",
        note: "Worth linking the WAL-mode rationale here.",
      },
    ],
  },
};
