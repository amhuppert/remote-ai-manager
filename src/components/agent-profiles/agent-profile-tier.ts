import type { StatusChipTone } from "@/components/ui/StatusChip";
import type { AgentProfileTier } from "@/lib/agent-profiles/schemas";

/**
 * How a tier reads wherever provenance is shown — the picker's option badges,
 * the management page's scoped listing, and the conversation header.
 *
 * One source rather than a label per surface: tiers are sibling scopes, so the
 * tier is half of a profile's identity, and two surfaces disagreeing on what to
 * call `global` would make the same profile look like two.
 */
export interface AgentProfileTierPresentation {
  label: string;
  tone: StatusChipTone;
}

export function agentProfileTierPresentation(
  tier: AgentProfileTier,
): AgentProfileTierPresentation {
  switch (tier) {
    case "builtin":
      return { label: "Built-in", tone: "neutral" };
    case "global":
      return { label: "Global", tone: "cyan" };
    case "project":
      return { label: "Project", tone: "violet" };
  }
}
