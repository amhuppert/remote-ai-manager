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
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <button
            onClick={() => setSelectedDocId(null)}
            className="cc-btn cc-btn-ghost cc-btn-sm"
            type="button"
          >
            Back
          </button>
          <span
            style={{ fontSize: "13px", opacity: 0.7 }}
            title={selectedDoc.filePath}
          >
            {selectedDoc.filePath.split("/").pop()}
          </span>
        </div>
        <MarkdownViewer
          content={contentQuery.data ?? null}
          isLoading={contentQuery.isPending}
          emptyMessage="Document content not available."
        />
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          opacity: 0.5,
          fontSize: "13px",
          padding: "20px",
        }}
      >
        No reference documents registered.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "auto",
      }}
    >
      {docs.map((doc) => (
        <button
          key={doc.id}
          onClick={() => setSelectedDocId(doc.id)}
          type="button"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            padding: "10px 12px",
            borderBottom: "1px solid var(--border-color)",
            background: "none",
            border: "none",
            borderBottomStyle: "solid",
            borderBottomWidth: "1px",
            borderBottomColor: "var(--border-color)",
            textAlign: "left",
            cursor: "pointer",
            width: "100%",
          }}
          className="docs-panel-item"
        >
          <span style={{ fontSize: "13px", fontWeight: 500 }}>
            {doc.filePath}
          </span>
          <span style={{ fontSize: "11px", opacity: 0.6 }}>
            {doc.description}
          </span>
        </button>
      ))}
    </div>
  );
}
