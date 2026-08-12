"use client";

import { EffortLabel } from "@/components/conversation/EffortLabel";
import { backendLabel } from "@/lib/agent-backends/catalog";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";

/** Display names for the two collaboration backends, shared by every card. */
export const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: backendLabel("claude"),
  codex: backendLabel("codex"),
};

/**
 * What the meta line can show for one lane. A structural subset of
 * `CollaborationResolvedAgent` so both the current per-flow-agent settings and
 * the legacy backend-keyed decode satisfy it.
 */
export interface CollabAgentMetaSettings {
  model: string;
  effort?: string;
  fastMode?: boolean;
  /** Name of the agent profile the lane is staffed with, when non-default. */
  profileName?: string;
}

export interface CollabAgentModelMetaProps {
  settings?: CollabAgentMetaSettings;
}

/**
 * The `· model · effort [· fast] [· profile]` suffix rendered inside a card's
 * agent label, mirroring the metadata MessageRow shows next to regular agent
 * messages. Renders nothing when the run predates per-lane model settings.
 */
export default function CollabAgentModelMeta({
  settings,
}: CollabAgentModelMetaProps): React.JSX.Element | null {
  if (!settings) return null;
  return (
    <span className="font-mono text-[0.7rem] font-medium tracking-[0.02em] normal-case">
      <span className="mx-[5px] text-text-tertiary">&middot;</span>
      <span className="text-text-secondary">{settings.model}</span>
      {settings.effort && (
        <>
          <span className="mx-[5px] text-text-tertiary">&middot;</span>
          <EffortLabel effort={settings.effort} />
        </>
      )}
      {settings.fastMode === true && (
        <>
          <span className="mx-[5px] text-text-tertiary">&middot;</span>
          <span className="text-text-secondary">fast</span>
        </>
      )}
      {settings.profileName !== undefined && (
        <>
          <span className="mx-[5px] text-text-tertiary">&middot;</span>
          <span className="text-text-secondary">{settings.profileName}</span>
        </>
      )}
    </span>
  );
}
