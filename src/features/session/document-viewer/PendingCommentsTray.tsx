"use client";

import { Button } from "@/components/ui/Button";
import type { ResolvedComment } from "./types";

interface PendingCommentsTrayProps {
  /** The viewer's pending (unsent) comments. The tray is hidden when empty. */
  pendingComments: ResolvedComment[];
  /** Whether the per-comment list is expanded. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Activate the comment's passage: scroll it into view and focus it (7.3). */
  onJump: (commentId: string) => void;
  /** Open the comment's card for editing — the only card entry point for a
   *  stale comment, which has no in-document highlight/gutter pin (11.5). */
  onOpen: (commentId: string) => void;
  /** Remove a single pending comment. */
  onRemove: (commentId: string) => void;
  /** Remove ALL pending comments (sent comments are untouched — 7.5). */
  onClear: () => void;
  /** Send every pending comment as one feedback submission (7.4, wired upstream). */
  onSendAll: () => void;
}

function formatLocation(headingLabel: string, line: number): string {
  return headingLabel ? `§ ${headingLabel} · L${line}` : `L${line}`;
}

function BubbleGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="shrink-0"
    >
      <path d="M2 3h12v7.5H6.5L3.5 13v-2.5H2z" />
    </svg>
  );
}

function PencilGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="shrink-0"
    >
      <path d="M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3z" />
    </svg>
  );
}

/**
 * The pending-comments tray at the foot of the viewer. It appears only while one
 * or more pending comments exist (7.1, 7.6) and shows the pending count in a
 * cyan badge. Expanding it lists each pending comment with a jump-to-passage
 * affordance, its location, quoted passage, and note (7.2, 7.3), a per-row edit
 * (opens the comment card — the only way to reach a stale comment's card, 11.5),
 * and a per-row remove. The footer exposes Clear (removes only pending comments
 * — 7.5) and a bulk Send action (7.4); the actual send is wired by the viewer to
 * the send orchestration. Styled to match the design prototype.
 */
export default function PendingCommentsTray({
  pendingComments,
  expanded,
  onToggleExpanded,
  onJump,
  onOpen,
  onRemove,
  onClear,
  onSendAll,
}: PendingCommentsTrayProps): React.JSX.Element | null {
  const count = pendingComments.length;
  if (count === 0) return null;

  return (
    <section aria-label="Pending comments" className="flex min-h-0 flex-col">
      <div className="flex items-center gap-[10px] px-[14px] py-[10px]">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={`${count} pending comment${count === 1 ? "" : "s"} to send`}
          className="inline-flex cursor-pointer items-center gap-[9px] border-none bg-transparent p-0 text-text-primary"
        >
          <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[7px] bg-cyan px-[6px] font-mono text-[0.74rem] font-bold text-bg-void">
            {count}
          </span>
          <span className="font-body text-[0.82rem] font-semibold">
            pending comment{count === 1 ? "" : "s"} to send
          </span>
          <span aria-hidden="true" className="text-[0.8rem] text-text-tertiary">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        <div className="ml-auto flex items-center gap-sm">
          <Button variant="ghost" size="sm" type="button" onClick={onClear}>
            Clear
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={onSendAll}>
            Send {count} to agent →
          </Button>
        </div>
      </div>

      {expanded ? (
        <ul className="m-0 flex max-h-[210px] min-h-0 list-none flex-col gap-[8px] overflow-y-auto px-[14px] pb-[12px]">
          {pendingComments.map((comment) => (
            <li
              key={comment.id}
              className="flex items-start gap-[9px] rounded-md border border-solid border-border-default bg-bg-surface px-[10px] py-[9px]"
            >
              {/* A stale comment has no in-document passage to scroll to, so
                  Jump is meaningful only for an anchored comment. */}
              {comment.stale ? null : (
                <button
                  type="button"
                  onClick={() => onJump(comment.id)}
                  title="Jump to passage"
                  aria-label="Jump to passage"
                  className="mt-[1px] inline-flex h-[18px] shrink-0 cursor-pointer items-center rounded-[5px] border border-solid border-cyan bg-cyan-glow px-[5px] text-cyan"
                >
                  <BubbleGlyph />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className="mb-[3px] flex items-center gap-sm font-mono text-[0.66rem] text-text-tertiary">
                  <span className="truncate">
                    {formatLocation(
                      comment.anchor.headingLabel,
                      comment.anchor.line,
                    )}
                  </span>
                  {comment.stale ? (
                    <span className="inline-flex items-center rounded-full border border-solid border-amber/50 bg-amber-glow px-[7px] py-px font-mono text-[0.58rem] font-semibold uppercase text-amber">
                      Stale
                    </span>
                  ) : null}
                </div>
                <div className="mb-[4px] truncate font-body text-[0.76rem] italic text-text-secondary">
                  {"“"}
                  {comment.anchor.quote}
                  {"”"}
                </div>
                <div className="font-body text-[0.82rem] leading-[1.45] whitespace-pre-wrap text-text-primary">
                  {comment.note}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-[1px]">
                <button
                  type="button"
                  onClick={() => onOpen(comment.id)}
                  title="Edit comment"
                  aria-label="Edit comment"
                  className="inline-flex h-[24px] w-[24px] cursor-pointer items-center justify-center rounded-[5px] border-none bg-transparent text-text-tertiary hover:text-text-primary"
                >
                  <PencilGlyph />
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(comment.id)}
                  title="Remove comment"
                  aria-label="Remove comment"
                  className="inline-flex h-[24px] w-[24px] cursor-pointer items-center justify-center rounded-[5px] border-none bg-transparent font-body text-[1.05rem] leading-none text-text-tertiary hover:text-text-primary"
                >
                  {"×"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
