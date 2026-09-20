import { backendToneToken } from "@/lib/agent-backends/catalog";
import type {
  CollaborationAgent,
  CollaborationResolutionDecisionNextAction,
} from "@/lib/workflows/collaboration/types";

/**
 * Shared Tailwind class recipes for the collab artifact-card chrome — the
 * header (agent / eyebrow / round / primary-flag / verdict / summary) and body
 * (section / section-title / list / narrative) pieces that the cards composing
 * `CollabCollapsibleCard` render. Centralized so every card emits identical
 * migrated chrome. Migrated 1:1 from the `.collab-artifact-card-*` family that
 * formerly lived in `conversation.css`.
 *
 * Agent identity colours key on the catalog's design-system tone token via a
 * `data-tone` attribute (`collabAgentTone`), never on the backend id: the
 * catalog owns which backend maps to which tone, and a participant added to the
 * collaboration policy needs no card edits as long as its tone is one of the
 * three the design system defines. A closed allowlist because Tailwind cannot
 * generate a class from a runtime token. `cardVerdict` keeps a static map: its
 * `next-action` values include underscores, which Tailwind rewrites to spaces
 * inside `data-[…]`.
 */

/** The catalog tone a collaboration agent's cards render under. */
export function collabAgentTone(agent: CollaborationAgent): string {
  return backendToneToken(agent);
}

export const cardAgent =
  "font-mono text-[0.78rem] font-semibold uppercase tracking-[0.04em] data-[tone=cyan]:text-cyan data-[tone=violet]:text-violet data-[tone=amber]:text-amber";

/** The 3px identity rail every artifact card and pending card carries. */
export const cardRail =
  "border-l-[3px] data-[tone=cyan]:border-l-cyan data-[tone=violet]:border-l-violet data-[tone=amber]:border-l-amber";

export const cardEyebrow =
  "font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-text-secondary";

export const cardPrimaryFlag =
  "font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.08em] uppercase px-[6px] py-[1px] rounded-sm bg-cyan-glow text-cyan";

export const cardRound =
  "font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.08em] uppercase px-[6px] py-[1px] rounded-sm bg-bg-base text-text-secondary";

export const cardVerdict =
  "font-mono text-[0.72rem] font-bold tracking-[0.06em] uppercase px-[8px] py-[1px] rounded-sm";

export const cardVerdictColor: Record<
  CollaborationResolutionDecisionNextAction,
  string
> = {
  final: "bg-green-glow text-green",
  continue_negotiation: "bg-cyan-glow text-cyan",
  ask_user: "bg-amber-glow text-amber",
  fail: "bg-red-glow text-red",
};

export const cardSummary =
  "font-mono text-[0.7rem] text-text-tertiary ml-auto overflow-hidden text-ellipsis whitespace-nowrap max-768:ml-0 max-768:basis-full max-768:text-left";

export const cardSection = "flex flex-col gap-[6px]";

export const cardSectionTitle =
  "m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-text-secondary";

export const cardList =
  "m-0 flex flex-col gap-[4px] pl-md text-[0.82rem] leading-[1.5] text-text-primary";

export const cardNarrative =
  "m-0 text-[0.85rem] leading-[1.55] text-text-primary";

// id pill list (CounterProposal accepted/rejected ids, OpenConflicts disagreement
// ids). The legacy `[data-tone=accepted|rejected]` recolor rules were dead (no
// call site set data-tone), so only the neutral item recipe survives.
export const idList = "m-0 flex list-none flex-wrap gap-[4px] p-0";
export const idListItem =
  "rounded-sm border border-solid border-border-subtle bg-bg-base px-[6px] py-[1px] font-mono text-[length:var(--font-size-floor)] text-text-secondary";

// change list (Proposed / Counter-proposal change items).
export const changeList = "m-0 flex list-none flex-col gap-[6px] p-0";
export const changeListItem =
  "flex flex-col gap-[2px] rounded-sm border border-solid border-border-subtle bg-bg-base px-sm py-[6px]";
export const changeListId =
  "font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.06em] text-text-tertiary";
export const changeListChange = "text-[0.82rem] font-medium text-text-primary";
export const changeListRationale = "text-[0.78rem] italic text-text-secondary";
export const changeListAddresses =
  "flex flex-wrap gap-[4px] font-mono text-[length:var(--font-size-floor)] text-text-tertiary";
export const changeListAddressesLabel = "uppercase tracking-[0.06em]";
export const changeListAddressesId =
  "rounded-sm bg-bg-raised px-[5px] py-[1px] text-cyan-dim";
