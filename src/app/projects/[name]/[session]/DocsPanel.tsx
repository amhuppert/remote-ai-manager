"use client";

import { useState } from "react";
import MarkdownViewer from "@/components/MarkdownViewer";
import {
  useReferenceDocumentsQuery,
  useReferenceDocumentContentQuery,
} from "@/lib/queries";

interface DocsPanelProps {
  projectName: string;
  sessionName: string;
}

export default function DocsPanel({
  projectName,
  sessionName,
}: DocsPanelProps): React.JSX.Element {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

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
      <div className="docs-panel">
        <div className="docs-panel-header">
          <button
            onClick={() => setSelectedDocId(null)}
            className="docs-panel-back"
            type="button"
          >
            &#8249;
          </button>
          <span className="docs-panel-filename" title={selectedDoc.filePath}>
            {selectedDoc.filePath.split("/").pop()}
          </span>
        </div>
        <div className="docs-panel-content">
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
      <div className="docs-panel">
        <div className="docs-panel-empty">
          <span>No reference documents registered.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="docs-panel">
      <div className="docs-panel-list">
        {docs.map((doc) => (
          <button
            key={doc.id}
            onClick={() => setSelectedDocId(doc.id)}
            type="button"
            className="docs-panel-item"
          >
            <span className="docs-panel-item-path">{doc.filePath}</span>
            {doc.description && (
              <span className="docs-panel-item-desc">{doc.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
