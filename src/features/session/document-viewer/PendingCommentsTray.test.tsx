// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { ResolvedComment } from "./types";
import PendingCommentsTray from "./PendingCommentsTray";

function pending(
  over: Partial<DocumentComment> & { id: string },
): ResolvedComment {
  const base: DocumentComment = {
    id: over.id,
    projectPath: "/p",
    sessionName: "s",
    docPath: "doc.md",
    anchor: over.anchor ?? {
      sectionId: "overview",
      headingLabel: "1. Overview",
      line: 7,
      charStart: 0,
      charEnd: 5,
      quote: `quote-${over.id}`,
      prefix: "",
      suffix: "",
      docRevision: "r1",
    },
    note: over.note ?? `note-${over.id}`,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
  };
  return {
    ...base,
    reanchor: { status: "anchored", charStart: 0, charEnd: 5 },
    stale: false,
  };
}

function staleify(comment: ResolvedComment): ResolvedComment {
  return { ...comment, reanchor: { status: "stale" }, stale: true };
}

function setup(comments: ResolvedComment[], expanded = false) {
  const onToggleExpanded = vi.fn();
  const onJump = vi.fn();
  const onOpen = vi.fn();
  const onRemove = vi.fn();
  const onClear = vi.fn();
  const onSendAll = vi.fn();
  const utils = render(
    <PendingCommentsTray
      pendingComments={comments}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      onJump={onJump}
      onOpen={onOpen}
      onRemove={onRemove}
      onClear={onClear}
      onSendAll={onSendAll}
    />,
  );
  return {
    onToggleExpanded,
    onJump,
    onOpen,
    onRemove,
    onClear,
    onSendAll,
    ...utils,
  };
}

describe("PendingCommentsTray", () => {
  it("renders nothing when there are no pending comments", () => {
    const { container } = setup([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the pending count (collapsed) without listing the comments", () => {
    setup([pending({ id: "a" }), pending({ id: "b" })]);
    expect(
      screen.getByRole("button", { name: /2 pending comments/i }),
    ).toBeInTheDocument();
    // collapsed → individual comment notes are not rendered
    expect(screen.queryByText("note-a")).not.toBeInTheDocument();
  });

  it("uses a singular label for a single pending comment", () => {
    setup([pending({ id: "only" })]);
    expect(
      screen.getByRole("button", { name: /1 pending comment to send/i }),
    ).toBeInTheDocument();
  });

  it("lists each pending comment with its location, quote, and note when expanded", () => {
    setup(
      [
        pending({
          id: "a",
          anchor: {
            sectionId: "intro",
            headingLabel: "Intro",
            line: 3,
            charStart: 0,
            charEnd: 5,
            quote: "first passage",
            prefix: "",
            suffix: "",
            docRevision: "r1",
          },
          note: "tighten this",
        }),
        pending({ id: "b", note: "and this" }),
      ],
      true,
    );
    expect(screen.getByText("§ Intro · L3")).toBeInTheDocument();
    expect(screen.getByText(/first passage/)).toBeInTheDocument();
    expect(screen.getByText("tighten this")).toBeInTheDocument();
    expect(screen.getByText("and this")).toBeInTheDocument();
  });

  it("toggles expansion", async () => {
    const user = userEvent.setup();
    const { onToggleExpanded } = setup([pending({ id: "a" })]);
    await user.click(
      screen.getByRole("button", { name: /1 pending comment/i }),
    );
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("jumps to a comment's passage", async () => {
    const user = userEvent.setup();
    const { onJump } = setup([pending({ id: "a" })], true);
    await user.click(screen.getByRole("button", { name: /jump/i }));
    expect(onJump).toHaveBeenCalledWith("a");
  });

  it("opens a comment's card for editing", async () => {
    const user = userEvent.setup();
    const { onOpen } = setup([pending({ id: "a" })], true);
    await user.click(screen.getByRole("button", { name: /edit comment/i }));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("offers an edit affordance for a stale comment (its only card entry point)", async () => {
    const user = userEvent.setup();
    const { onOpen } = setup([staleify(pending({ id: "s" }))], true);
    // A stale comment has no in-document highlight/gutter pin, so the tray's
    // Edit action is the only way to reach its card (11.5).
    expect(screen.getByText("Stale")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /edit comment/i }));
    expect(onOpen).toHaveBeenCalledWith("s");
  });

  it("removes a single pending comment", async () => {
    const user = userEvent.setup();
    const { onRemove } = setup([pending({ id: "a" })], true);
    await user.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("clears all pending comments", async () => {
    const user = userEvent.setup();
    const { onClear } = setup([pending({ id: "a" }), pending({ id: "b" })]);
    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("exposes a bulk send labelled with the pending count", async () => {
    const user = userEvent.setup();
    const { onSendAll } = setup([
      pending({ id: "a" }),
      pending({ id: "b" }),
      pending({ id: "c" }),
    ]);
    const sendButton = screen.getByRole("button", { name: /send 3/i });
    await user.click(sendButton);
    expect(onSendAll).toHaveBeenCalledTimes(1);
  });
});
