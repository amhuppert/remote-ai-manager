/**
 * React Query key factory for document-scoped comments. Comments are keyed by
 * the document identity `(projectName, sessionName, docPath)` so each open
 * document owns its own cached list and invalidations stay scoped to one file.
 */
export const documentCommentKeys = {
  all: ["document-comments"] as const,
  lists: () => [...documentCommentKeys.all, "list"] as const,
  list: (projectName: string, sessionName: string, docPath: string) =>
    [
      ...documentCommentKeys.lists(),
      projectName,
      sessionName,
      docPath,
    ] as const,
};
