"use client";

import { useState, memo } from "react";
import { cn } from "@/lib/ui/cn";
import { MessageMarkdown } from "@/components/markdown/Markdown";

interface Props {
  /** The model's reasoning summary. Empty when `redacted`. */
  text: string;
  /** Encrypted/opaque reasoning the provider won't reveal — label-only, no body. */
  redacted?: boolean;
  /** Number of hidden reasoning chunks included alongside visible reasoning. */
  redactedCount?: number;
  /** Conversation-level expand/collapse command. Manual per-block toggles remain local. */
  expansionCommand?: ThinkingBlockExpansionCommand;
}

export interface ThinkingBlockExpansionCommand {
  expanded: boolean;
  revision: number;
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
 * answer. Expanded by default to show the (dimmer, italic) reasoning text.
 * A redacted block has no body and no toggle: just a lock-marked label.
 */
export default memo(function ThinkingBlock({
  text,
  redacted = false,
  redactedCount = 0,
  expansionCommand,
}: Props): React.JSX.Element {
  const commandRevision = expansionCommand?.revision ?? null;
  const [expansionState, setExpansionState] = useState(() => ({
    expanded: expansionCommand?.expanded ?? true,
    appliedRevision: commandRevision,
  }));
  const commandPending =
    expansionCommand !== undefined &&
    expansionState.appliedRevision !== expansionCommand.revision;
  const expanded = commandPending
    ? expansionCommand.expanded
    : expansionState.expanded;

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
        onClick={() =>
          setExpansionState((prev) => ({
            expanded: !expanded,
            appliedRevision: commandRevision ?? prev.appliedRevision,
          }))
        }
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
        <div className="pt-sm pb-[2px] font-body text-[0.85rem] leading-[1.66] text-text-secondary italic">
          {text && <MessageMarkdown content={text} />}
          {redactedCount > 0 && (
            <div className="mt-sm flex items-center gap-[7px] font-mono opacity-70">
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
          )}
        </div>
      )}
    </div>
  );
});
