"use client";

import dynamic from "next/dynamic";
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Element, Nodes } from "hast";
import MarkdownLink from "./MarkdownLink";
import { cn } from "@/lib/ui/cn";
import { DIFF_KIND_PROPERTY, rehypeDiffMarks } from "./markdown-diff";
import {
  CC_HEADING_ATTR,
  CC_LINE_ATTR,
  CC_SECTION_ATTR,
  rehypeStampSourcePosition,
} from "./markdown-source-map";

const MermaidDiagram = dynamic(() => import("./MermaidDiagram"), {
  ssr: false,
});

type MarkdownIntent = "document" | "message" | "compact";

interface MarkdownRendererProps {
  content: string;
  intent: MarkdownIntent;
  sourceMapped: boolean;
  diff: boolean;
}

const ROOT_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "min-w-0 max-w-full break-words px-xl py-[20px] font-body text-[0.95rem] leading-[1.75] text-text-primary [overflow-wrap:anywhere] selection:bg-cyan-glow-strong max-640:px-md max-640:py-lg",
  message:
    "min-w-0 max-w-full break-words font-body text-[0.9rem] leading-[1.65] text-text-primary [overflow-wrap:anywhere] selection:bg-cyan-glow-strong",
  compact:
    "min-w-0 max-w-full break-words font-body text-[0.78rem] leading-[1.5] text-text-primary [overflow-wrap:anywhere] selection:bg-cyan-glow-strong",
};

const HEADING_CLASSES: Record<
  MarkdownIntent,
  Record<"h1" | "h2" | "h3" | "h4" | "h5" | "h6", string>
> = {
  document: {
    h1: "mt-xl mb-md min-w-0 break-words border-x-0 border-t-0 border-b border-solid border-border-subtle pb-sm font-body text-[1.5rem] leading-[1.3] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h2: "mt-xl mb-md min-w-0 break-words border-x-0 border-t-0 border-b border-solid border-border-subtle pb-xs font-body text-[1.22rem] leading-[1.3] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h3: "mt-lg mb-sm min-w-0 break-words font-body text-[1.05rem] leading-[1.35] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h4: "mt-lg mb-sm min-w-0 break-words font-body text-[0.96rem] leading-[1.35] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h5: "mt-md mb-sm min-w-0 break-words font-body text-[0.88rem] leading-[1.4] font-bold text-text-secondary first:mt-0 [overflow-wrap:anywhere]",
    h6: "mt-md mb-sm min-w-0 break-words font-body text-[0.84rem] leading-[1.4] font-bold text-text-secondary first:mt-0 [overflow-wrap:anywhere]",
  },
  message: {
    h1: "mt-md mb-sm min-w-0 break-words font-display text-[1.3rem] leading-[1.3] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h2: "mt-md mb-sm min-w-0 break-words font-display text-[1.15rem] leading-[1.3] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h3: "mt-md mb-sm min-w-0 break-words font-display text-[1.05rem] leading-[1.35] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h4: "mt-sm mb-xs min-w-0 break-words font-display text-[0.95rem] leading-[1.35] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h5: "mt-sm mb-xs min-w-0 break-words font-display text-[0.88rem] leading-[1.4] font-bold text-text-secondary first:mt-0 [overflow-wrap:anywhere]",
    h6: "mt-sm mb-xs min-w-0 break-words font-display text-[0.84rem] leading-[1.4] font-bold text-text-secondary first:mt-0 [overflow-wrap:anywhere]",
  },
  compact: {
    h1: "mt-sm mb-xs min-w-0 break-words font-display text-[1rem] leading-[1.3] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h2: "mt-sm mb-xs min-w-0 break-words font-display text-[0.94rem] leading-[1.3] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h3: "mt-sm mb-xs min-w-0 break-words font-display text-[0.88rem] leading-[1.35] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h4: "mt-xs mb-xs min-w-0 break-words font-display text-[0.82rem] leading-[1.35] font-bold text-text-primary first:mt-0 [overflow-wrap:anywhere]",
    h5: "mt-xs mb-xs min-w-0 break-words font-display text-[0.78rem] leading-[1.4] font-bold text-text-secondary first:mt-0 [overflow-wrap:anywhere]",
    h6: "mt-xs mb-xs min-w-0 break-words font-display text-[0.74rem] leading-[1.4] font-bold text-text-secondary first:mt-0 [overflow-wrap:anywhere]",
  },
};

