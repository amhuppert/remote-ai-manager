/** The run page of a session, with a run selected when one is named, open at a context when one is named. */
export function runsPageHref(
  projectName: string,
  sessionName: string,
  runId?: string,
  contextKey?: string,
): string {
  const base = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/runs`;
  if (runId === undefined) return base;
  const run = `${base}?run=${encodeURIComponent(runId)}`;
  return contextKey === undefined
    ? run
    : `${run}&context=${encodeURIComponent(contextKey)}`;
}
