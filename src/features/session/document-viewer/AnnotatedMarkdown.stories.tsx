import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type {
  CommentStatus,
  DocumentComment,
} from "@/lib/document-comments/schemas";
import AnnotatedMarkdown, {
  type CreateCommentInput,
} from "./AnnotatedMarkdown";
import type { ResolvedComment } from "./types";

const meta = {
  title: "Session/DocumentViewer/AnnotatedMarkdown",
  component: AnnotatedMarkdown,
  decorators: [
    (Story) => (
      <div
        style={{
          height: 560,
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
} satisfies Meta<typeof AnnotatedMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Fixtures ──────────────────────────────────────────────────────────────

const DOC_A = [
  "# Design Review", // 1
  "", // 2
  "## Overview", // 3
  "", // 4
  "The viewer renders agent-produced markdown with selection commenting.", // 5
  "", // 6
  "## Details", // 7
  "", // 8
  "Comments persist durably and carry a precise source reference.", // 9
  "", // 10
].join("\n");

const DOC_B = [
  "# Other Document", // 1
  "", // 2
  "## Notes", // 3
  "", // 4
  "A different document with its own single comment passage here.", // 5
  "", // 6
].join("\n");

function makeComment(args: {
  id: string;
  line: number;
  sectionId: string;
  headingLabel: string;
  blockText: string;
  quote: string;
  status: CommentStatus;
  reanchored: boolean;
  note: string;
}): ResolvedComment {
  const charStart = args.blockText.indexOf(args.quote);
  const charEnd = charStart + args.quote.length;
  const comment: DocumentComment = {
    id: args.id,
    projectPath: "/project",
    sessionName: "session",
    docPath: "doc.md",
    anchor: {
      sectionId: args.sectionId,
      headingLabel: args.headingLabel,
      line: args.line,
      charStart,
      charEnd,
      quote: args.quote,
      prefix: "",
      suffix: "",
      docRevision: "rev",
    },
    note: args.note,
    status: args.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: args.status === "sent" ? "2026-01-02T00:00:00.000Z" : null,
  };
  return {
    ...comment,
    reanchor: args.reanchored
      ? { status: "anchored", charStart, charEnd }
      : { status: "stale" },
    stale: !args.reanchored,
  };
}

const DOC_A_COMMENTS: ResolvedComment[] = [
  makeComment({
    id: "a-pending",
    line: 5,
    sectionId: "overview",
    headingLabel: "Overview",
    blockText:
      "The viewer renders agent-produced markdown with selection commenting.",
    quote: "agent-produced markdown",
    status: "pending",
    reanchored: true,
    note: "Clarify what counts as agent-produced.",
  }),
  makeComment({
    id: "a-sent",
    line: 9,
    sectionId: "details",
    headingLabel: "Details",
    blockText: "Comments persist durably and carry a precise source reference.",
    quote: "precise source reference",
    status: "sent",
    reanchored: true,
    note: "Already shipped — good.",
  }),
  makeComment({
    id: "a-stale",
    line: 9,
    sectionId: "details",
    headingLabel: "Details",
    blockText: "Comments persist durably and carry a precise source reference.",
    quote: "this text no longer exists in the document",
    status: "pending",
    reanchored: false,
    note: "Stale — no highlight, no marker.",
  }),
];

const DOC_B_COMMENTS: ResolvedComment[] = [
  makeComment({
    id: "b-pending",
    line: 5,
    sectionId: "notes",
    headingLabel: "Notes",
    blockText: "A different document with its own single comment passage here.",
    quote: "single comment passage",
    status: "pending",
    reanchored: true,
    note: "Belongs only to document B.",
  }),
];

// ── Stories ───────────────────────────────────────────────────────────────

export const PendingAndSent: Story = {
  args: {
    docRef: {
      projectName: "project",
      sessionName: "session",
      docPath: "doc-a.md",
      title: "Design Review",
    },
    content: DOC_A,
    isLoading: false,
    comments: DOC_A_COMMENTS,
  },
};

/**
 * A document taller than its bounded host: the body must scroll WITHIN the
 * viewer (the `AnnotatedMarkdown` container is the scroll ancestor; the
 * `.r6o-annotatable` wrapper and `.markdown-viewer` stay content-height and move
 * inside it so recogito can track scroll) rather than overflowing the host.
 */
const LONG_DOC = [
  "# Long Document",
  "",
  ...Array.from({ length: 40 }, (_, i) =>
    [
      `## Section ${i + 1}`,
      "",
      `Paragraph ${i + 1}: the viewer renders agent-produced markdown with selection commenting and must remain scrollable when the content exceeds the available height.`,
      "",
    ].join("\n"),
  ),
].join("\n");

export const LongDocument: Story = {
  args: {
    docRef: {
      projectName: "project",
      sessionName: "session",
      docPath: "long.md",
      title: "Long Document",
    },
    content: LONG_DOC,
    isLoading: false,
    comments: [],
  },
};

export const Loading: Story = {
  args: {
    docRef: {
      projectName: "project",
      sessionName: "session",
      docPath: "doc-a.md",
      title: "Design Review",
    },
    content: null,
    isLoading: true,
    comments: [],
  },
};

/**
 * Selection → comment: select a passage to reveal the affordance, open the
 * popover, and queue or send. The last created payload is shown for inspection.
 */
export const SelectionCreateFlow: Story = {
  args: {
    docRef: {
      projectName: "project",
      sessionName: "session",
      docPath: "doc-a.md",
      title: "Design Review",
    },
    content: DOC_A,
    isLoading: false,
    comments: [],
  },
  render: () => {
    const [created, setCreated] = useState<CreateCommentInput | null>(null);
    return (
      <>
        <pre
          data-testid="created"
          style={{
            margin: 0,
            padding: 6,
            font: "11px monospace",
            color: "var(--text-secondary)",
            background: "var(--bg-base)",
            minHeight: 18,
          }}
        >
          {created ? JSON.stringify(created) : "(nothing created yet)"}
        </pre>
        <AnnotatedMarkdown
          docRef={{
            projectName: "project",
            sessionName: "session",
            docPath: "doc-a.md",
            title: "Design Review",
          }}
          content={DOC_A}
          isLoading={false}
          comments={[]}
          onCreateComment={setCreated}
        />
      </>
    );
  },
};

/**
 * Switching the open document re-syncs highlights and gutter markers: doc A's
 * two markers give way to doc B's single marker (and vice versa).
 */
export const SwitchingDocuments: Story = {
  args: {
    docRef: {
      projectName: "project",
      sessionName: "session",
      docPath: "doc-a.md",
      title: "Design Review",
    },
    content: DOC_A,
    isLoading: false,
    comments: DOC_A_COMMENTS,
  },
  render: () => {
    const [doc, setDoc] = useState<"a" | "b">("a");
    const isA = doc === "a";
    return (
      <>
        <button
          type="button"
          onClick={() => setDoc(isA ? "b" : "a")}
          style={{
            margin: 8,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--border-default)",
            background: "var(--bg-raised)",
            color: "var(--text-primary)",
            cursor: "pointer",
            font: "inherit",
            alignSelf: "flex-start",
          }}
        >
          Showing document {isA ? "A" : "B"} — switch
        </button>
        <AnnotatedMarkdown
          docRef={{
            projectName: "project",
            sessionName: "session",
            docPath: isA ? "doc-a.md" : "doc-b.md",
            title: isA ? "Design Review" : "Other Document",
          }}
          content={isA ? DOC_A : DOC_B}
          isLoading={false}
          comments={isA ? DOC_A_COMMENTS : DOC_B_COMMENTS}
        />
      </>
    );
  },
};
