/**
 * React Query key factory for Markdown content loaded by canonical document
 * path. Keyed by `(projectName, sessionName, docPath)` so each open document's
 * content is cached independently and re-reads stay scoped to one file.
 */
export const documentContentKeys = {
  all: ["document-content"] as const,
  contents: () => [...documentContentKeys.all, "content"] as const,
  content: (projectName: string, sessionName: string, docPath: string) =>
    [
      ...documentContentKeys.contents(),
      projectName,
      sessionName,
      docPath,
    ] as const,
};

export const markdownDocumentKeys = {
  all: ["markdown-documents"] as const,
  lists: () => [...markdownDocumentKeys.all, "list"] as const,
  list: (projectName: string, sessionName: string) =>
    [...markdownDocumentKeys.lists(), projectName, sessionName] as const,
};
