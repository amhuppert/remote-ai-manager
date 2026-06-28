// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { ResolvedComment } from "./types";
import CommentCard from "./CommentCard";

function resolved(over: Partial<DocumentComment>): ResolvedComment {
  const base: DocumentComment = {
    id: "c1",
    projectPath: "/p",
    sessionName: "s",
    docPath: "doc.md",
    anchor: {
      sectionId: "overview",
      headingLabel: "2. Overview",
      line: 12,
      charStart: 0,
      charEnd: 5,
      quote: "the selected passage",
      prefix: "",
      suffix: "",
      docRevision: "r1",
    },
    note: "needs clarification",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
    ...over,
  };
  return {
    ...base,
    reanchor: { status: "anchored", charStart: 0, charEnd: 5 },
    stale: false,
  };
}

function setup(comment: ResolvedComment) {
  const onSave = vi.fn();
  const onRemove = vi.fn();
  const onSendNow = vi.fn();
  render(
    <CommentCard
      comment={comment}
      onSave={onSave}
      onRemove={onRemove}
      onSendNow={onSendNow}
    />,
  );
  return { onSave, onRemove, onSendNow };
}

describe("CommentCard", () => {
  it("shows status, source location, quote, and note", () => {
    setup(resolved({}));
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("§ 2. Overview · L12")).toBeInTheDocument();
    expect(screen.getByText("the selected passage")).toBeInTheDocument();
    expect(screen.getByText("needs clarification")).toBeInTheDocument();
  });

  it("saves an edited note for a pending comment without changing status", async () => {
    const user = userEvent.setup();
    const { onSave } = setup(resolved({ status: "pending" }));
    await user.click(screen.getByRole("button", { name: /edit/i }));
    const textarea = screen.getByRole("textbox", {
      name: /edit comment note/i,
    });
    await user.clear(textarea);
    await user.type(textarea, "  reworded note  ");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({ note: "reworded note" });
  });

  it("reverts a sent comment to pending when its note text changes", async () => {
    const user = userEvent.setup();
    const { onSave } = setup(
      resolved({ status: "sent", sentAt: "2026-01-02T00:00:00.000Z" }),
    );
    await user.click(screen.getByRole("button", { name: /edit/i }));
    const textarea = screen.getByRole("textbox", {
      name: /edit comment note/i,
    });
    await user.clear(textarea);
    await user.type(textarea, "changed my mind");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({
      note: "changed my mind",
      status: "pending",
    });
  });

  it("keeps a sent comment sent when the note is saved unchanged", async () => {
    const user = userEvent.setup();
    const { onSave } = setup(
      resolved({
        status: "sent",
        note: "keep me",
        sentAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await user.click(screen.getByRole("button", { name: /edit/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({ note: "keep me" });
  });

  it("disables save while the edited note is empty or whitespace", async () => {
    const user = userEvent.setup();
    setup(resolved({}));
    await user.click(screen.getByRole("button", { name: /edit/i }));
    const textarea = screen.getByRole("textbox", {
      name: /edit comment note/i,
    });
    await user.clear(textarea);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    await user.type(textarea, "   ");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("removes the comment", async () => {
    const user = userEvent.setup();
    const { onRemove } = setup(resolved({}));
    await user.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("offers send-now only for pending comments", async () => {
    const user = userEvent.setup();
    const { onSendNow } = setup(resolved({ status: "pending" }));
    await user.click(screen.getByRole("button", { name: /send now/i }));
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it("opens straight into note-editing when initiallyEditing is set", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <CommentCard
        comment={resolved({ status: "pending" })}
        initiallyEditing
        onSave={onSave}
        onRemove={vi.fn()}
        onSendNow={vi.fn()}
      />,
    );
    // The note textarea is present without first clicking an Edit button.
    const textarea = screen.getByRole("textbox", {
      name: /edit comment note/i,
    });
    await user.clear(textarea);
    await user.type(textarea, "edited from the tray");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({ note: "edited from the tray" });
  });

  it("hides send-now for already-sent comments", () => {
    setup(resolved({ status: "sent", sentAt: "2026-01-02T00:00:00.000Z" }));
    expect(
      screen.queryByRole("button", { name: /send now/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a stale comment fully actionable (view, edit, remove, send)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onRemove = vi.fn();
    const onSendNow = vi.fn();
    const stale: ResolvedComment = {
      ...resolved({ status: "pending" }),
      reanchor: { status: "stale" },
      stale: true,
    };
    render(
      <CommentCard
        comment={stale}
        onSave={onSave}
        onRemove={onRemove}
        onSendNow={onSendNow}
      />,
    );
    // Stale indicator + the quoted passage are still shown.
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText("the selected passage")).toBeInTheDocument();
    // Send-now still available (pending), and edit still works.
    await user.click(screen.getByRole("button", { name: /send now/i }));
    expect(onSendNow).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /edit/i }));
    const textarea = screen.getByRole("textbox", {
      name: /edit comment note/i,
    });
    await user.clear(textarea);
    await user.type(textarea, "still editable");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({ note: "still editable" });
  });
});
