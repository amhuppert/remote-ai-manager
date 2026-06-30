"use client";

import { useState, memo } from "react";
import { cn } from "@/lib/ui/cn";
import LazyMarkdownContent from "./LazyMarkdownContent";

// Markdown styling for the reasoning body, scoped to this aside so it reads as
// the dimmer "inner voice" (italic body prose, secondary color) rather than the
// primary answer. Block spacing is restored explicitly because the base reset
// zeroes all margins/padding. Inline code follows the design's code-span spec;
// the `[&_pre_code]` resets undo that pill treatment inside fenced blocks.
const THINKING_MARKDOWN = cn(
  "[&_p]:m-0 [&_p+p]:mt-[0.6em]",
  "[&_ul]:my-[0.5em] [&_ul]:list-disc [&_ul]:pl-[1.3em] [&_ol]:my-[0.5em] [&_ol]:list-decimal [&_ol]:pl-[1.3em] [&_li]:mt-[0.2em] [&_li]:marker:text-text-tertiary",
  "[&_strong]:font-semibold [&_strong]:text-text-primary",
  "[&_a]:text-cyan-dim hover:[&_a]:underline",
  "[&_code]:rounded-sm [&_code]:border [&_code]:border-border-subtle [&_code]:bg-bg-surface [&_code]:px-[5px] [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.82em] [&_code]:not-italic [&_code]:text-cyan-dim",
  "[&_pre]:my-[0.5em] [&_pre]:not-italic [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit",
);

interface Props {
  /** The model's reasoning summary. Empty when `redacted`. */
  text: string;
  /** Encrypted/opaque reasoning the provider won't reveal — label-only, no body. */
  redacted?: boolean;
}

function LinesIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 5h10M3 8.4h8M3 11.8h5" />
    </svg>
  );
}

function LockIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="3.5" y="7" width="9" height="6.4" rx="1.3" />
      <path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7" />
    </svg>
  );
}

/**
 * The agent's reasoning, surfaced as a recessed "inner voice" aside — a
 * hairline left-guide rather than a boxed card, so it never competes with the
 * answer. Collapsed by default; expands to the (dimmer, italic) reasoning text.
 * A redacted block has no body and no toggle: just a lock-marked label.
 */
export default memo(function ThinkingBlock({
  text,
  redacted = false,
}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  if (redacted) {
    return (
      <div className="my-sm flex items-center gap-[7px] border-y-0 border-r-0 border-l border-dashed border-border-strong py-[2px] pl-[13px] font-mono opacity-70">
        <span className="inline-flex shrink-0 text-text-tertiary">
          <LockIcon />
        </span>
        <span className="shrink-0 text-[0.74rem] font-medium text-text-secondary italic">
          Internal reasoning
        </span>
        <span className="shrink-0 text-[0.72rem] text-text-tertiary">
          {"— hidden"}
        </span>
      </div>
    );
  }

  return (
    <div className="my-sm border-y-0 border-r-0 border-l border-solid border-border-default pl-[13px]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full cursor-pointer items-center gap-[7px] border-none bg-transparent py-[2px] font-mono text-text-tertiary transition-colors duration-150 ease-[ease] hover:text-text-secondary"
      >
        <span className="inline-flex shrink-0 text-text-secondary">
          <LinesIcon />
        </span>
        <span className="shrink-0 text-[0.74rem] font-medium text-text-secondary italic">
          Thinking
        </span>
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 text-text-tertiary transition-transform duration-300 ease-[ease]",
            expanded && "rotate-180",
          )}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </button>
      {expanded && (
        <div
          className={cn(
            "pt-sm pb-[2px] font-body text-[0.85rem] leading-[1.66] text-text-secondary italic",
            THINKING_MARKDOWN,
          )}
        >
          <LazyMarkdownContent content={text} />
        </div>
      )}
    </div>
  );
});
