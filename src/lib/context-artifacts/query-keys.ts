/**
 * Query keys for context-artifact caches. Artifacts exist on two conversation
 * scopes (design docs/design/conversation-compaction/README.md §12.3), so keys
 * are derived from a scope-discriminated target rather than positional args —
 * queries, mutations, and the SSE cache reconciler all share one identity
 * shape.
 */
export type ContextArtifactTarget =
  | {
      scope: "session";
      projectName: string;
      sessionName: string;
      conversationId: string;
    }
  | { scope: "project"; projectName: string; conversationId: string };

export const contextArtifactKeys = {
  all: ["context-artifacts"] as const,
  conversation: (target: ContextArtifactTarget) =>
    target.scope === "session"
      ? ([
          ...contextArtifactKeys.all,
          "session",
          target.projectName,
          target.sessionName,
          target.conversationId,
        ] as const)
      : ([
          ...contextArtifactKeys.all,
          "project",
          target.projectName,
          target.conversationId,
        ] as const),
  list: (target: ContextArtifactTarget) =>
    [...contextArtifactKeys.conversation(target), "list"] as const,
  detail: (target: ContextArtifactTarget, artifactId: string) =>
    [
      ...contextArtifactKeys.conversation(target),
      "detail",
      artifactId,
    ] as const,
};