const PARAGRAPH_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "mb-md min-w-0 break-words text-inherit last:mb-0 [overflow-wrap:anywhere]",
  message:
    "mb-sm min-w-0 break-words text-inherit last:mb-0 [overflow-wrap:anywhere]",
  compact:
    "mb-xs min-w-0 break-words text-inherit last:mb-0 [overflow-wrap:anywhere]",
};

const UNORDERED_LIST_MARKER_CLASSES =
  "list-none [&>li]:relative [&>li]:before:absolute [&>li]:before:-left-[1.1em] [&>li]:before:font-bold [&>li]:before:text-cyan [&>li]:before:select-none [&>li]:before:content-['›']";

const UNORDERED_LIST_CLASSES: Record<MarkdownIntent, string> = {
  document: `mb-md min-w-0 space-y-xs pl-xl last:mb-0 ${UNORDERED_LIST_MARKER_CLASSES}`,
  message: `my-sm min-w-0 space-y-xs pl-lg last:mb-0 ${UNORDERED_LIST_MARKER_CLASSES}`,
  compact: `my-xs min-w-0 space-y-2xs pl-lg last:mb-0 ${UNORDERED_LIST_MARKER_CLASSES}`,
};

const ORDERED_LIST_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "mb-md min-w-0 list-decimal space-y-xs pl-xl marker:text-text-secondary last:mb-0",
  message:
    "my-sm min-w-0 list-decimal space-y-xs pl-lg marker:text-text-secondary last:mb-0",
  compact:
    "my-xs min-w-0 list-decimal space-y-2xs pl-lg marker:text-text-secondary last:mb-0",
};

const LIST_ITEM_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "mb-xs min-w-0 break-words last:mb-0 [overflow-wrap:anywhere] [&>ol]:mt-xs [&>ul]:mt-xs",
  message:
    "mb-xs min-w-0 break-words last:mb-0 [overflow-wrap:anywhere] [&>ol]:mt-xs [&>ul]:mt-xs",
  compact:
    "mb-2xs min-w-0 break-words last:mb-0 [overflow-wrap:anywhere] [&>ol]:mt-2xs [&>ul]:mt-2xs",
};

const BLOCKQUOTE_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "mb-md rounded-r-sm border-x-0 border-y-0 border-l-[3px] border-solid border-cyan bg-bg-raised px-md py-sm leading-[1.6] text-text-secondary last:mb-0 [&>:last-child]:mb-0",
  message:
    "my-sm border-x-0 border-y-0 border-l-2 border-solid border-border-default pl-md text-text-secondary last:mb-0 [&>:last-child]:mb-0",
  compact:
    "my-xs border-x-0 border-y-0 border-l-2 border-solid border-border-default pl-sm text-text-secondary last:mb-0 [&>:last-child]:mb-0",
};

const TABLE_REGION_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "mb-md max-w-full overflow-x-auto rounded-sm outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 last:mb-0",
  message:
    "my-sm max-w-full overflow-x-auto rounded-sm outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 last:mb-0",
  compact:
    "my-xs max-w-full overflow-x-auto rounded-sm outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 last:mb-0",
};

const TABLE_CLASSES: Record<MarkdownIntent, string> = {
  document: "w-max min-w-full border-collapse text-[0.82rem]",
  message: "w-max min-w-full border-collapse text-[0.85rem]",
  compact: "w-max min-w-full border-collapse text-[0.74rem]",
};

const TABLE_CELL_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "border border-solid border-border-subtle px-sm py-xs text-left align-top",
  message:
    "border border-solid border-border-default px-sm py-xs text-left align-top",
  compact:
    "border border-solid border-border-subtle px-xs py-2xs text-left align-top",
};

