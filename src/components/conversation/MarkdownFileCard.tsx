"use client";

import { cn } from "@/lib/ui/cn";
import type { MarkdownFileRef } from "@/lib/documents/markdown-file-refs";
import { normalizeDocPath } from "@/lib/documents/path";
import { useOpenDocument } from "@/stores/session-detail.store";
import { useDocumentScope } from "./document-scope";

interface Props {
  fileRef: MarkdownFileRef;
}

const ORIGIN_LABEL: Record<MarkdownFileRef["origin"], string> = {
  write: "wrote",
  edit: "edited",
  registered: "registered",
};

function FileGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0"
    >
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M14 3v5h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A clickable card for a markdown file surfaced in a conversation message —
 * Write/Edit/MultiEdit operations and registered documents (incl. run_codex
 * reference docs). Clicking opens the file (by its canonical worktree-relative
 * path) in the document viewer as the active document (req 4.1–4.3). A file
 * whose path resolves outside the session worktree is shown as unavailable
 * rather than opening an empty viewer (req 4.4). Renders nothing when there is
 * no document scope (transcript surfaces without a viewer).
 */
export default function MarkdownFileCard({
  fileRef,
}: Props): React.JSX.Element | null {
  const scope = useDocumentScope();
  const openDocument = useOpenDocument();

  if (!scope) return null;

  const normalized = normalizeDocPath(fileRef.docPath, scope.worktreePath);
  const available = normalized.ok;

  if (!available) {
    return (
      <div
        title={fileRef.docPath}
        className="my-[6px] inline-flex max-w-full items-center gap-[8px] self-start rounded-sm border border-solid border-border-subtle bg-bg-surface px-sm py-[6px] font-mono text-[0.74rem] text-text-tertiary opacity-70"
      >
        <span className="shrink-0 text-amber">
          <FileGlyph />
        </span>
        <span className="truncate">{fileRef.fileName}</span>
        <span className="shrink-0 text-[0.66rem] text-amber">unavailable</span>
      </div>
    );
  }

  const ref = {
    projectName: scope.projectName,
    sessionName: scope.sessionName,
    docPath: normalized.docPath,
    title: fileRef.fileName,
  };

  return (
    <button
      type="button"
      onClick={() => openDocument(ref)}
      title={normalized.docPath}
      className={cn(
        "group my-[6px] inline-flex max-w-full cursor-pointer items-center gap-[8px] self-start rounded-sm border border-solid border-border-subtle bg-bg-surface px-sm py-[6px] text-left font-mono text-[0.74rem] transition-colors duration-150 ease-[ease] hover:border-cyan hover:bg-bg-raised",
      )}
    >
      <span className="shrink-0 text-cyan">
        <FileGlyph />
      </span>
      <span className="truncate font-semibold text-text-primary group-hover:text-cyan">
        {fileRef.fileName}
      </span>
      <span className="shrink-0 text-[0.66rem] text-text-tertiary">
        {ORIGIN_LABEL[fileRef.origin]}
      </span>
      <span className="shrink-0 text-[0.66rem] text-cyan opacity-0 transition-opacity duration-150 ease-[ease] group-hover:opacity-100">
        Open →
      </span>
    </button>
  );
}
