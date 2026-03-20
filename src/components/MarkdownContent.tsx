"use client";

import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import MermaidDiagram from "./MermaidDiagram";
import { KiroCommandButton } from "./KiroCommandButton";
import { KIRO_COMMAND_RE, parseKiroCommand } from "@/lib/kiro-commands";

interface Props {
  content: string;
}

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * Rehype plugin that detects /kiro:* commands in text nodes
 * and wraps them with <span data-kiro-cmd="..."> for the custom
 * span component to render KiroCommandButton.
 */
function rehypeKiroCommands() {
  return (tree: HastNode) => {
    function visit(node: HastNode) {
      if (!node.children) return;

      // Skip <code> elements — inline code is handled by the custom code component
      if (node.tagName === "code") return;

      const newChildren: HastNode[] = [];
      for (const child of node.children) {
        if (
          child.type === "text" &&
          child.value &&
          new RegExp(KIRO_COMMAND_RE.source).test(child.value)
        ) {
          const re = new RegExp(KIRO_COMMAND_RE.source, "g");
          let lastIndex = 0;
          let match: RegExpExecArray | null;

          while ((match = re.exec(child.value)) !== null) {
            // Text before match
            if (match.index > lastIndex) {
              newChildren.push({
                type: "text",
                value: child.value.slice(lastIndex, match.index),
              });
            }

            const commandSuffix = match[1]!;
            const commandName = `/kiro:${commandSuffix}`;

            newChildren.push({
              type: "element",
              tagName: "span",
              properties: {
                "data-kiro-cmd": commandName,
                "data-kiro-args": "",
              },
              children: [{ type: "text", value: match[0]! }],
            });

            lastIndex = match.index + match[0]!.length;
          }

          // Text after last match
          if (lastIndex < child.value.length) {
            newChildren.push({
              type: "text",
              value: child.value.slice(lastIndex),
            });
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
      rehypePlugins={[rehypeKiroCommands]}
      components={{
        code({ className, children, ...props }) {
          const rawText = String(children);
          const codeString = rawText.replace(/\n$/, "");
          const match = /language-(\w+)/.exec(className || "");

          // Fenced code blocks: have a language class OR trailing newline
          // (react-markdown adds trailing \n to fenced block content)
          if (match || rawText.endsWith("\n")) {
            if (match?.[1] === "mermaid") {
              return <MermaidDiagram code={codeString} />;
            }

            return (
              <div className="code-block-wrapper">
                <SyntaxHighlighter
                  style={customStyle}
                  language={match?.[1] ?? "text"}
                  PreTag="div"
                >
                  {codeString}
                </SyntaxHighlighter>
                <CodeBlockCopyButton code={codeString} />
              </div>
            );
          }

          // Inline code: check if it's a Kiro command
          const parsed = parseKiroCommand(codeString);
          if (parsed) {
            return (
              <KiroCommandButton
                commandName={parsed.commandName}
                args={parsed.args}
              >
                <code className={className} {...props}>
                  {children}
                </code>
              </KiroCommandButton>
            );
          }

          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
        // Custom span: render KiroCommandButton for rehype-tagged spans
        span({ children, node: _node, ...props }) {
          const cmd = (props as Record<string, unknown>)["data-kiro-cmd"];
          if (typeof cmd === "string") {
            const args = (props as Record<string, unknown>)["data-kiro-args"];
            return (
              <KiroCommandButton
                commandName={cmd}
                args={typeof args === "string" && args ? args : null}
              >
                {children}
              </KiroCommandButton>
            );
          }
          return <span {...props}>{children}</span>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