const TABLE_HEADER_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "border border-solid border-border-subtle bg-bg-raised px-sm py-xs text-left align-top font-mono text-[0.75rem] font-semibold text-text-secondary",
  message:
    "border border-solid border-border-default bg-bg-raised px-sm py-xs text-left align-top font-bold text-text-primary",
  compact:
    "border border-solid border-border-subtle bg-bg-raised px-xs py-2xs text-left align-top font-mono text-[0.7rem] font-semibold text-text-secondary",
};

const INLINE_CODE_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "max-w-full break-words rounded-sm bg-bg-raised px-[0.4em] py-[0.15em] font-mono text-[0.82em] text-cyan [overflow-wrap:anywhere]",
  message:
    "max-w-full break-words rounded-sm bg-bg-raised px-[6px] py-2xs font-mono text-[0.82rem] text-cyan [overflow-wrap:anywhere]",
  compact:
    "max-w-full break-words rounded-sm bg-bg-raised px-xs py-2xs font-mono text-[0.74rem] text-cyan [overflow-wrap:anywhere]",
};

const CODE_WRAPPER_CLASSES: Record<MarkdownIntent, string> = {
  document: "group relative mb-md max-w-full last:mb-0",
  message: "group relative my-sm max-w-full last:mb-0",
  compact: "group relative my-xs max-w-full last:mb-0",
};

const CODE_PRE_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "m-0 max-w-full overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-base p-md font-mono text-[0.8rem] leading-[1.6] text-text-primary",
  message:
    "m-0 max-w-full overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-base p-md font-mono text-[0.8rem] leading-[1.55] text-text-primary",
  compact:
    "m-0 max-w-full overflow-x-auto rounded-sm border border-solid border-border-subtle bg-bg-base p-sm font-mono text-[0.72rem] leading-[1.5] text-text-primary",
};

const LINK_CLASSES =
  "break-words font-medium text-cyan underline decoration-current underline-offset-2 [overflow-wrap:anywhere] hover:text-cyan-dim focus-visible:rounded-sm focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

/**
 * Revision marks sit *inside* whatever Markdown element the changed span
 * belongs to, so their colour lands on the innermost element and wins over the
 * heading/emphasis/link colour it replaces without needing an override.
 */
// A replacement puts the removed run directly against the run that replaced it,
// and at the end of a phrase the two carry no separating space of their own.
const DIFF_ADDED_CLASSES =
  "rounded-sm bg-green-glow text-green no-underline [del+&]:ml-2xs";
const DIFF_REMOVED_CLASSES =
  "rounded-sm bg-red-glow text-red-text line-through decoration-current";

const THEMATIC_BREAK_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "my-xl h-0 border-x-0 border-t border-b-0 border-solid border-border-subtle",
  message:
    "my-md h-0 border-x-0 border-t border-b-0 border-solid border-border-subtle",
  compact:
    "my-sm h-0 border-x-0 border-t border-b-0 border-solid border-border-subtle",
};

const LANGUAGE_CLASS_RE = /(?:^|\s)language-([^\s]+)/;

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

const HIGHLIGHTER_NAMES: Record<string, string> = {
  shellSession: "shell-session",
};

type SyntaxHighlighterComponent =
  (typeof import("react-syntax-highlighter"))["PrismLight"];

interface HighlightRuntime {
  SyntaxHighlighter: SyntaxHighlighterComponent;
  language: string;
  style: Record<string, CSSProperties>;
}

const highlightRuntimePromises = new Map<
  string,
  Promise<HighlightRuntime | null>
>();

function resolveLanguage(language: string): string {
  return LANGUAGE_ALIASES[language] ?? language;
}

function highlighterName(language: string): string {
  return HIGHLIGHTER_NAMES[language] ?? language;
}

