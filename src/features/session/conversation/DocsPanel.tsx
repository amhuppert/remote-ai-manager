"use client";

import { useEffect, useMemo, useState } from "react";
import { useReferenceDocumentsQuery } from "@/lib/reference-documents/queries";
import { useMarkdownDocumentsQuery } from "@/lib/documents/queries";
import {
  useActiveDocPath,
  useDocActivationNonce,
  useOpenDocument,
  useOpenDocuments,
  useSelectDocId,
  useSelectedDocId,
} from "@/stores/session-detail.store";
import DocumentViewer from "@/features/session/document-viewer/DocumentViewer";
import { resolveRegisteredDoc } from "@/features/session/document-viewer/register-doc-ref";
import MarkdownDocumentList from "./MarkdownDocumentList";

interface DocsPanelProps {
  projectName: string;
  sessionName: string;
  /** Session worktree root — used to normalize registered absolute paths. */
  worktreePath: string;
}

const PANEL_CLASS =
  "flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface";

/**
 * The Docs right-pane surface. Lists Markdown documents accumulated for the
 * session and opens them by canonical path in the multi-document viewer.
 * Worktree documents support selection and comments; external documents open
 * read-only. A back affordance returns to the list without closing open tabs.
 */
export default function DocsPanel({
  projectName,
  sessionName,
  worktreePath,
}: DocsPanelProps): React.JSX.Element {
  const openDocuments = useOpenDocuments();
  const activeDocPath = useActiveDocPath();
  const docActivationNonce = useDocActivationNonce();
  const openDocument = useOpenDocument();
  const selectedDocId = useSelectedDocId();
  const selectDocId = useSelectDocId();

  const referenceDocsQuery = useReferenceDocumentsQuery(
    projectName,
    sessionName,
  );
  const markdownDocsQuery = useMarkdownDocumentsQuery(projectName, sessionName);
  const docs = useMemo(
    () => referenceDocsQuery.data ?? [],
    [referenceDocsQuery.data],
  );

  const items = useMemo(
    () =>
      docs.map((doc) =>
        resolveRegisteredDoc(doc, projectName, sessionName, worktreePath),
      ),
    [docs, projectName, sessionName, worktreePath],
  );

  // Browse vs. viewer, derived from the activation nonce so no resetting effect
  // is needed: the back affordance records the nonce at which browse mode was
  // entered; any later open/activate bumps the nonce, which no longer matches,
  // so the viewer reappears with the just-opened document.
  const [browseAtNonce, setBrowseAtNonce] = useState<number | null>(null);
  const browsing = browseAtNonce === docActivationNonce;

  // Bridge the legacy by-id deep link (collab "open document" actions still call
  // openDocById → selectedDocId): resolve the reference doc and open it in the
  // new viewer, then consume the id.
  useEffect(() => {
    if (!selectedDocId) return;
    const target = items.find((item) => item.doc.id === selectedDocId);
    if (target?.available) openDocument(target.ref);
    selectDocId(null);
  }, [selectedDocId, items, openDocument, selectDocId]);

  if (openDocuments.length > 0 && !browsing) {
    return (
      <DocumentViewer onBrowse={() => setBrowseAtNonce(docActivationNonce)} />
    );
  }

  return (
    <div className={PANEL_CLASS}>
      <MarkdownDocumentList
        documents={markdownDocsQuery.data ?? []}
        activeDocPath={activeDocPath}
        loading={markdownDocsQuery.isLoading}
        error={
          markdownDocsQuery.isError
            ? "Could not load Markdown documents."
            : null
        }
        onOpen={(document) =>
          openDocument({
            projectName,
            sessionName,
            docPath: document.docPath,
            title: document.title,
          })
        }
      />
    </div>
  );
}
