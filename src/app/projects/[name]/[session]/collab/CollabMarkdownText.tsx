"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { normalizeCollabMarkdown } from "./text-normalizer";

const LazyMarkdownContent = dynamic(
  () => import("@/components/MarkdownContent"),
  {
    ssr: false,
  },
);

function MarkdownContent({ content }: { content: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void import("@/components/MarkdownContent").then(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!loaded) {
    return <pre className="markdown-loading">{content}</pre>;
  }
  return <LazyMarkdownContent content={content} />;
}

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