function loadHighlightRuntime(
  language: string,
): Promise<HighlightRuntime | null> {
  const canonical = resolveLanguage(language);
  const existing = highlightRuntimePromises.get(canonical);
  if (existing) return existing;

  const languageLoader = LANGUAGE_LOADERS[canonical];
  if (!languageLoader) return Promise.resolve(null);

  const promise = Promise.all([
    import("react-syntax-highlighter"),
    languageLoader(),
    import("react-syntax-highlighter/dist/esm/styles/prism"),
  ])
    .then(([syntaxModule, languageModule, styleModule]) => {
      const SyntaxHighlighter = syntaxModule.PrismLight;
      const registeredName = highlighterName(canonical);
      SyntaxHighlighter.registerLanguage(
        registeredName,
        languageModule.default,
      );

      return {
        SyntaxHighlighter,
        language: registeredName,
        style: styleModule.atomDark as Record<string, CSSProperties>,
      };
    })
    .catch(() => {
      // A failed chunk load must degrade to the unhighlighted <pre> fallback
      // instead of surfacing an unhandled rejection; drop the cached promise
      // so a later mount can retry the import.
      highlightRuntimePromises.delete(canonical);
      return null;
    });

  highlightRuntimePromises.set(canonical, promise);
  return promise;
}

function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        return;
      }

      setCopied(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    },
    [code],
  );

  const accessibleName = copied ? "Code copied" : "Copy code";

  return (
    <button
      type="button"
      aria-label={accessibleName}
      title={accessibleName}
      className={cn(
        "absolute top-sm right-sm z-raised flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-subtle bg-bg-raised p-0 text-text-tertiary opacity-0 transition-[opacity,background,color,border-color] duration-150 outline-none group-hover:opacity-100 hover:border-border-default hover:bg-bg-hover hover:text-text-secondary focus:opacity-100 focus-visible:opacity-100 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:h-[44px] max-768:w-[44px] max-768:opacity-100",
        copied && "text-green opacity-100",
      )}
      onClick={(event) => void handleCopy(event)}
    >
      {copied ? <CopiedIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
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
  );
}

function CopiedIcon() {
  return (
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
  );
}

function HighlightedCodeBlock({
  code,
  intent,
  language,
}: {
  code: string;
  intent: MarkdownIntent;
  language: string;
}) {
  const [runtime, setRuntime] = useState<HighlightRuntime | null>(null);

  useEffect(() => {
    let active = true;
    void loadHighlightRuntime(language).then((loadedRuntime) => {
      if (active) setRuntime(loadedRuntime);
    });
    return () => {
      active = false;
    };
  }, [language]);

  if (!runtime) {
    return (
      <pre className={CODE_PRE_CLASSES[intent]}>
        <code>{code}</code>
      </pre>
    );
  }

  const { SyntaxHighlighter } = runtime;
  return (
    <SyntaxHighlighter
      className={CODE_PRE_CLASSES[intent]}
      customStyle={{
        background: "var(--bg-base)",
        margin: 0,
      }}
      language={runtime.language}
      style={runtime.style}
    >
      {code}
    </SyntaxHighlighter>
  );
}

function FencedCodeBlock({
  code,
  intent,
  language,
  containerProps,
}: {
  code: string;
  intent: MarkdownIntent;
  language: string | undefined;
  containerProps: CodeContainerProps;
}) {
  const normalizedLanguage = language?.toLowerCase();
  const isMermaid = normalizedLanguage === "mermaid";

  if (isMermaid) {
    return (
      <div
        {...containerProps}
        data-markdown-mermaid
        className={cn(CODE_WRAPPER_CLASSES[intent], containerProps.className)}
      >
        <MermaidDiagram code={code} />
      </div>
    );
  }

  return (
    <div
      {...containerProps}
      data-markdown-code-block
      data-code-language={normalizedLanguage ?? ""}
      className={cn(CODE_WRAPPER_CLASSES[intent], containerProps.className)}
    >
      {normalizedLanguage &&
      LANGUAGE_LOADERS[resolveLanguage(normalizedLanguage)] ? (
        <HighlightedCodeBlock
          code={code}
          intent={intent}
          language={normalizedLanguage}
        />
      ) : (
        <pre className={CODE_PRE_CLASSES[intent]}>
          <code>{code}</code>
        </pre>
      )}
      <CodeBlockCopyButton code={code} />
    </div>
  );
}

interface CodeContainerProps {
  className?: string;
  "data-cc-line"?: string;
  "data-cc-section"?: string;
  "data-cc-heading"?: string;
}

