/** Runs are read per session (its list, and each run's page), and across sessions (the current ones). */
export const runKeys = {
  all: ["runs"] as const,
  // An object segment, so no project's name can share its prefix.
  active: () => [...runKeys.all, { scope: "active" }] as const,
  session: (projectName: string, sessionName: string) =>
    [...runKeys.all, projectName, sessionName] as const,
  list: (projectName: string, sessionName: string) =>
    [...runKeys.session(projectName, sessionName), "list"] as const,
  pages: (projectName: string, sessionName: string) =>
    [...runKeys.session(projectName, sessionName), "page"] as const,
  page: (projectName: string, sessionName: string, runId: string) =>
    [...runKeys.pages(projectName, sessionName), runId] as const,
} as const;
