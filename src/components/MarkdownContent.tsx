"use client";

import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Props {
  content: string;
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

export default function MarkdownContent({ content }: Props): React.JSX.Element {
  return (
    <ReactMarkdown
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const codeString = String(children).replace(/\n$/, "");

          if (match) {
            return (
              <SyntaxHighlighter
                style={customStyle}
                language={match[1]}
                PreTag="div"
              >
                {codeString}
              </SyntaxHighlighter>
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
}
