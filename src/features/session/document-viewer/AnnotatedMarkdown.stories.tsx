import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type {
  CommentStatus,
  DocumentComment,
} from "@/lib/document-comments/schemas";
import AnnotatedMarkdown, {
  type CreateCommentInput,
} from "./AnnotatedMarkdown";
import type { ResolvedComment } from "./types";

/**
 * Programmatically select `quote` within the rendered document and complete the
 * selection the way a real user would — on pointer release (mouse/touch) or key
 * release (keyboard). Used by the interaction plays to exercise the affordance.
 */
// The document renderer is deferred (lazy chunk + recogito), so first paint can
// take a few seconds on a cold Storybook — give the interaction waits ample room.
const PLAY_TIMEOUT = 15000;

async function selectPassage(
  root: HTMLElement,
  quote: string,
  complete: "pointerup" | "keyup",
): Promise<void> {
  const paragraph = await waitFor(
    () => {
      const el = Array.from(root.querySelectorAll("p")).find((node) =>
        node.textContent?.includes(quote),
      );
      if (!el) throw new Error(`passage not rendered yet: ${quote}`);
      return el;
    },
    { timeout: PLAY_TIMEOUT },
  );
  const textNode = Array.from(paragraph.childNodes).find(
    (node): node is Text =>
      node.nodeType === Node.TEXT_NODE &&
      (node.textContent ?? "").includes(quote),
  );
  if (!textNode) throw new Error(`no text node for: ${quote}`);
  const offset = (textNode.textContent ?? "").indexOf(quote);

  const range = document.createRange();
  range.setStart(textNode, offset);
  range.setEnd(textNode, offset + quote.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  if (complete === "pointerup") {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  } else {
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
      }),
    );
  }
}

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
  // Gutter geometry: the anchored comments each paint one marker, and every
  // marker sits fully left of the document text — the reserved inset keeps the
  // 50px gutter clear of the canonical body so pins never overlap the prose.
  play: async ({ canvasElement }) => {
    const viewport = await waitFor(
      () => {
        const el = canvasElement.querySelector<HTMLElement>(
          "[data-markdown-viewport]",
        );
        if (!el) throw new Error("viewport not rendered");
        return el;
      },
      { timeout: PLAY_TIMEOUT },
    );

    const pins = await waitFor(
      () => {
        const found = within(viewport).getAllByRole("button", {
          name: /on this passage$/,
        });
        // two anchored blocks (the stale comment paints no marker)
        if (found.length !== 2) throw new Error("gutter not measured yet");
        return found;
      },
      { timeout: PLAY_TIMEOUT },
    );

    const textLeft = Math.min(
      ...Array.from(viewport.querySelectorAll("p")).map(
        (p) => p.getBoundingClientRect().left,
      ),
    );
    for (const pin of pins) {
      await expect(pin.getBoundingClientRect().right).toBeLessThanOrEqual(
        textLeft + 1,
      );
    }
  },
};

/**
 * A document taller than its bounded host: the body must scroll WITHIN the
 * viewer (the `MarkdownViewport` is the scroll ancestor; the `.r6o-annotatable`
 * wrapper and the source-mapped document root stay content-height and move inside
 * it so recogito can track scroll) rather than overflowing the host.
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
  // Selection → comment for BOTH input modalities: a keyboard-completed selection
  // (keyup) reveals the affordance, and a pointer-completed selection carries
  // through to a queued comment.
  play: async ({ canvasElement }) => {
    const body = within(document.body);

    // Keyboard selection completes on key release, never firing a pointer event.
    await selectPassage(canvasElement, "agent-produced markdown", "keyup");
    await body.findByRole(
      "button",
      { name: "Comment" },
      { timeout: PLAY_TIMEOUT },
    );

    // Dismiss the affordance (outside pointerdown), then drive the pointer path.
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    await waitFor(() =>
      expect(body.queryByRole("button", { name: "Comment" })).toBeNull(),
    );

    await selectPassage(canvasElement, "selection commenting", "pointerup");
    await userEvent.click(
      await body.findByRole(
        "button",
        { name: "Comment" },
        { timeout: PLAY_TIMEOUT },
      ),
    );
    await userEvent.type(
      await body.findByLabelText("Comment note"),
      "Clarify what counts as agent-produced.",
    );
    const add = body.getByRole("button", { name: "Add comment" });
    await expect(add).toBeEnabled();
    await userEvent.click(add);

    await waitFor(() =>
      expect(within(canvasElement).getByTestId("created")).toHaveTextContent(
        '"send":false',
      ),
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
