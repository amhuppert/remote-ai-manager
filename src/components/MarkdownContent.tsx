"use client";

import { memo, useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import dynamic from "next/dynamic";

const MermaidDiagram = dynamic(() => import("./MermaidDiagram"), {
  ssr: false,
});

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  c: () => import("react-syntax-highlighter/dist/esm/languages/prism/c"),
  cpp: () => import("react-syntax-highlighter/dist/esm/languages/prism/cpp"),
  css: () => import("react-syntax-highlighter/dist/esm/languages/prism/css"),
  diff: () => import("react-syntax-highlighter/dist/esm/languages/prism/diff"),
  docker: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/docker"),
  go: () => import("react-syntax-highlighter/dist/esm/languages/prism/go"),
  ini: () => import("react-syntax-highlighter/dist/esm/languages/prism/ini"),
  java: () => import("react-syntax-highlighter/dist/esm/languages/prism/java"),
  javascript: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
  json: () => import("react-syntax-highlighter/dist/esm/languages/prism/json"),
  jsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
  markdown: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
  markup: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
  python: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/python"),
  rust: () => import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
  shellSession: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/shell-session"),
  sql: () => import("react-syntax-highlighter/dist/esm/languages/prism/sql"),
  toml: () => import("react-syntax-highlighter/dist/esm/languages/prism/toml"),
  tsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
  typescript: () =>
    import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
  yaml: () => import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  "shell-session": "shellSession",
  "c++": "cpp",
  dockerfile: "docker",
  js: "javascript",
  md: "markdown",
  html: "markup",
  xml: "markup",
  py: "python",
  rs: "rust",
  ts: "typescript",
  yml: "yaml",
};

const registeredLanguages = new Set<string>();

// Refractor language modules self-register under their own internal name,
// which can differ from the LANGUAGE_LOADERS key (e.g. shellSession → shell-session).
// Map canonical loader keys to the names refractor/SyntaxHighlighter recognize.
const HIGHLIGHTER_NAMES: Record<string, string> = {
  shellSession: "shell-session",
};

function resolveLanguage(name: string): string {
  return LANGUAGE_ALIASES[name] ?? name;
}

function highlighterName(canonical: string): string {
  return HIGHLIGHTER_NAMES[canonical] ?? canonical;
}

async function ensureLanguageRegistered(name: string): Promise<boolean> {
  const canonical = resolveLanguage(name);
  if (registeredLanguages.has(canonical)) return true;
  const loader = LANGUAGE_LOADERS[canonical];
  if (!loader) return false;
  const mod = await loader();
  SyntaxHighlighter.registerLanguage(highlighterName(canonical), mod.default);
  registeredLanguages.add(canonical);
  return true;
}

let stylePromise: Promise<Record<string, React.CSSProperties>> | null = null;

function loadStyle(): Promise<Record<string, React.CSSProperties>> {
  if (stylePromise) return stylePromise;
  stylePromise = import("react-syntax-highlighter/dist/esm/styles/prism").then(
    (mod) => {
      const atomDark = mod.atomDark as Record<string, React.CSSProperties>;
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
      return customStyle;
    },
  );
  return stylePromise;
}

interface Props {
  content: string;
}

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

function CodeBlockInner({
  code,
  lang,
}: {
  code: string;
  lang: string | undefined;
}): React.JSX.Element {
  const [style, setStyle] = useState<Record<
    string,
    React.CSSProperties
  > | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureLanguageRegistered(lang ?? "text");
      const s = await loadStyle();
      if (!cancelled) {
        setStyle(s);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lang]);

  if (!ready || !style) {
    return (
      <div className="code-block-wrapper">
        <pre>
          <code>{code}</code>
        </pre>
        <CodeBlockCopyButton code={code} />
      </div>
    );
  }

  const canonical = lang ? resolveLanguage(lang) : "text";
  const languageName = highlighterName(canonical);

  return (
    <div className="code-block-wrapper">
      <SyntaxHighlighter style={style} language={languageName} PreTag="div">
        {code}
      </SyntaxHighlighter>
      <CodeBlockCopyButton code={code} />
    </div>
  );
}

function MarkdownContent({ content }: Props): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const rawText = String(children);
          const codeString = rawText.replace(/\n$/, "");
          const match = /language-([^\s]+)/.exec(className || "");

          // Fenced code blocks: have a language class OR trailing newline
          // (react-markdown adds trailing \n to fenced block content)
          if (match || rawText.endsWith("\n")) {
            if (match?.[1] === "mermaid") {
              return <MermaidDiagram code={codeString} />;
            }

            return <CodeBlockInner code={codeString} lang={match?.[1]} />;
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

export default memo(MarkdownContent);
