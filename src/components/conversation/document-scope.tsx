"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The session scope a transcript is rendered within, needed to open a markdown
 * file card's referenced document in the viewer (the document lives in this
 * session's worktree). Provided once around the session conversation surfaces;
 * absent in transcript surfaces with no document viewer (sidebar peek, the
 * project cockpit), where file cards render but do not offer to open.
 */
export interface DocumentScope {
  projectName: string;
  sessionName: string;
  worktreePath: string;
}

const DocumentScopeContext = createContext<DocumentScope | null>(null);

export function DocumentScopeProvider({
  value,
  children,
}: {
  value: DocumentScope;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <DocumentScopeContext.Provider value={value}>
      {children}
    </DocumentScopeContext.Provider>
  );
}

/** The current document scope, or null when none is provided. */
export function useDocumentScope(): DocumentScope | null {
  return useContext(DocumentScopeContext);
}
