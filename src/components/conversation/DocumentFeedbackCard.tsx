"use client";

import type { DocumentFeedbackItem } from "@/lib/conversations/message-content-schemas";

interface Props {
  items: DocumentFeedbackItem[];
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

function FileGlyph(): React.JSX.Element {
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
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3" />
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
const PATH_CLASS =
  "mb-[4px] flex items-center gap-[6px] font-mono text-[0.7rem] text-text-secondary";
const LOCATION_CLASS = "mb-[6px] font-mono text-[0.7rem] text-text-tertiary";
// `<div>` not `<blockquote>` so the transcript's `.message-content blockquote`
// rule (border-default left border + wide padding) doesn't override the quote;
// border-x-0/border-y-0 zero the unsized sides (Preflight is off, so a bare
// `border-solid` would otherwise paint a default-width box).
const QUOTE_CLASS =
  "mb-[7px] border-x-0 border-y-0 border-l-2 border-solid border-l-cyan-dim pl-[9px] font-body text-[0.82rem] italic leading-[1.5] text-text-secondary";
const NOTE_ROW_CLASS = "flex items-start gap-[7px]";
const NOTE_CLASS = "text-[0.86rem] leading-[1.5] text-text-primary";

/**
 * Transcript renderer for a `document_feedback` content block. Lists every
 * feedback item the user delivered — its source file path, section heading and
 * line, the exact quoted passage, and the note (Requirement 8.2). Styled to
 * match the design prototype's "Document feedback" card.
 */
export default function DocumentFeedbackCard({
  items,
}: Props): React.JSX.Element {
  const label = `Document feedback · ${items.length} location${items.length === 1 ? "" : "s"}`;
  return (
    <div className={CARD_CLASS} data-testid="document-feedback-card">
      <div className={HEADER_CLASS}>
        <span className="text-cyan">
          <BubbleGlyph />
        </span>
        {label}
      </div>
      <div role="list" className={LIST_CLASS}>
        {items.map((item, i) => (
          <div key={i} role="listitem" className={ITEM_CLASS}>
            <div className={PATH_CLASS}>
              <span className="text-text-tertiary">
                <FileGlyph />
              </span>
              {item.path}
            </div>
            <div className={LOCATION_CLASS}>
              § {item.headingLabel} · L{item.line}
            </div>
            <div className={QUOTE_CLASS}>
              {"“"}
              {item.quote}
              {"”"}
            </div>
            <div className={NOTE_ROW_CLASS}>
              <span
                aria-hidden="true"
                className="font-bold leading-[1.5] text-cyan"
              >
                {"›"}
              </span>
              <span className={NOTE_CLASS}>{item.note}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
