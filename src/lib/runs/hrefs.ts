/** The run page of a session, with a run selected when one is named. */
export function runsPageHref(
  projectName: string,
  sessionName: string,
  runId?: string,
): string {
  const base = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/runs`;
  return runId === undefined
    ? base
    : `${base}?run=${encodeURIComponent(runId)}`;
}
