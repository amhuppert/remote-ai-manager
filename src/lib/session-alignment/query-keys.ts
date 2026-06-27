export const alignmentKeys = {
  all: ["session-alignment"] as const,
  states: () => [...alignmentKeys.all, "state"] as const,
  state: (projectName: string, sessionName: string) =>
    [...alignmentKeys.states(), projectName, sessionName] as const,
  diffs: () => [...alignmentKeys.all, "diff"] as const,
  diff: (projectName: string, sessionName: string, from: number, to: number) =>
    [...alignmentKeys.diffs(), projectName, sessionName, from, to] as const,
};
