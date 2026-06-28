"use client";

import { cn } from "@/lib/ui/cn";
import type { DocumentRef } from "@/lib/document-comments/schemas";

interface DocumentTabsProps {
  documents: DocumentRef[];
  activeDocPath: string | null;
  onActivate: (docPath: string) => void;
  onClose: (docPath: string) => void;
}

/**
 * The open-document tab strip. One tab per open document; the active tab is
 * accented and each tab carries a close affordance. Rendered only when more than
 * one document is open — a single open document needs no tab row (its identity
 * is already shown in the viewer header). The label and close controls are
 * sibling buttons (never nested) so the markup stays valid and each is
 * independently operable.
 */
export default function DocumentTabs({
  documents,
  activeDocPath,
  onActivate,
  onClose,
}: DocumentTabsProps): React.JSX.Element | null {
  if (documents.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Open documents"
      className="flex shrink-0 items-stretch overflow-x-auto border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-surface"
    >
      {documents.map((doc) => {
        const active = doc.docPath === activeDocPath;
        return (
          <div
            key={doc.docPath}
            className={cn(
              "group flex max-w-[200px] shrink-0 items-center gap-[4px] border-x-0 border-t-0 border-b-2 border-solid pr-[6px] pl-[10px]",
              active
                ? "border-b-cyan bg-bg-base"
                : "border-b-transparent hover:bg-bg-hover",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onActivate(doc.docPath)}
              title={doc.docPath}
              className={cn(
                "min-w-0 cursor-pointer truncate border-none bg-transparent py-[7px] font-mono text-[0.72rem] transition-colors duration-150 ease-[ease]",
                active
                  ? "text-text-primary"
                  : "text-text-tertiary group-hover:text-text-primary",
              )}
            >
              {doc.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${doc.title}`}
              onClick={() => onClose(doc.docPath)}
              className="flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent font-mono text-[0.85rem] leading-none text-text-tertiary transition-colors duration-150 ease-[ease] hover:bg-bg-raised hover:text-cyan"
            >
              &#10005;
            </button>
          </div>
        );
      })}
    </div>
  );
}
