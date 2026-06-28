"use client";

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import dynamic from "next/dynamic";
import type { ReactNode, Ref } from "react";
import type { PluggableList } from "unified";
import MarkdownLink from "./MarkdownLink";

const MermaidDiagram = dynamic(() => import("./MermaidDiagram"), {
  ssr: false,
});

/**
 * Viewer defaults: links open safely in a new tab and fenced `mermaid` blocks
 * render as diagrams while every other code block stays plain monospace
 * (matching the prototype — no syntax highlighting in the viewer). Callers may
 * pass `components` to add renderers (e.g. the decorative chevron list item);
 * they are merged OVER these defaults, so Mermaid handling survives unless a
 * caller deliberately overrides `code`.
 */
const DEFAULT_COMPONENTS: Components = {
  a: MarkdownLink,
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className || "");
    if (match?.[1] === "mermaid") {
      return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
    }
    return <code className={className}>{children}</code>;
  },
};

interface MarkdownViewerProps {
  /** Raw markdown content to render, or null if not yet loaded */
  content: string | null;
  /** Whether content is currently being fetched */
  isLoading: boolean;
  /** Optional message to show when content is null and not loading */
  emptyMessage?: string;
  /** Optional CSS class for the container */
  className?: string;
  /**
   * Extra/override react-markdown component renderers, merged over the viewer
   * defaults (safe links + Mermaid-aware code). Used to inject the decorative
   * chevron list item for the document viewer.
   */
  components?: Components;
  /**
   * Extra rehype plugins (e.g. source-position stamping) layered after the
   * default pipeline so selections can resolve to a source block.
   */
  rehypePlugins?: PluggableList;
  /**
   * Ref to the rendered-markdown container, used by the annotated renderer to
   * mount the selection/highlight overlay over the exact rendered DOM.
   */
  contentRef?: Ref<HTMLDivElement>;
  /**
   * Extra layer rendered INSIDE the scroll container (after the content), used
   * by the annotated renderer for the left-gutter comment pins so they scroll
   * with the document. Only shown alongside loaded content.
   */
  overlay?: ReactNode;
}

export default function MarkdownViewer({
  content,
  isLoading,
  emptyMessage = "No content available.",
  className,
  components,
  rehypePlugins,
  contentRef,
  overlay,
}: MarkdownViewerProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div
        className={`markdown-viewer relative${className ? ` ${className}` : ""}`}
      >
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
      <div
        className={`markdown-viewer relative${className ? ` ${className}` : ""}`}
      >
        <div className="markdown-viewer-empty">
          <span>{emptyMessage}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`markdown-viewer relative${className ? ` ${className}` : ""}`}
    >
      <div
        ref={contentRef}
        className="markdown-content selection:bg-cyan-glow-strong"
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehypePlugins}
          components={
            components
              ? { ...DEFAULT_COMPONENTS, ...components }
              : DEFAULT_COMPONENTS
          }
        >
          {content}
        </Markdown>
      </div>
      {overlay}
    </div>
  );
}
