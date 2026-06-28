import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MarkdownViewer from "@/components/MarkdownViewer";
import {
  markdownViewerComponents,
  rehypeStampSourcePosition,
} from "./markdown-components";

/**
 * The shared MarkdownViewer rendered the way the document viewer drives it:
 * prototype typography/spacing (from the `.markdown-content` rules) plus the
 * injected decorative cyan chevron list markers and the source-position stamp.
 * Selecting text shows the cyan selection tint.
 */
const meta = {
  title: "Session/DocumentViewer/MarkdownComponents",
  component: MarkdownViewer,
  args: {
    isLoading: false,
    components: markdownViewerComponents,
    rehypePlugins: [rehypeStampSourcePosition],
  },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 620,
          width: 760,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkdownViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

const prototypeMarkdown = `# Document Feedback Viewer

The viewer renders agent-produced markdown with the design prototype's
typography. Select any passage to see the cyan selection tint, then attach a
comment.

## Decorative list markers

Unordered lists use a cyan chevron in place of the default bullet disc:

- First point, with enough text to wrap onto a second line so the chevron's
  baseline alignment and the row gap are both visible at a glance.
- Second point
- Third point

Ordered lists keep their numbers:

1. Step one
2. Step two
3. Step three

## Typography and surfaces

A blockquote sits on the raised surface with a cyan left border:

> Comments live with the document, not the conversation — they persist durably
> and carry a precise source reference (file, section, line, exact quote).

Inline \`code\` and fenced blocks use the monospace font:

\`\`\`typescript
interface CommentAnchor {
  sectionId: string;
  headingLabel: string;
  line: number;
}
\`\`\`

### Nested detail

1. Outer item
   - nested chevron item
   - another nested item
2. Second outer item
`;

export const PrototypeStyling: Story = {
  args: {
    content: prototypeMarkdown,
  },
};

export const Loading: Story = {
  args: {
    content: null,
    isLoading: true,
  },
};

export const ErrorState: Story = {
  args: {
    content: null,
    isLoading: false,
    emptyMessage: "This document could not be loaded.",
  },
};
