"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * A popover hosting the transcript (the sidebar peek). It closes as a linked
 * file's preview opens, and focus returns to its anchor when the preview
 * closes, since the link that opened it is gone.
 */
export interface TransientHost {
  close(): void;
  anchor: HTMLElement | null;
}

/**
 * The scope a transcript is rendered within, needed to open files its messages
 * link to or mention. Provided around the session conversation surfaces, the
 * project cockpit transcript, and the sidebar peek; absent in other transcript
 * surfaces, where file links and cards render but do not offer to open.
 */
export type DocumentScope =
  | {
      projectName: string;
      sessionName: string;
      worktreePath: string;
      /**
       * Where linked Markdown opens: the session page's docs pane, or a
       * preview dialog on surfaces without one.
       */
      markdownViewer: "pane" | "dialog";
      transientHost?: TransientHost;
    }
  | {
      projectName: string;
      /** A project conversation: its files live in the project root, and
       *  linked Markdown has no viewer. */
      sessionName: null;
      worktreePath: string;
      transientHost?: TransientHost;
    };

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
