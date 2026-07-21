import type { ReactNode } from "react";
import type { ProposalValidation } from "@/lib/chat-spawning/proposal-validator";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import type {
  RenderSpawnCardRow,
  SpawnCardRowData,
} from "@/features/project-detail/cockpit/spawn-card-slot";
import SpawnCard, { type SpawnedSessionStatus } from "./SpawnCard";

export interface SpawnCardRendererContext {
  projectName: string;
  conversationId: string;
  backendDefaults: BackendSelectionDefaultsById;
  /** Resolve the validated proposal for a spawn-card row's opaque proposalId. */
  resolveProposal(proposalId: string): ProposalValidation | undefined;
  /** Live status of the linked sessions for a proposalId (passive tracking). */
  resolveStatuses?: (proposalId: string) => SpawnedSessionStatus[] | undefined;
}

/**
 * Build the `renderSpawnCardRow` slot the cockpit transcript host calls for each
 * `spawn-card` row. The row payload is opaque beyond `proposalId`; this factory
 * resolves the proposal (and live status) from the surrounding conversation
 * context and renders the inline card. Returns nothing when the proposal can't
 * be resolved, so a stale row degrades gracefully.
 */
export function createSpawnCardRenderer(
  ctx: SpawnCardRendererContext,
): RenderSpawnCardRow {
  return function renderSpawnCardRow(row: SpawnCardRowData): ReactNode {
    const validation = ctx.resolveProposal(row.proposalId);
    if (validation === undefined) return null;
    return (
      <SpawnCard
        validation={validation}
        projectName={ctx.projectName}
        conversationId={ctx.conversationId}
        backendDefaults={ctx.backendDefaults}
        spawnedStatuses={ctx.resolveStatuses?.(row.proposalId)}
      />
    );
  };
}
