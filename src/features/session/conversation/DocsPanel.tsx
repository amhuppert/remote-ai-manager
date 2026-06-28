"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { useReferenceDocumentsQuery } from "@/lib/reference-documents/queries";
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

interface DocsPanelProps {
  projectName: string;
  sessionName: string;
  /** Session worktree root — used to normalize registered absolute paths. */
  worktreePath: string;
}

const PANEL_CLASS =
  "flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface";

/**
 * The Docs right-pane surface. Enumerates registered reference documents and
 * opens them — by their canonical worktree-relative `docPath` — in the
 * multi-document viewer, where they gain selection/commenting. A registered doc
 * whose absolute path resolves inside the worktree opens; one outside (or
 * non-markdown) is shown as unavailable rather than opening (req 1.1–1.3, 2.1,
 * 10.4). When documents are open the viewer is shown; a back affordance returns
 * to this browse list without closing the open tabs.
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

  const docsQuery = useReferenceDocumentsQuery(projectName, sessionName);
  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);

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

  if (items.length === 0) {
    return (
      <div className={PANEL_CLASS}>
        <div className="flex flex-1 flex-col items-center justify-center gap-sm font-mono text-[0.78rem] text-text-tertiary">
          <span>No reference documents registered.</span>
        </div>
      </div>
    );
  }

  return (
    <div className={PANEL_CLASS}>
      <div className="flex-1 overflow-y-auto py-xs">
        {items.map((item) => {
          const isActive = item.available && item.ref.docPath === activeDocPath;
          if (!item.available) {
            return (
              <div
                key={item.doc.id}
                title={item.doc.filePath}
                className="flex w-full cursor-not-allowed flex-col gap-[2px] border-y-0 border-r-0 border-l-2 border-solid border-l-transparent px-[12px] py-[7px] text-left opacity-60"
              >
                <span className="truncate font-mono text-[0.72rem] font-medium text-text-tertiary line-through">
                  {item.doc.filePath}
                </span>
                <span className="truncate font-mono text-[0.66rem] text-amber">
                  {item.reason === "outside-worktree"
                    ? "Outside this worktree — unavailable"
                    : "Not a markdown document"}
                </span>
              </div>
            );
          }
          return (
            <button
              key={item.doc.id}
              onClick={() => openDocument(item.ref)}
              type="button"
              className={cn(
                "group flex w-full cursor-pointer flex-col gap-[2px] border-y-0 border-r-0 border-l-2 border-solid bg-transparent px-[12px] py-[7px] text-left transition-all duration-150 ease-[ease] hover:bg-bg-hover max-768:min-h-[44px] max-768:px-[12px] max-768:py-[10px]",
                isActive ? "border-l-cyan" : "border-l-transparent",
              )}
            >
              <span className="truncate font-mono text-[0.72rem] font-medium text-text-secondary transition-[color] duration-150 ease-[ease] group-hover:text-text-primary">
                {item.ref.docPath}
              </span>
              {item.doc.description && (
                <span className="truncate font-mono text-[0.7rem] font-normal text-text-tertiary">
                  {item.doc.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
