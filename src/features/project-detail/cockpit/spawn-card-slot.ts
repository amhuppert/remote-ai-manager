import type { ReactNode } from "react";

/**
 * The transcript mount contract for chat-session-spawning's inline cards.
 *
 * This spec owns the *row variant* and the *render slot*, not the card body.
 * The payload is deliberately opaque beyond `proposalId` (stable key) and
 * `anchorMessageIndex` (where to interleave): chat-session-spawning can evolve
 * the card's internals freely without touching the transcript host.
 */
export interface SpawnCardRowData {
  kind: "spawn-card";
  /** Stable key; opaque to this spec. */
  proposalId: string;
  /** Transcript message index after which the card is interleaved. */
  anchorMessageIndex: number;
}

/**
 * Renderer supplied by chat-session-spawning. The cockpit calls it for each
 * spawn-card row; the default (`noopRenderSpawnCardRow`) renders nothing so the
 * page ships before spawning lands.
 */
export type RenderSpawnCardRow = (row: SpawnCardRowData) => ReactNode;

export const noopRenderSpawnCardRow: RenderSpawnCardRow = () => null;
