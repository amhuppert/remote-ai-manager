export const referenceDocumentKeys = {
  all: ["reference-documents"] as const,
  lists: () => [...referenceDocumentKeys.all, "list"] as const,
  contents: () => [...referenceDocumentKeys.all, "content"] as const,
  list: (projectName: string, sessionName: string) =>
    [...referenceDocumentKeys.lists(), projectName, sessionName] as const,
  content: (projectName: string, sessionName: string, documentId: string) =>
    [
      ...referenceDocumentKeys.contents(),
      projectName,
      sessionName,
      documentId,
    ] as const,
};
