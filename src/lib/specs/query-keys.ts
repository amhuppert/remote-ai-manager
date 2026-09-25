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
  delta: (projectName: string, slug: string, sinceExecutionId?: string) =>
    [
      ...specKeys.detail(projectName, slug),
      "delta",
      ...(sinceExecutionId === undefined
        ? []
        : (["since", sinceExecutionId] as const)),
    ] as const,
  deliveryReview: (projectName: string, slug: string, executionId?: string) =>
    [
      ...specKeys.detail(projectName, slug),
      "delivery-review",
      executionId ?? "current",
    ] as const,
  planReview: (projectName: string, slug: string) =>
    [...specKeys.detail(projectName, slug), "plan-review"] as const,
  planPreview: (
    projectName: string,
    slug: string,
    stage: "draft" | "approved",
    expectedDraftRevision?: number,
  ) =>
    [
      ...specKeys.detail(projectName, slug),
      "plan-preview",
      stage,
      ...(expectedDraftRevision === undefined
        ? []
        : (["draft-revision", expectedDraftRevision] as const)),
    ] as const,
  planDiff: (
    projectName: string,
    slug: string,
    fromSnapshotId: string,
    toSnapshotId: string,
  ) =>
    [
      ...specKeys.detail(projectName, slug),
      "plan-diff",
      fromSnapshotId,
      toSnapshotId,
    ] as const,
  integrity: (projectName: string, slug: string) =>
    [...specKeys.detail(projectName, slug), "integrity"] as const,
  search: (projectName: string, slug: string, query: string) =>
    [...specKeys.detail(projectName, slug), "search", query] as const,
} as const;
