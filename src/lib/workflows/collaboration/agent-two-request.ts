import { backendSupportsFastMode } from "@/lib/agent-backends/catalog";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { parseAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  collaborationAgentTwoRequestSchema,
  type CollaborationAgentTwoRequest,
} from "@/lib/workflows/collaboration/types";

export interface AgentTwoStartRequestDraft {
  backend: AgentBackendId;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  profile?: string;
}

/**
 * Convert Agent Two's visible draft to the collaboration start boundary.
 * Invalid runtime choices degrade to a backend-only request so the server can
 * resolve current defaults instead of rejecting the entire collaboration.
 */
export function buildAgentTwoStartRequest(
  draft: AgentTwoStartRequestDraft,
): CollaborationAgentTwoRequest | null {
  const parsedProfile =
    draft.profile === undefined ? null : parseAgentProfileRef(draft.profile);
  const profileRef =
    parsedProfile?.ok === true &&
    !(
      parsedProfile.ref.tier === "builtin" &&
      parsedProfile.ref.id === STANDARD_AGENT_PROFILE_ID
    )
      ? parsedProfile.ref
      : null;
  const candidate = {
    backend: draft.backend,
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.effort !== undefined ? { reasoningEffort: draft.effort } : {}),
    ...(backendSupportsFastMode(draft.backend) && draft.fastMode !== undefined
      ? { fastMode: draft.fastMode }
      : {}),
    ...(profileRef !== null ? { profile: profileRef } : {}),
  };
  const parsed = collaborationAgentTwoRequestSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  const fallback = collaborationAgentTwoRequestSchema.safeParse({
    backend: draft.backend,
    ...(profileRef !== null ? { profile: profileRef } : {}),
  });
  return fallback.success ? fallback.data : null;
}
