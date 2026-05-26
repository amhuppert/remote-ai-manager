"use client";

import Link from "next/link";
import type { ConversationRefAttrs } from "@/lib/conversations/schemas";

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

  const href = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(
    sessionName,
  )}/${encodeURIComponent(conversationId)}`;

  const displayLabel =
    conversationName.length > 0 ? conversationName : conversationId;

  return (
    <Link
      href={href}
      className="conversation-link-chip"
      title={`${projectName} · ${sessionName}`}
      data-backend={backend}
    >
      <span className="conversation-link-chip__hash">#</span>
      <span className="conversation-link-chip__name">{displayLabel}</span>
      <span className="conversation-link-chip__open" aria-hidden="true">
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
