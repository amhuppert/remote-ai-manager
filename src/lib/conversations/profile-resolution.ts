/**
 * What profile a NEW conversation is created under.
 *
 * Every construction site — session conversations, project conversations,
 * kickoff and quick-ticket flows, planner and lane conversations — asks this
 * module rather than reaching for the library and the composer itself, so
 * "omitting a selection means the Standard Agent" is one answer instead of one
 * per creation path (R7). The result is the snapshot the site persists BEFORE
 * any provider runtime exists (R6).
 *
 * Resolution fails closed: an unknown, deleted, or quarantined reference raises
 * rather than silently degrading to the default. A conversation created under a
 * profile nobody selected would carry a snapshot that is a false record of the
 * invocation, which is exactly what the snapshot exists to prevent.
 */

import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import type {
  AgentProfileRef,
  AgentProfileSnapshot,
  ResolvedAgentProfile,
} from "@/lib/agent-profiles/schemas";

/**
 * The profile a creation path uses when the caller names none.
 *
 * A qualified reference, not a null: the default is a profile a user can see,
 * change, and read the instructions of, so there is no nullable "no profile"
 * state for new work to fall into (R7).
 */
export const DEFAULT_CONVERSATION_PROFILE_REF: AgentProfileRef = Object.freeze({
  tier: "builtin",
  id: STANDARD_AGENT_PROFILE_ID,
});

export interface ConversationProfileResolutionDeps {
  resolveProfile(
    projectPath: string,
    ref: AgentProfileRef,
  ): Promise<ResolvedAgentProfile>;
}

let defaultDeps: ConversationProfileResolutionDeps | null = null;

function getDefaultDeps(): ConversationProfileResolutionDeps {
  defaultDeps ??= {
    resolveProfile: (projectPath, ref) =>
      createAgentProfileLibraryService().resolve(projectPath, ref),
  };
  return defaultDeps;
}

/**
 * Resolve `ref` (or the Standard Agent default) and compose its block into the
 * snapshot a new conversation persists.
 *
 * Callers must run this OUTSIDE any write-queue critical section: it reads the
 * library from disk for the user-authored tiers.
 */
export async function resolveConversationProfileSnapshot(
  projectPath: string,
  ref?: AgentProfileRef | null,
  deps: ConversationProfileResolutionDeps = getDefaultDeps(),
): Promise<AgentProfileSnapshot> {
  const resolved = await deps.resolveProfile(
    projectPath,
    ref ?? DEFAULT_CONVERSATION_PROFILE_REF,
  );
  return buildAgentProfileSnapshot(resolved);
}
