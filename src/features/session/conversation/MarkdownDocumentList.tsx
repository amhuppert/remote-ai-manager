"use client";

import { cn } from "@/lib/ui/cn";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import type {
  MarkdownDocumentListItem,
  MarkdownDocumentOrigin,
} from "@/lib/documents/schemas";

const ORIGIN_LABEL: Record<MarkdownDocumentOrigin, string> = {
  read: "READ",
  write: "WROTE",
  edit: "EDITED",
  registered: "REGISTERED",
};

export interface MarkdownDocumentListProps {
  documents: readonly MarkdownDocumentListItem[];
  activeDocPath: string | null;
  onOpen(document: MarkdownDocumentListItem): void;
  loading?: boolean;
  error?: string | null;
}

function StateMessage({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <EmptyState layoutClassName="min-h-0 flex-1">
      <EmptyStateTitle>{title}</EmptyStateTitle>
      {description ? <EmptyStateDesc>{description}</EmptyStateDesc> : null}
    </EmptyState>
  );
}

export default function MarkdownDocumentList({
  documents,
  activeDocPath,
  onOpen,
  loading = false,
  error = null,
}: MarkdownDocumentListProps): React.JSX.Element {
  if (loading) return <StateMessage title="Loading Markdown documents…" />;
  if (error) return <StateMessage title={error} />;
  if (documents.length === 0) {
    return (
      <StateMessage
        title="No Markdown documents"
        description="Read, edit, or register a Markdown file to add it here."
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-xs">
      {documents.map((document) => {
        const active = document.docPath === activeDocPath;
        const metadata =
          document.location === "external"
            ? `EXTERNAL · ${ORIGIN_LABEL[document.origin]}`
            : ORIGIN_LABEL[document.origin];
        return (
          <button
            key={document.docPath}
            type="button"
            aria-label={`Open ${document.docPath} in Markdown viewer`}
            aria-current={active ? "true" : undefined}
            title={document.docPath}
            onClick={() => onOpen(document)}
            className={cn(
              "group flex min-h-[40px] w-full cursor-pointer flex-col gap-[2px] border-y-0 border-r-0 border-l-2 border-solid px-[12px] py-[7px] text-left font-mono transition-colors duration-150 ease-[ease] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[44px] max-768:py-[10px]",
              active
                ? "border-l-cyan bg-bg-raised"
                : "border-l-transparent bg-transparent hover:bg-bg-hover",
            )}
          >
            <span className="flex w-full min-w-0 items-center gap-sm">
              <span className="min-w-0 flex-1 truncate text-[0.72rem] font-medium text-text-secondary group-hover:text-text-primary">
                {document.docPath}
              </span>
              <span
                className={cn(
                  "shrink-0 text-[0.62rem] tracking-[0.04em]",
                  document.location === "external"
                    ? "text-amber"
                    : "text-text-secondary",
                )}
              >
                {metadata}
              </span>
            </span>
            {document.description ? (
              <span className="w-full truncate text-[0.66rem] text-text-secondary">
                {document.description}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
