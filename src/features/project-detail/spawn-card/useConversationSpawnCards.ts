"use client";

import { useMemo } from "react";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import {
  noopRenderSpawnCardRow,
  type RenderSpawnCardRow,
  type SpawnCardRowData,
} from "@/features/project-detail/cockpit/spawn-card-slot";
import {
  deriveSpawnCards,
  selectSpawnedSessionStatuses,
} from "./derive-spawn-cards";
import { createSpawnCardRenderer } from "./render-spawn-card-row";

export interface UseConversationSpawnCardsInput {
  projectName: string;
  /** Active conversation; null when no tab is focused. */
  conversationId: string | null;
  /** The active conversation's transcript messages (proposals live here). */
  messages: readonly TranscriptMessage[];
  /** Sessions signal — used to resolve passive spawned-session status. */
  sessions: readonly SessionListItem[];
  backendDefaults: BackendSelectionDefaultsById;
}

export interface ConversationSpawnCards {
  spawnCards: SpawnCardRowData[];
  renderSpawnCardRow: RenderSpawnCardRow;
}

/**
 * Bridge between chat-session-spawning and the cockpit transcript mount: scans
 * the active conversation's transcript for agent-emitted spawn proposals and
 * returns the interleave rows plus the renderer the transcript host calls for
 * each. The renderer resolves a row's proposal to its validated form and reads
 * the conversation's spawned-session status (passive). When no tab is focused
 * it degrades to the no-op renderer so the host renders an unchanged transcript.
 */
export function useConversationSpawnCards({
  projectName,
  conversationId,
  messages,
  sessions,
  backendDefaults,
}: UseConversationSpawnCardsInput): ConversationSpawnCards {
  const { spawnCards, validations } = useMemo(
    () => deriveSpawnCards(messages),
    [messages],
  );

  const statuses = useMemo(
    () => selectSpawnedSessionStatuses(sessions, conversationId),
    [sessions, conversationId],
  );

  const renderSpawnCardRow = useMemo<RenderSpawnCardRow>(() => {
    if (conversationId === null) return noopRenderSpawnCardRow;
    return createSpawnCardRenderer({
      projectName,
      conversationId,
      backendDefaults,
      resolveProposal: (proposalId) => validations.get(proposalId),
      resolveStatuses: () => statuses,
    });
  }, [projectName, conversationId, backendDefaults, validations, statuses]);

  return { spawnCards, renderSpawnCardRow };
}