function stringProperty(
  value: Element["properties"][string],
): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function sourceMetadataFromNode(
  node: Element | undefined,
): Omit<CodeContainerProps, "className"> {
  return {
    [CC_LINE_ATTR]: stringProperty(node?.properties[CC_LINE_ATTR]),
    [CC_SECTION_ATTR]: stringProperty(node?.properties[CC_SECTION_ATTR]),
    [CC_HEADING_ATTR]: stringProperty(node?.properties[CC_HEADING_ATTR]),
  };
}

function collectText(node: Nodes): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "element":
    case "root":
      return node.children.map(collectText).join("");
    default:
      return "";
  }
}

function fencedCodeFromNode(node: Element | undefined): {
  code: string;
  language: string | undefined;
} | null {
  const codeNode = node?.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  if (!codeNode) return null;

  const classNameProperty = codeNode.properties.className;
  const className = Array.isArray(classNameProperty)
    ? classNameProperty.join(" ")
    : typeof classNameProperty === "string"
      ? classNameProperty
      : "";
  const language = LANGUAGE_CLASS_RE.exec(className)?.[1];

  return {
    code: collectText(codeNode).replace(/\n$/, ""),
    language,
  };
}

function createMarkdownComponents(intent: MarkdownIntent): Components {
  return {
    h1({ node: _node, className, ...props }) {
      return (
        <h1 {...props} className={cn(HEADING_CLASSES[intent].h1, className)} />
      );
    },
    h2({ node: _node, className, ...props }) {
      return (
        <h2 {...props} className={cn(HEADING_CLASSES[intent].h2, className)} />
      );
    },
    h3({ node: _node, className, ...props }) {
      return (
        <h3 {...props} className={cn(HEADING_CLASSES[intent].h3, className)} />
      );
    },
    h4({ node: _node, className, ...props }) {
      return (
        <h4 {...props} className={cn(HEADING_CLASSES[intent].h4, className)} />
      );
    },
    h5({ node: _node, className, ...props }) {
      return (
        <h5 {...props} className={cn(HEADING_CLASSES[intent].h5, className)} />
      );
    },
    h6({ node: _node, className, ...props }) {
      return (
        <h6 {...props} className={cn(HEADING_CLASSES[intent].h6, className)} />
      );
    },
    p({ node: _node, className, ...props }) {
      return (
        <p {...props} className={cn(PARAGRAPH_CLASSES[intent], className)} />
      );
    },
    ul({ node: _node, className, ...props }) {
      return (
        <ul
          {...props}
          className={cn(UNORDERED_LIST_CLASSES[intent], className)}
        />
      );
    },
    ol({ node: _node, className, ...props }) {
      return (
        <ol
          {...props}
          className={cn(ORDERED_LIST_CLASSES[intent], className)}
        />
      );
    },
    li({ node: _node, className, ...props }) {
      return (
        <li
          {...props}
          className={cn(
            LIST_ITEM_CLASSES[intent],
            className?.includes("task-list-item") && "list-none",
            className,
          )}
        />
      );
    },
    input({ node: _node, className, ...props }) {
      // GFM task-list checkboxes are disabled, name-less form controls. Give
      // each a state-reflecting accessible name so assistive tech announces
      // completion status (otherwise axe `label`, critical).
      const taskName =
        props.type === "checkbox"
          ? props.checked
            ? "Completed task item"
            : "Incomplete task item"
          : undefined;
      return (
        <input
          {...props}
          aria-label={taskName}
          className={cn(
            "mr-sm h-[14px] w-[14px] shrink-0 accent-cyan",
            className,
          )}
        />
      );
    },
    blockquote({ node: _node, className, ...props }) {
      return (
        <blockquote
          {...props}
          className={cn(BLOCKQUOTE_CLASSES[intent], className)}
        />
      );
    },
    a({ node: _node, className, ...props }) {
      return (
        <MarkdownLink {...props} className={cn(LINK_CLASSES, className)} />
      );
    },
    table({ node: _node, className, ...props }) {
      return (
        <div
          data-markdown-table-scroll
          role="region"
          aria-label="Scrollable table"
          tabIndex={0}
          className={TABLE_REGION_CLASSES[intent]}
        >
          <table {...props} className={cn(TABLE_CLASSES[intent], className)} />
        </div>
      );
    },
    tr({ node: _node, className, ...props }) {
      return <tr {...props} className={cn("even:bg-bg-raised", className)} />;
    },
    th({ node: _node, className, ...props }) {
      return (
        <th
          {...props}
          className={cn(TABLE_HEADER_CLASSES[intent], className)}
        />
      );
    },
    td({ node: _node, className, ...props }) {
      return (
        <td {...props} className={cn(TABLE_CELL_CLASSES[intent], className)} />
      );
    },
    hr({ node: _node, className, ...props }) {
      return (
        <hr
          {...props}
          className={cn(THEMATIC_BREAK_CLASSES[intent], className)}
        />
      );
    },
    strong({ node: _node, className, ...props }) {
      return (
        <strong
          {...props}
          className={cn("font-bold text-text-primary", className)}
        />
      );
    },
    em({ node: _node, className, ...props }) {
      return <em {...props} className={cn("text-text-secondary", className)} />;
    },
    del({ node, className, ...props }) {
      // Two sources produce `<del>`: authored `~~strikethrough~~` and a removed
      // revision span. Only the latter carries the diff colour.
      const removed = node?.properties[DIFF_KIND_PROPERTY] === "removed";
      return (
        <del
          {...props}
          className={cn(
            removed ? DIFF_REMOVED_CLASSES : "decoration-text-tertiary",
            className,
          )}
        />
      );
    },
    ins({ node: _node, className, ...props }) {
      return <ins {...props} className={cn(DIFF_ADDED_CLASSES, className)} />;
    },
    img({ node: _node, className, alt, ...props }) {
      return (
        // Markdown image sources do not provide the dimensions required by next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...props}
          alt={alt ?? ""}
          loading="lazy"
          className={cn("h-auto max-w-full rounded-md", className)}
        />
      );
    },
    pre({ node, children, className, ...props }) {
      const fencedCode = fencedCodeFromNode(node);
      if (!fencedCode) {
        return (
          <pre {...props} className={cn(CODE_PRE_CLASSES[intent], className)}>
            {children}
          </pre>
        );
      }

      return (
        <FencedCodeBlock
          {...fencedCode}
          intent={intent}
          containerProps={{
            ...sourceMetadataFromNode(node),
            className,
          }}
        />
      );
    },
    code({ node: _node, className, ...props }) {
      return (
        <code
          {...props}
          className={cn(INLINE_CODE_CLASSES[intent], className)}
        />
      );
    },
  };
}

