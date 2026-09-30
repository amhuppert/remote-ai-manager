"use client";

import { MessageMarkdown } from "@/components/markdown/Markdown";

/** Keep Markdown flow intact while its renderer replaces wire references. */
export function MessageTextWithRefs({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return <MessageMarkdown content={text} />;
}
