"use client";

import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { useSendProjectPrompt } from "@/lib/project-conversations-client/mutations";
import type { FilterToken } from "../components/filter-tokens";
import UnifiedComposer from "../composer/UnifiedComposer";
import SessionsPanel from "./SessionsPanel";
import "./styles/cockpit.css";

export interface ProjectFirstRunProps {
  projectName: string;
  sessions: SessionListItem[];
  archivedCount: number;
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  onRunCommand: (id: "new" | "capabilities" | "workflow-builder") => void;
  selectedBackend: AgentBackendId;
  onSelectedBackendChange: (next: AgentBackendId) => void;
  onBranch?: (sessionName: string) => void;
}

/**
 * First-run single-column layout: the unified composer above the full-width
 * sessions table — no hero, no starter buttons; the composer placeholder and a
 * one-line hint carry the affordance. Sending a plain prompt issues a
 * create-and-send (conversationId: null) so the foundation creates the first
 * project conversation, which crosses the open-count to ≥1 and flips the page
 * into the cockpit.
 */
export default function ProjectFirstRun({
  projectName,
  sessions,
  archivedCount,
  tokens,
  onTokensChange,
  onRunCommand,
  selectedBackend,
  onSelectedBackendChange,
  onBranch,
}: ProjectFirstRunProps): React.JSX.Element {
  const sender = useSendProjectPrompt(projectName);

  return (
    <div className="plc-firstrun">
      <UnifiedComposer
        projectName={projectName}
        activeConversationId={null}
        activeConversation={undefined}
        agentBackend={selectedBackend}
        onAgentChange={onSelectedBackendChange}
        tokens={tokens}
        onTokensChange={onTokensChange}
        sessions={sessions}
        archivedCount={archivedCount}
        busy={sender.sending}
        error={sender.error}
        onDismissError={sender.clearError}
        onRunCommand={onRunCommand}
        onSendPrompt={(input) =>
          void sender.send({
            conversationId: null,
            text: input.text,
            images: input.images,
            backend: input.backend,
            modelId: input.modelId,
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
          })
        }
      />
      <SessionsPanel
        projectName={projectName}
        sessions={sessions}
        tokens={tokens}
        onTokensChange={onTokensChange}
        {...(onBranch ? { onBranch } : {})}
      />
    </div>
  );
}
