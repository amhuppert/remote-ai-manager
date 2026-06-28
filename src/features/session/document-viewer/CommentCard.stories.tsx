import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type {
  CommentStatus,
  DocumentComment,
} from "@/lib/document-comments/schemas";
import type { ResolvedComment } from "./types";
import CommentCard, { type CommentCardSave } from "./CommentCard";

const meta = {
  title: "Session/DocumentViewer/CommentCard",
  component: CommentCard,
  decorators: [
    (Story) => (
      <div
        style={{
          padding: 24,
          background: "var(--bg-surface)",
          display: "inline-block",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CommentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function makeComment(args: {
  status: CommentStatus;
  stale?: boolean;
  note?: string;
}): ResolvedComment {
  const base: DocumentComment = {
    id: "c1",
    projectPath: "/project",
    sessionName: "session",
    docPath: "design.md",
    anchor: {
      sectionId: "overview",
      headingLabel: "2. Overview",
      line: 14,
      charStart: 0,
      charEnd: 24,
      quote: "the viewer renders agent-produced markdown",
      prefix: "",
      suffix: "",
      docRevision: "rev",
    },
    note: args.note ?? "Clarify what counts as agent-produced here.",
    status: args.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: args.status === "sent" ? "2026-01-02T00:00:00.000Z" : null,
  };
  return {
    ...base,
    reanchor: args.stale
      ? { status: "stale" }
      : { status: "anchored", charStart: 0, charEnd: 24 },
    stale: args.stale ?? false,
  };
}

/** Interactive wrapper so Edit → Save round-trips to a visible "last saved" line. */
function Interactive({
  comment,
}: {
  comment: ResolvedComment;
}): React.JSX.Element {
  const [current, setCurrent] = useState(comment);
  const [lastSave, setLastSave] = useState<CommentCardSave | null>(null);

  const handleSave = (update: CommentCardSave): void => {
    setLastSave(update);
    setCurrent((c) => ({
      ...c,
      note: update.note,
      status: update.status ?? c.status,
    }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <CommentCard
        comment={current}
        onSave={handleSave}
        onRemove={() => setLastSave({ note: "(removed)" })}
        onSendNow={() => setLastSave({ note: "(sent now)" })}
      />
      <pre
        style={{
          margin: 0,
          font: "11px monospace",
          color: "var(--text-secondary)",
        }}
      >
        {lastSave ? JSON.stringify(lastSave) : "(no action yet)"}
      </pre>
    </div>
  );
}

export const Pending: Story = {
  args: {
    comment: makeComment({ status: "pending" }),
    onSave: () => {},
    onRemove: () => {},
    onSendNow: () => {},
  },
  render: (args) => <Interactive comment={args.comment} />,
};

export const Sent: Story = {
  args: {
    comment: makeComment({ status: "sent" }),
    onSave: () => {},
    onRemove: () => {},
    onSendNow: () => {},
  },
  render: (args) => <Interactive comment={args.comment} />,
};

export const StalePending: Story = {
  args: {
    comment: makeComment({ status: "pending", stale: true }),
    onSave: () => {},
    onRemove: () => {},
    onSendNow: () => {},
  },
  render: (args) => <Interactive comment={args.comment} />,
};
