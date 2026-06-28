"use client";

import { useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import type { CommentStatus } from "@/lib/document-comments/schemas";
import type { ResolvedComment } from "./types";

/** A note/status update emitted on save. `status` is set only when the edit
 *  reverts an already-sent comment to pending (6.5). */
export interface CommentCardSave {
  note: string;
  status?: CommentStatus;
}

interface CommentCardProps {
  comment: ResolvedComment;
  /** Persist a note edit (and the sent→pending revert when applicable). */
  onSave: (update: CommentCardSave) => void;
  /** Delete the comment (6.6). */
  onRemove: () => void;
  /** Send this single pending comment now (6.7); shown only while pending. */
  onSendNow: () => void;
  /** Dismiss the card. */
  onClose?: () => void;
  /** Open straight into note-editing — used when the card is reached via an
   *  explicit "Edit" affordance (e.g. the pending tray, the only card entry
   *  point for a stale comment, 11.5). Defaults to view mode. */
  initiallyEditing?: boolean;
}

/** Human-facing source location: `§ <heading> · L<line>`, or just the line when
 *  the block precedes any heading. */
function formatLocation(headingLabel: string, line: number): string {
  return headingLabel ? `§ ${headingLabel} · L${line}` : `L${line}`;
}

const statusChip: Record<CommentStatus, string> = {
  pending: "bg-cyan-glow text-cyan border-cyan/50",
  sent: "bg-green-glow text-green border-green/50",
};

/**
 * View and manage a single comment: status, source location, quoted passage,
 * and note (6.3), with edit, remove, and send-now actions. Editing the note of
 * an already-sent comment reverts it to pending (6.5). Every action stays
 * available for a stale comment — it is still fully viewable/editable/removable/
 * sendable (11.5) — only the in-document highlight is missing.
 */
export default function CommentCard({
  comment,
  onSave,
  onRemove,
  onSendNow,
  onClose,
  initiallyEditing = false,
}: CommentCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(initiallyEditing);
  const [draft, setDraft] = useState(comment.note);

  const startEditing = (): void => {
    setDraft(comment.note);
    setEditing(true);
  };

  const cancelEditing = (): void => {
    setDraft(comment.note);
    setEditing(false);
  };

  const save = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    const changed = trimmed !== comment.note;
    // A sent comment whose text actually changed returns to pending (6.5).
    const status: CommentStatus | undefined =
      comment.status === "sent" && changed ? "pending" : undefined;
    onSave(status ? { note: trimmed, status } : { note: trimmed });
    setEditing(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (editing) {
        cancelEditing();
      } else {
        onClose?.();
      }
    }
  };

  const canSave = draft.trim().length > 0;

  return (
    <div
      onKeyDown={handleKeyDown}
      className="flex w-[320px] flex-col gap-sm rounded-md border border-solid border-border-default bg-bg-elevated p-[12px] shadow-menu"
    >
      <div className="flex items-center gap-[6px]">
        <span
          className={cn(
            "inline-flex items-center rounded-full border border-solid px-[8px] py-[2px] font-mono text-[0.62rem] font-semibold uppercase tracking-wide",
            statusChip[comment.status],
          )}
        >
          {comment.status === "sent" ? "Sent" : "Pending"}
        </span>
        {comment.stale ? (
          <span className="inline-flex items-center rounded-full border border-solid border-amber/50 bg-amber-glow px-[8px] py-[2px] font-mono text-[0.62rem] font-semibold uppercase tracking-wide text-amber">
            Stale
          </span>
        ) : null}
        <span className="ml-auto truncate font-mono text-[0.66rem] text-text-tertiary">
          {formatLocation(comment.anchor.headingLabel, comment.anchor.line)}
        </span>
      </div>

      <blockquote className="m-0 max-h-[88px] overflow-y-auto overscroll-contain border-x-0 border-y-0 border-l-2 border-solid border-l-cyan bg-bg-raised px-[10px] py-[6px] font-body text-[0.8rem] leading-[1.5] text-text-secondary">
        {comment.anchor.quote}
      </blockquote>

      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Edit comment note"
          rows={3}
          className="w-full resize-none rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[6px] font-body text-[0.8rem] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-1px]"
        />
      ) : (
        <p className="m-0 font-body text-[0.8rem] leading-[1.5] whitespace-pre-wrap text-text-primary">
          {comment.note}
        </p>
      )}

      <div className="flex items-center justify-end gap-sm">
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={cancelEditing}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={!canSave}
              onClick={save}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" type="button" onClick={onRemove}>
              Remove
            </Button>
            <Button
              variant="default"
              size="sm"
              type="button"
              onClick={startEditing}
            >
              Edit
            </Button>
            {comment.status === "pending" ? (
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={onSendNow}
              >
                Send now
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
