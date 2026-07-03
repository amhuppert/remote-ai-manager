"use client";

import type { QuestionAnswersBlock } from "@/lib/conversations/question-answers-block";

interface Props {
  block: QuestionAnswersBlock;
}

function CheckGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="shrink-0"
    >
      <path d="M2.5 8.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

const CARD_CLASS =
  "my-md rounded-md border border-solid border-border-default bg-bg-raised px-[13px] py-[12px]";
const HEADER_CLASS =
  "mb-[9px] flex items-center gap-[7px] font-mono text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-[var(--amber)]";
const LIST_CLASS = "flex flex-col";
const ITEM_CLASS =
  "mt-[10px] border-x-0 border-b-0 border-t border-solid border-border-subtle pt-[10px] first:mt-0 first:border-t-0 first:pt-0";
const QUESTION_CLASS = "mb-[4px] font-mono text-[0.7rem] text-text-tertiary";
const SELECTION_ROW_CLASS =
  "flex items-start gap-[7px] text-[0.86rem] leading-[1.5] text-text-primary";
const SKIPPED_CLASS = "text-[0.82rem] leading-[1.5] italic text-text-tertiary";
// `<div>` not `<blockquote>`: same transcript-blockquote-override rationale as
// DocumentFeedbackCard's quote; border-x/y zeroed because Preflight is off.
const NOTE_CLASS =
  "mt-[5px] border-x-0 border-y-0 border-l-2 border-solid border-l-[var(--amber)] pl-[9px] font-body text-[0.82rem] italic leading-[1.5] text-text-secondary";

/**
 * Transcript renderer for the `<cc-question-answers>` block the answer route
 * enqueues as the next user message after a `cctl ask`. Shows each answered
 * question with its selection(s) and free-text note; a skipped question is
 * marked declined so the reader knows the agent proceeded on its own judgment.
 */
export default function QuestionAnswersCard({
  block,
}: Props): React.JSX.Element {
  const entries = Object.entries(block.answers);
  const label = `Question answers · ${entries.length} question${entries.length === 1 ? "" : "s"}`;
  return (
    <div className={CARD_CLASS} data-testid="question-answers-card">
      <div className={HEADER_CLASS}>
        <CheckGlyph />
        {label}
      </div>
      <div role="list" className={LIST_CLASS}>
        {entries.map(([id, answer]) => (
          <div key={id} role="listitem" className={ITEM_CLASS}>
            <div className={QUESTION_CLASS}>{answer.question ?? id}</div>
            {answer.skipped ? (
              <div className={SKIPPED_CLASS}>
                skipped — proceed with best judgment
              </div>
            ) : (
              <div className={SELECTION_ROW_CLASS}>
                <span
                  aria-hidden="true"
                  className="font-bold leading-[1.5] text-[var(--amber)]"
                >
                  {"›"}
                </span>
                <span>{answer.selected.join(", ")}</span>
              </div>
            )}
            {answer.note && <div className={NOTE_CLASS}>{answer.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
