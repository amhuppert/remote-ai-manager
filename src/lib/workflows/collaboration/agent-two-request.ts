import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { parseAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  collaborationAgentTwoRequestSchema,
  type CollaborationAgentTwoRequest,
} from "@/lib/workflows/collaboration/types";

export interface AgentTwoStartRequestDraft {
  backend: AgentBackendId;
  modelSelection?: BackendModelSelection;
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
    ...(draft.modelSelection !== undefined
      ? { modelSelection: draft.modelSelection }
      : {}),
    ...(profileRef !== null ? { profile: profileRef } : {}),
  };
  const parsed = collaborationAgentTwoRequestSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  if (draft.modelSelection !== undefined) return null;

  const fallback = collaborationAgentTwoRequestSchema.safeParse({
    backend: draft.backend,
    ...(profileRef !== null ? { profile: profileRef } : {}),
  });
  return fallback.success ? fallback.data : null;
}
