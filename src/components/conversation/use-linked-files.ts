"use client";

import {
  resolveWorktreeLink,
  worktreeHtmlUrl,
  worktreeImageUrl,
  type WorktreeLinkTarget,
} from "@/lib/documents/worktree-links";
import {
  useFilePreviewStore,
  type FilePreviewState,
} from "@/stores/file-preview.store";
import { useOpenDocument } from "@/stores/session-detail.store";
import { useDocumentScope, type DocumentScope } from "./document-scope";

export interface LinkedFiles {
  worktreePath: string;
  resolve(href: string | undefined): WorktreeLinkTarget | null;
  imageUrl(imagePath: string): string;
  htmlUrl(htmlPath: string): string;
  /** Null where linked Markdown has no viewer (project conversations). */
  openMarkdown:
    | ((
        doc: { docPath: string; title: string },
        opener: HTMLElement | null,
      ) => void)
    | null;
  openImage(
    image: { imagePath: string; fileName: string; alt: string },
    opener: HTMLElement | null,
  ): void;
}

type SessionDocumentScope = Extract<DocumentScope, { sessionName: string }>;

/** Close a transient host first; the preview then returns focus to its anchor. */
function leaveTransientHost(
  scope: DocumentScope,
  opener: HTMLElement | null,
): HTMLElement | null {
  if (!scope.transientHost) return opener;
  scope.transientHost.close();
  return scope.transientHost.anchor;
}

function openMarkdownIn(
  scope: SessionDocumentScope,
  openDocument: ReturnType<typeof useOpenDocument>,
  openPreview: FilePreviewState["openPreview"],
): NonNullable<LinkedFiles["openMarkdown"]> {
  const { projectName, sessionName } = scope;
  return (doc, opener) => {
    const returnFocusTo = leaveTransientHost(scope, opener);
    if (scope.markdownViewer === "pane") {
      openDocument({ projectName, sessionName, ...doc });
      return;
    }
    openPreview(
      { kind: "markdown", projectName, sessionName, ...doc },
      returnFocusTo,
    );
  };
}

/**
 * How files linked from messages resolve and open in the current document
 * scope, or null outside one. `opener` is the control that was activated;
 * focus returns to it when a preview dialog closes.
 */
export function useLinkedFiles(): LinkedFiles | null {
  const scope = useDocumentScope();
  const openDocument = useOpenDocument();
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  if (!scope) return null;

  const imageUrl = (imagePath: string): string =>
    worktreeImageUrl(scope, imagePath);

  return {
    worktreePath: scope.worktreePath,
    resolve: (href) => resolveWorktreeLink(href, scope.worktreePath),
    imageUrl,
    htmlUrl: (htmlPath) => worktreeHtmlUrl(scope, htmlPath),
    openMarkdown:
      scope.sessionName === null
        ? null
        : openMarkdownIn(scope, openDocument, openPreview),
    openImage: (image, opener) => {
      openPreview(
        { kind: "image", src: imageUrl(image.imagePath), ...image },
        leaveTransientHost(scope, opener),
      );
    },
  };
}
