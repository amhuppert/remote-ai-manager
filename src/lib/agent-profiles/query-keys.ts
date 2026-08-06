import type { AgentProfileTier } from "./schemas";

/**
 * Library query keys, split by the scope the route tree is addressed by so a
 * project-tier change invalidates one project's queries and a global-tier
 * change invalidates them all (D25).
 */
export const agentProfileKeys = {
  all: ["agent-profiles"] as const,
  lists: () => [...agentProfileKeys.all, "list"] as const,
  globalList: () => [...agentProfileKeys.lists(), "global"] as const,
  projectList: (projectName: string) =>
    [...agentProfileKeys.lists(), "project", projectName] as const,
  details: () => [...agentProfileKeys.all, "detail"] as const,
  globalDetail: (tier: AgentProfileTier, id: string) =>
    [...agentProfileKeys.details(), "global", tier, id] as const,
  /** Nested under the project so one prefix invalidates that project only. */
  projectScope: (projectName: string) =>
    [...agentProfileKeys.details(), "project", projectName] as const,
  projectDetail: (projectName: string, tier: AgentProfileTier, id: string) =>
    [...agentProfileKeys.projectScope(projectName), tier, id] as const,
  /**
   * Nested under the project's detail scope so a library change in that project
   * invalidates any open preview with it — a preview of a record that has since
   * changed revision would confirm the wrong `expectedRevision`.
   */
  projectDeletionPreview: (
    projectName: string,
    tier: AgentProfileTier,
    id: string,
  ) =>
    [
      ...agentProfileKeys.projectDetail(projectName, tier, id),
      "deletion-preview",
    ] as const,
} as const;

/**
 * The project name for a library-change event's `projectPath`.
 *
 * The event carries the durable path (D25) while query keys carry the name the
 * routes are addressed by, and the two are the same identity seen from two
 * sides: the resolver builds a project path as `join(baseDir, projectName)`, so
 * the trailing segment IS the name. Returns null when there is no trailing
 * segment to read, which callers treat as "invalidate everything" — a stale
 * library is worse than a redundant refetch.
 */
export function agentProfileProjectNameFromPath(
  projectPath: string,
): string | null {
  const segments = projectPath.split(/[/\\]/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? null;
}
