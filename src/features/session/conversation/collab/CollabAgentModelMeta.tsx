"use client";

import { EffortLabel } from "@/components/conversation/EffortLabel";
import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
} from "@/lib/workflows/collaboration/types";

/** Display names for the two collaboration backends, shared by every card. */
export const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

export interface CollabAgentModelMetaProps {
  settings?: CollaborationAgentModelSettings;
}

/**
 * The `· model · effort` suffix rendered inside a card's agent label,
 * mirroring the metadata MessageRow shows next to regular agent messages.
 * Renders nothing when the run predates per-lane model settings.
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
    </span>
  );
}
