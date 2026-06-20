"use client";

import Link from "next/link";
import type { ConversationRefAttrs } from "@/lib/conversations/schemas";
import { conversationsPageHref } from "@/lib/conversations/hrefs";

interface ConversationLinkChipProps {
  attrs: ConversationRefAttrs;
}

export default function ConversationLinkChip({
  attrs,
}: ConversationLinkChipProps): React.JSX.Element {
  const projectName = attrs["project-name"];
  const sessionName = attrs["session-name"];
  const conversationId = attrs["conversation-id"];
  const conversationName = attrs["conversation-name"];
  const backend = attrs["backend"];

  const href = conversationsPageHref({ conversationId });

  const displayLabel =
    conversationName.length > 0 ? conversationName : conversationId;

  return (
    <Link
      href={href}
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised px-[6px] py-[2px] align-baseline font-mono text-[0.78rem] leading-none text-inherit no-underline transition-[border-color,background,box-shadow] duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:shadow-[0_0_0_2px_var(--cyan-glow)] data-[backend=codex]:border-violet-dim"
      title={`${projectName} · ${sessionName}`}
      data-backend={backend}
    >
      <span className="font-semibold text-cyan">#</span>
      <span className="text-text-primary">{displayLabel}</span>
      <span
        className="inline-flex items-center text-text-tertiary"
        aria-hidden="true"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 9 L9 3" />
          <path d="M4 3 L9 3 L9 8" />
        </svg>
      </span>
    </Link>
  );
}
