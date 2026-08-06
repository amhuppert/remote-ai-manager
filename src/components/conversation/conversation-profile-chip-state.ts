import {
  agentProfileTierPresentation,
  type AgentProfileTierPresentation,
} from "@/components/agent-profiles/agent-profile-tier";
import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type {
  AgentProfileTier,
  RedactedAgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";

/**
 * What the conversation's profile chip shows.
 *
 * `legacy` is the state of every conversation created before the agent profile
 * library — they are not backfilled (D27), so "no profile" is a permanent and
 * truthful reading of them, not a loading state. Keeping it an explicit variant
 * rather than a null chip is what makes R6.5's "displays as legacy/no-profile"
 * something the UI states rather than omits.
 */
export type ConversationProfileChipState =
  | { kind: "legacy" }
  | {
      kind: "profile";
      name: string;
      /**
       * Which scope the profile came from. Rendered, not just recorded: tiers
       * are sibling scopes, so `project:reviewer` and `global:reviewer` are
       * different profiles and a name alone does not identify the one running
       * (R8.2).
       */
      tier: AgentProfileTier;
      /** Compact `tier:id` spelling. */
      ref: string;
      revision: number;
    };

export function deriveConversationProfileChipState(
  redactedProfileSnapshot: RedactedAgentProfileSnapshot | null | undefined,
): ConversationProfileChipState {
  if (redactedProfileSnapshot == null) return { kind: "legacy" };
  return {
    kind: "profile",
    name: redactedProfileSnapshot.name,
    tier: redactedProfileSnapshot.tier,
    ref: formatAgentProfileRef({
      tier: redactedProfileSnapshot.tier,
      id: redactedProfileSnapshot.id,
    }),
    revision: redactedProfileSnapshot.revision,
  };
}

export function conversationProfileChipLabel(
  state: ConversationProfileChipState,
): string {
  return state.kind === "legacy" ? "No profile" : state.name;
}

/** The scope badge beside the name; null when there is no profile to place. */
export function conversationProfileChipTier(
  state: ConversationProfileChipState,
): AgentProfileTierPresentation | null {
  return state.kind === "legacy"
    ? null
    : agentProfileTierPresentation(state.tier);
}

/** Hover/assistive detail: which library record, at which revision. */
export function conversationProfileChipDetail(
  state: ConversationProfileChipState,
): string {
  return state.kind === "legacy"
    ? "This conversation started before agent profiles; it runs with no profile."
    : `Agent profile ${state.ref}, revision ${state.revision}`;
}
