"use client";

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/ui/cn";
import MarkdownLink from "@/components/MarkdownLink";

/**
 * Renders the model-authored agent brief as markdown in the artifact pane's
 * prose voice: body font at the brief's reading size, `font-display` headings on
 * a section rhythm, mono cyan inline code, and mono code blocks. Deliberately
 * lighter than {@link "@/components/MarkdownContent"} — no syntax highlighting or
 * Mermaid — because the brief is a short handoff narrative, not a code document.
 *
 * Vertical spacing leans on margin collapsing between adjacent blocks (a large
 * heading top-margin against a small block bottom-margin yields the section gap;
 * two blocks yield the paragraph gap), so the wrapper stays a plain block — not
 * a flex column, which would defeat collapsing.
 */

const components: Components = {
  a: MarkdownLink,
  h1: ({ children }) => (
    <h1 className="mt-[24px] mb-sm font-display text-[17px] leading-[1.3] font-semibold text-text-primary">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-[22px] mb-[7px] font-display text-[15px] leading-[1.3] font-semibold text-text-primary">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-[20px] mb-[6px] font-display text-[13.5px] leading-[1.4] font-semibold text-text-primary">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-[18px] mb-[5px] font-display text-[12px] font-semibold tracking-[0.06em] text-text-secondary uppercase">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-[16px] mb-[5px] font-display text-[11.5px] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-[16px] mb-[5px] font-display text-[11.5px] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="mt-0 mb-md">{children}</p>,
  ul: ({ children }) => (
    <ul className="mt-0 mb-md list-disc pl-[1.4em]">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-0 mb-md list-decimal pl-[1.4em]">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="mb-[3px] marker:text-text-tertiary [&>ol]:mt-[3px] [&>ol]:mb-0 [&>ul]:mt-[3px] [&>ul]:mb-0">
      {children}
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-0 mb-md rounded-r-sm border-y-0 border-r-0 border-l-2 border-solid border-cyan bg-bg-raised px-md py-sm text-text-secondary [&>:last-child]:mb-0">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-text-primary">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="text-text-secondary italic">{children}</em>
  ),
  hr: () => (
    <hr className="my-lg border-x-0 border-t border-b-0 border-solid border-border-subtle" />
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-bg-raised px-[5px] py-px font-mono text-[0.84em] text-cyan">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mt-0 mb-md overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-base p-md font-mono text-[12px] leading-[1.55] text-text-primary [&_code]:bg-transparent [&_code]:p-0 [&_code]:[font-size:inherit] [&_code]:text-inherit">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <table className="mt-0 mb-md w-full border-collapse text-[12.5px]">
      {children}
    </table>
  ),
  th: ({ children }) => (
    <th className="border border-solid border-border-subtle bg-bg-raised px-sm py-xs text-left font-mono text-[11px] font-semibold text-text-secondary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-solid border-border-subtle px-sm py-xs text-left">
      {children}
    </td>
  ),
};

export interface ArtifactMarkdownProps {
  content: string;
  className?: string;
}

export default function ArtifactMarkdown({
  content,
  className,
}: ArtifactMarkdownProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "font-body text-[14px] leading-[1.72] text-text-primary [&_a]:text-cyan [&_a]:no-underline [&_a:hover]:underline [&>:first-child]:mt-0 [&>:last-child]:mb-0",
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
