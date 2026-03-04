"use client";

import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import MermaidDiagram from "./MermaidDiagram";

interface Props {
  content: string;
}

/**
 * Rehype plugin that wraps occurrences of "ultrathink" in text nodes
 * with <span class="ultrathink-rainbow"> for rainbow gradient styling.
 */
type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function rehypeUltrathink() {
  return (tree: HastNode) => {
    function visit(node: HastNode) {
      if (!node.children) return;
      const newChildren: HastNode[] = [];
      for (const child of node.children) {
        if (
          child.type === "text" &&
          child.value &&
          /ultrathink/i.test(child.value)
        ) {
          const parts = child.value.split(/(ultrathink)/i);
          for (const part of parts) {
            if (!part) continue;
            if (/^ultrathink$/i.test(part)) {
              newChildren.push({
                type: "element",
                tagName: "span",
                properties: { className: ["ultrathink-rainbow"] },
                children: [{ type: "text", value: part }],
              });
            } else {
              newChildren.push({ type: "text", value: part });
            }
          }
        } else {
          visit(child);
          newChildren.push(child);
        }
      }
      node.children = newChildren;
    }
    visit(tree);
  };
}

const customStyle: Record<string, React.CSSProperties> = {
  ...atomDark,
  'pre[class*="language-"]': {
    ...(atomDark['pre[class*="language-"]'] as React.CSSProperties),
    background: "var(--bg-base)",
    margin: 0,
    padding: "var(--space-md)",
    borderRadius: "var(--radius-md)",
    fontSize: "0.8rem",
    lineHeight: 1.55,
  },
  'code[class*="language-"]': {
    ...(atomDark['code[class*="language-"]'] as React.CSSProperties),
    background: "none",
    fontSize: "0.8rem",
    lineHeight: 1.55,
  },
};

function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [code],
  );

  return (
    <button
      className={`code-block-copy-btn${copied ? " code-block-copy-btn--copied" : ""}`}
      onClick={handleCopy}
      title="Copy code"
    >
      {copied ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1.5 5.5L4 8L8.5 2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="4"
            y="3"
            width="6"
            height="7.5"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M2 8.5V2.5C2 1.95 2.45 1.5 3 1.5H7.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

export default memo(function MarkdownContent({
  content,
}: Props): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeUltrathink]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const codeString = String(children).replace(/\n$/, "");

          if (match) {
            if (match[1] === "mermaid") {
              return <MermaidDiagram code={codeString} />;
            }

            return (
              <div className="code-block-wrapper">
                <SyntaxHighlighter
                  style={customStyle}
                  language={match[1]}
                  PreTag="div"
                >
                  {codeString}
                </SyntaxHighlighter>
                <CodeBlockCopyButton code={codeString} />
              </div>
            );
          }

          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
