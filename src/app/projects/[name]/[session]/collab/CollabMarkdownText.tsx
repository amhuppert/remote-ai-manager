"use client";

import MarkdownContent from "@/components/MarkdownContent";
import { normalizeCollabMarkdown } from "./text-normalizer";

export interface CollabMarkdownTextProps {
  content: string;
  className?: string;
}

export default function CollabMarkdownText({
  content,
  className,
}: CollabMarkdownTextProps): React.JSX.Element {
  const combined = className
    ? `collab-markdown-text ${className}`
    : "collab-markdown-text";
  return (
    <div className={combined}>
      <MarkdownContent content={normalizeCollabMarkdown(content)} />
    </div>
  );
}
