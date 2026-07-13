"use client";

import { DocumentMarkdown } from "@/components/markdown/Markdown";
import MarkdownViewport from "@/components/markdown/MarkdownViewport";
import type { DocumentContentErrorKind } from "@/lib/documents/queries";

export default function ReadOnlyDocumentSurface({
  content,
  isLoading,
  contentError = null,
}: {
  content: string | null;
  isLoading: boolean;
  contentError?: DocumentContentErrorKind | null;
}): React.JSX.Element {
  if (contentError) {
    const message =
      contentError === "invalid"
        ? "This path is not a readable Markdown document."
        : contentError === "unavailable"
          ? "This document can no longer be read."
          : "Could not load this document.";
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-lg text-center font-mono text-[0.78rem] text-text-tertiary">
        {message}
      </div>
    );
  }
  return (
    <MarkdownViewport isLoading={isLoading}>
      {content === null ? null : <DocumentMarkdown content={content} />}
    </MarkdownViewport>
  );
}