const COMPONENTS_BY_INTENT: Record<MarkdownIntent, Components> = {
  document: createMarkdownComponents("document"),
  message: createMarkdownComponents("message"),
  compact: createMarkdownComponents("compact"),
};

// remark-breaks keeps single-newline content (e.g. workflow builder briefs)
// rendering as visible line breaks without a pre-wrap root, which would also
// render the "\n" text nodes between sibling blocks as blank lines.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const SOURCE_MAP_PLUGINS = [rehypeStampSourcePosition];
const DIFF_PLUGINS = [rehypeDiffMarks];

function rehypePlugins(sourceMapped: boolean, diff: boolean) {
  if (diff) return DIFF_PLUGINS;
  return sourceMapped ? SOURCE_MAP_PLUGINS : undefined;
}

const MarkdownRenderer = forwardRef<HTMLDivElement, MarkdownRendererProps>(
  function MarkdownRenderer({ content, intent, sourceMapped, diff }, ref) {
    return (
      <div
        ref={ref}
        data-markdown-intent={intent}
        data-markdown-source-mapped={sourceMapped || undefined}
        data-markdown-diff={diff || undefined}
        className={ROOT_CLASSES[intent]}
      >
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={rehypePlugins(sourceMapped, diff)}
          components={COMPONENTS_BY_INTENT[intent]}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  },
);

export default MarkdownRenderer;
