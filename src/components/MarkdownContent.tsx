"use client";

import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import shellSession from "react-syntax-highlighter/dist/esm/languages/prism/shell-session";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import MermaidDiagram from "./MermaidDiagram";

// Languages registered for syntax highlighting. Names include common aliases
// (e.g. "ts" → typescript, "sh" → bash) so most fenced code blocks tokenize
// correctly. Unregistered languages fall back to plain text.
const REGISTERED_LANGUAGES: Record<string, unknown> = {
  bash,
  sh: bash,
  shell: bash,
  "shell-session": shellSession,
  c,
  cpp,
  "c++": cpp,
  css,
  diff,
  docker,
  dockerfile: docker,
  go,
  ini,
  java,
  javascript,
  js: javascript,
  json,
  jsx,
  markdown,
  md: markdown,
  html: markup,
  xml: markup,
  markup,
  python,
  py: python,
  rust,
  rs: rust,
  sql,
  toml,
  tsx,
  typescript,
  ts: typescript,
  yaml,
  yml: yaml,
};

for (const [name, lang] of Object.entries(REGISTERED_LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, lang);
}

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
