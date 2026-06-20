"use client";

import MarkdownViewer from "@/components/MarkdownViewer";
import {
  useReferenceDocumentsQuery,
  useReferenceDocumentContentQuery,
} from "@/lib/reference-documents/queries";
import {
  useSelectedDocId,
  useSelectDocId,
} from "@/stores/session-detail.store";

interface DocsPanelProps {
  projectName: string;
  sessionName: string;
}

export default function DocsPanel({
  projectName,
  sessionName,
}: DocsPanelProps): React.JSX.Element {
  const selectedDocId = useSelectedDocId();
  const selectDocId = useSelectDocId();

  const docsQuery = useReferenceDocumentsQuery(projectName, sessionName);
  const contentQuery = useReferenceDocumentContentQuery(
    projectName,
    sessionName,
    selectedDocId,
  );

  const docs = docsQuery.data ?? [];
  const selectedDoc = docs.find((d) => d.id === selectedDocId);

  if (selectedDoc) {
    return (
      <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
        <div className="flex shrink-0 items-center gap-[8px] border-x-0 border-t-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
          <button
            onClick={() => selectDocId(null)}
            className="flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent font-mono text-[1rem] text-text-secondary transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-cyan max-768:h-[44px] max-768:w-[44px]"
            type="button"
          >
            &#8249;
          </button>
          <span
            className="truncate font-mono text-[0.72rem] font-semibold tracking-[0.06em] text-text-primary uppercase"
            title={selectedDoc.filePath}
          >
            {selectedDoc.filePath.split("/").pop()}
          </span>
        </div>
        <div className="docs-panel-content flex min-h-0 flex-1 flex-col">
          <MarkdownViewer
            content={contentQuery.data ?? null}
            isLoading={contentQuery.isPending}
            emptyMessage="Document content not available."
          />
        </div>
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
        <div className="flex flex-1 flex-col items-center justify-center gap-sm font-mono text-[0.78rem] text-text-tertiary">
          <span>No reference documents registered.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
      <div className="flex-1 overflow-y-auto py-xs">
        {docs.map((doc) => (
          <button
            key={doc.id}
            onClick={() => selectDocId(doc.id)}
            type="button"
            className="group flex w-full cursor-pointer flex-col gap-[2px] border-y-0 border-r-0 border-l-2 border-solid border-l-transparent bg-transparent px-[12px] py-[7px] text-left transition-all duration-150 ease-[ease] hover:bg-bg-hover max-768:min-h-[44px] max-768:px-[12px] max-768:py-[10px]"
          >
            <span className="truncate font-mono text-[0.72rem] font-medium text-text-secondary transition-[color] duration-150 ease-[ease] group-hover:text-text-primary">
              {doc.filePath}
            </span>
            {doc.description && (
              <span className="truncate font-mono text-[0.7rem] font-normal text-text-tertiary">
                {doc.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
