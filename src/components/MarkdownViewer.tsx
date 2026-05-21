"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import dynamic from "next/dynamic";

const MermaidDiagram = dynamic(() => import("./MermaidDiagram"), {
  ssr: false,
});

interface MarkdownViewerProps {
  /** Raw markdown content to render, or null if not yet loaded */
  content: string | null;
  /** Whether content is currently being fetched */
  isLoading: boolean;
  /** Optional message to show when content is null and not loading */
  emptyMessage?: string;
  /** Optional CSS class for the container */
  className?: string;
}

export default function MarkdownViewer({
  content,
  isLoading,
  emptyMessage = "No content available.",
  className,
}: MarkdownViewerProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className={`markdown-viewer${className ? ` ${className}` : ""}`}>
        <div className="markdown-viewer-empty">
          <div
            className="spinner"
            style={{
              borderColor: "rgba(0, 229, 255, 0.3)",
              borderTopColor: "var(--cyan)",
              width: 24,
              height: 24,
            }}
          />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className={`markdown-viewer${className ? ` ${className}` : ""}`}>
        <div className="markdown-viewer-empty">
          <span>{emptyMessage}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`markdown-viewer${className ? ` ${className}` : ""}`}>
      <div className="markdown-content">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children }) {
              const match = /language-(\w+)/.exec(className || "");
              if (match?.[1] === "mermaid") {
                return (
                  <MermaidDiagram code={String(children).replace(/\n$/, "")} />
                );
              }
              return <code className={className}>{children}</code>;
            },
          }}
        >
          {content}
        </Markdown>
      </div>
    </div>
  );
}
