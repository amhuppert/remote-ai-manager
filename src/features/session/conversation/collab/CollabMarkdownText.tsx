"use client";

import { CompactMarkdown } from "@/components/markdown/Markdown";
import { normalizeCollabMarkdown } from "@/features/session/conversation/collab/text-normalizer";

export interface CollabMarkdownTextProps {
  content: string;
  className?: string;
}

// Collaboration narrative text: decode the double-encoded escape subset agents
// occasionally emit, then render through the canonical compact adapter. The
// card owns the outer placement/layout via `className`; typography and spacing
// of the generated Markdown come solely from the canonical module.
export default function CollabMarkdownText({
  content,
  className,
}: CollabMarkdownTextProps): React.JSX.Element {
  return (
    <div className={className}>
      <CompactMarkdown content={normalizeCollabMarkdown(content)} />
    </div>
  );
}
