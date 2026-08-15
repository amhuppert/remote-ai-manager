/**
 * The one address for a graph-workflow execution (D7): the session workflow
 * page with the run selected. Current and History runs address identically —
 * selection is by execution id, never by storage location — so a refusal, a
 * launch receipt, and a recorded result can all hand back the same link and it
 * keeps resolving after the run leaves Current.
 *
 * Pure string building with no route import, so a server payload and a client
 * renderer produce the same link.
 */
export function buildGraphWorkflowExecutionDeepLink(input: {
  projectName: string;
  sessionName: string;
  executionId: string;
}): string {
  const session = `/projects/${encodeURIComponent(input.projectName)}/${encodeURIComponent(input.sessionName)}`;
  return `${session}/workflow?execution=${encodeURIComponent(input.executionId)}`;
}
