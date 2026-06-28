import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { ResolvedComment } from "./types";
import PendingCommentsTray from "./PendingCommentsTray";

const meta = {
  title: "Session/DocumentViewer/PendingCommentsTray",
  component: PendingCommentsTray,
  decorators: [
    (Story) => (
      <div
        style={{
          width: 560,
          height: 360,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: 1 }} />
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PendingCommentsTray>;

export default meta;
type Story = StoryObj<typeof meta>;

function pending(args: {
  id: string;
  headingLabel: string;
  line: number;
  quote: string;
  note: string;
  stale?: boolean;
}): ResolvedComment {
  const base: DocumentComment = {
    id: args.id,
    projectPath: "/project",
    sessionName: "session",
    docPath: "design.md",
    anchor: {
      sectionId: "s",
      headingLabel: args.headingLabel,
      line: args.line,
      charStart: 0,
      charEnd: args.quote.length,
      quote: args.quote,
      prefix: "",
      suffix: "",
      docRevision: "rev",
    },
    note: args.note,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
  };
  return {
    ...base,
    reanchor: args.stale
      ? { status: "stale" }
      : { status: "anchored", charStart: 0, charEnd: args.quote.length },
    stale: args.stale ?? false,
  };
}

const COMMENTS: ResolvedComment[] = [
  pending({
    id: "a",
    headingLabel: "1. Overview",
    line: 7,
    quote: "agent-produced markdown",
    note: "Clarify what counts as agent-produced.",
  }),
  pending({
    id: "b",
    headingLabel: "3. Anchoring",
    line: 41,
    quote: "exact-match re-anchoring",
    note: "Mention the bounded nearby search here.",
  }),
  pending({
    id: "c",
    headingLabel: "3. Anchoring",
    line: 52,
    quote: "marked stale",
    note: "This passage moved — verify it still applies.",
    stale: true,
  }),
];

/** Interactive wrapper that drives the controlled `expanded` state and lets the
 *  remove/clear actions actually mutate the list for review. */
function Interactive({
  initialExpanded,
}: {
  initialExpanded: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [comments, setComments] = useState(COMMENTS);

  return (
    <PendingCommentsTray
      pendingComments={comments}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((e) => !e)}
      onJump={() => {}}
      onOpen={() => {}}
      onRemove={(id) => setComments((cs) => cs.filter((c) => c.id !== id))}
      onClear={() => setComments([])}
      onSendAll={() => setComments([])}
    />
  );
}

export const Collapsed: Story = {
  args: {
    pendingComments: COMMENTS,
    expanded: false,
    onToggleExpanded: () => {},
    onJump: () => {},
    onOpen: () => {},
    onRemove: () => {},
    onClear: () => {},
    onSendAll: () => {},
  },
  render: () => <Interactive initialExpanded={false} />,
};

export const Expanded: Story = {
  args: {
    pendingComments: COMMENTS,
    expanded: true,
    onToggleExpanded: () => {},
    onJump: () => {},
    onOpen: () => {},
    onRemove: () => {},
    onClear: () => {},
    onSendAll: () => {},
  },
  render: () => <Interactive initialExpanded={true} />,
};
