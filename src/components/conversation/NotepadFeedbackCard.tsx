"use client";

import type { NotepadFeedbackItem } from "@/lib/conversations/message-content-schemas";

interface Props {
  notepadName: string;
  items: NotepadFeedbackItem[];
}

function BubbleGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
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

function NotepadGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="shrink-0"
    >
      <path d="M4 1.5h8.5v13H4z" />
      <path d="M4 4.5H2M4 8H2M4 11.5H2" />
    </svg>
  );
}

const CARD_CLASS =
  "my-md rounded-md border border-solid border-border-default bg-bg-raised px-[13px] py-[12px]";
const HEADER_CLASS =
  "mb-[9px] flex items-center gap-[7px] font-mono text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-cyan-dim";
const LIST_CLASS = "flex flex-col";
const ITEM_CLASS =
  "mt-[10px] border-x-0 border-b-0 border-t border-solid border-border-subtle pt-[10px] first:mt-0 first:border-t-0 first:pt-0";
const NAME_CLASS =
  "mb-[8px] flex items-center gap-[6px] font-mono text-[0.7rem] text-text-secondary";
const LOCATION_CLASS = "mb-[6px] font-mono text-[0.7rem] text-text-tertiary";
// `<div>` not `<blockquote>` for the same reason DocumentFeedbackCard uses one:
// the transcript's `.message-content blockquote` rule would override the quote.
const QUOTE_CLASS =
  "mb-[7px] border-x-0 border-y-0 border-l-2 border-solid border-l-cyan-dim pl-[9px] font-body text-[0.82rem] italic leading-[1.5] text-text-secondary";
const BODY_ROW_CLASS = "flex items-start gap-[7px]";
const BODY_CLASS = "text-[0.86rem] leading-[1.5] text-text-primary";

/**
 * Transcript renderer for a `notepad_feedback` block: the user-visible record
 * of dispatching a notepad's open review comments to this conversation. The
 * notepad is named once above the list — one dispatch addresses one notepad —
 * and each comment shows where it sits, what it quotes, and what it says.
 *
 * The block's `notepadRefXml` is deliberately not rendered: it is the agent's
 * retrieval handle, delivered in the prompt prose, not something the reader of
 * the transcript needs to see.
 */
export default function NotepadFeedbackCard({
  notepadName,
  items,
}: Props): React.JSX.Element {
  const label = `Notepad comments · ${items.length} comment${items.length === 1 ? "" : "s"}`;
  return (
    <div className={CARD_CLASS} data-testid="notepad-feedback-card">
      <div className={HEADER_CLASS}>
        <span className="text-cyan">
          <BubbleGlyph />
        </span>
        {label}
      </div>
      <div className={NAME_CLASS}>
        <span className="text-text-tertiary">
          <NotepadGlyph />
        </span>
        {notepadName}
      </div>
      <div role="list" className={LIST_CLASS}>
        {items.map((item) => (
          <div key={item.commentId} role="listitem" className={ITEM_CLASS}>
            <div className={LOCATION_CLASS}>{item.location}</div>
            <div className={QUOTE_CLASS}>
              {"“"}
              {item.quote}
              {"”"}
            </div>
            <div className={BODY_ROW_CLASS}>
              <span
                aria-hidden="true"
                className="font-bold leading-[1.5] text-cyan"
              >
                {"›"}
              </span>
              <span className={BODY_CLASS}>{item.body}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
