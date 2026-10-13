import type { RunTemplateTier } from "./schemas";

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

/** A session's run templates: the library, where one is launched. */
export function runTemplatesHref(
  projectName: string,
  sessionName: string,
): string {
  return `${runsPageHref(projectName, sessionName)}/templates`;
}

/** One run template's editor, from a session that can launch it. */
export function runTemplateHref(
  projectName: string,
  sessionName: string,
  tier: RunTemplateTier,
  id: string,
): string {
  return `${runTemplatesHref(projectName, sessionName)}/${tier}/${encodeURIComponent(id)}`;
}
