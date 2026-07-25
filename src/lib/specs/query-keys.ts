export const specKeys = {
  all: ["specs"] as const,
  lists: () => [...specKeys.all, "list"] as const,
  list: (projectName: string) => [...specKeys.lists(), projectName] as const,
  details: () => [...specKeys.all, "detail"] as const,
  detail: (projectName: string, slug: string) =>
    [...specKeys.details(), projectName, slug] as const,
  summary: (projectName: string, slug: string) =>
    [...specKeys.detail(projectName, slug), "summary"] as const,
  status: (projectName: string, slug: string) =>
    [...specKeys.detail(projectName, slug), "status"] as const,
  ticketReadThroughs: () => [...specKeys.all, "ticket-read-through"] as const,
  ticketReadThrough: (projectName: string, number: number) =>
    [...specKeys.ticketReadThroughs(), projectName, number] as const,
  element: (
    projectName: string,
    slug: string,
    handle: string,
    observedRevision?: number,
    targetRevisionId?: string,
  ) =>
    [
      ...specKeys.detail(projectName, slug),
      "element",
      handle,
      ...(observedRevision === undefined
        ? []
        : (["observed-revision", observedRevision] as const)),
      ...(targetRevisionId === undefined
        ? []
        : (["target-revision", targetRevisionId] as const)),
    ] as const,
  lint: (projectName: string, slug: string) =>
    [...specKeys.detail(projectName, slug), "lint"] as const,
  integrity: (projectName: string, slug: string) =>
    [...specKeys.detail(projectName, slug), "integrity"] as const,
  search: (projectName: string, slug: string, query: string) =>
    [...specKeys.detail(projectName, slug), "search", query] as const,
} as const;
