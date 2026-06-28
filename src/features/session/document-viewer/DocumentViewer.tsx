"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/ui/cn";
import type { DocumentRef } from "@/lib/document-comments/schemas";
import {
  useDocumentContentQuery,
  classifyDocumentContentError,
} from "@/lib/documents/queries";
import { useDocumentCommentsQuery } from "@/lib/document-comments/queries";
import {
  useActivateDocument,
  useActiveDocPath,
  useCloseDocument,
  useDocActivationNonce,
  useOpenDocuments,
} from "@/stores/session-detail.store";
import DocumentSurface from "./DocumentSurface";
import DocumentTabs from "./DocumentTabs";

/** Split a worktree-relative `docPath` into its filename and directory. */
function splitDocPath(docPath: string): { fileName: string; dir: string } {
  const idx = docPath.lastIndexOf("/");
  if (idx === -1) return { fileName: docPath, dir: "/" };
  return { fileName: docPath.slice(idx + 1), dir: docPath.slice(0, idx) };
}

function FileIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 text-cyan"
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
 * Viewer header: file icon, document title, a comment-count badge for the active
 * document (req 1.4), and its source directory path (req 1.1). The count query
 * shares React Query's cache with the body's `useDocumentComments`, so the badge
 * is free.
 */
function DocumentViewerHeader({
  docRef,
  onBrowse,
}: {
  docRef: DocumentRef;
  onBrowse?: () => void;
}): React.JSX.Element {
  const commentsQuery = useDocumentCommentsQuery(
    docRef.projectName,
    docRef.sessionName,
    docRef.docPath,
  );
  const count = commentsQuery.data?.length ?? 0;
  const { dir } = splitDocPath(docRef.docPath);

  return (
    <div className="flex shrink-0 items-center gap-[8px] border-x-0 border-t-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
      {onBrowse ? (
        <button
          type="button"
          aria-label="Back to documents"
          onClick={onBrowse}
          className="flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent font-mono text-[1rem] text-text-secondary transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-cyan max-768:h-[44px] max-768:w-[44px]"
        >
          &#8249;
        </button>
      ) : null}
      <FileIcon />
      <span
        className="truncate font-mono text-[0.72rem] font-semibold tracking-[0.06em] text-text-primary uppercase"
        title={docRef.docPath}
      >
        {docRef.title}
      </span>
      {count > 0 ? (
        <span className="inline-flex shrink-0 items-center rounded-full border border-solid border-cyan/50 bg-cyan-glow px-[7px] py-px font-mono text-[0.62rem] font-semibold text-cyan">
          {count}
        </span>
      ) : null}
      <span
        className="ml-auto truncate pl-sm font-mono text-[0.66rem] text-text-tertiary"
        title={docRef.docPath}
      >
        {dir}
      </span>
    </div>
  );
}

/**
 * Briefly tints the body when the active document changes (req 1.5). Driven by
 * the monotonic activation nonce so even re-opening the already-active document
 * flashes. Implemented as an overlay that snaps to full tint then fades, so no
 * global keyframe is introduced.
 */
function ActivationFlash({ nonce }: { nonce: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // Drives the tint directly on the DOM node (an external system the effect may
  // update) rather than through React state: snap to full opacity, then fade.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.opacity = "1";
    const raf = requestAnimationFrame(() => {
      el.style.transition = "opacity 500ms ease";
      el.style.opacity = "0";
    });
    return () => cancelAnimationFrame(raf);
  }, [nonce]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ opacity: 0 }}
      className="pointer-events-none absolute inset-0 z-[2] bg-cyan-glow"
    />
  );
}

/**
 * One mounted pane per open document. Panes stay mounted and toggle visibility
 * so each document's scroll position, loaded content, and comment/highlight
 * state survive tab switches (req 1.3); the active pane is shown, the rest are
 * hidden. Content loads by the canonical `docPath` through the content endpoint,
 * surfacing a distinct error kind when it cannot be read (req 1.6).
 */
function OpenDocumentPane({
  docRef,
  hidden,
}: {
  docRef: DocumentRef;
  hidden: boolean;
}): React.JSX.Element {
  const contentQuery = useDocumentContentQuery(
    docRef.projectName,
    docRef.sessionName,
    docRef.docPath,
  );
  const contentError = contentQuery.isError
    ? classifyDocumentContentError(contentQuery.error)
    : null;

  return (
    <div className={cn("min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")}>
      <DocumentSurface
        docRef={docRef}
        content={contentQuery.data?.content ?? null}
        isLoading={contentQuery.isLoading}
        contentError={contentError}
      />
    </div>
  );
}

export interface DocumentViewerProps {
  /** When provided, a back affordance returns to the browse list (DocsPanel). */
  onBrowse?: () => void;
}

/**
 * The multi-document markdown viewer shell. Renders a header (icon, title,
 * comment-count badge, directory path), the open-document tab strip, and the
 * annotated body + pending tray for the active document. Returns null when no
 * documents are open so the host surface (DocsPanel) can show its browse list.
 */
export default function DocumentViewer({
  onBrowse,
}: DocumentViewerProps): React.JSX.Element | null {
  const openDocuments = useOpenDocuments();
  const activeDocPath = useActiveDocPath();
  const activateDocument = useActivateDocument();
  const closeDocument = useCloseDocument();
  const nonce = useDocActivationNonce();

  if (openDocuments.length === 0) return null;

  const active =
    openDocuments.find((d) => d.docPath === activeDocPath) ?? openDocuments[0]!;

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
      <DocumentViewerHeader docRef={active} onBrowse={onBrowse} />
      <DocumentTabs
        documents={openDocuments}
        activeDocPath={activeDocPath}
        onActivate={activateDocument}
        onClose={closeDocument}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ActivationFlash nonce={nonce} />
        {openDocuments.map((doc) => (
          <OpenDocumentPane
            key={doc.docPath}
            docRef={doc}
            hidden={doc.docPath !== active.docPath}
          />
        ))}
      </div>
    </div>
  );
}
