import {
  findBuiltinAgentProfile,
  STANDARD_AGENT_PROFILE_ID,
} from "@/lib/agent-profiles/builtins";
import {
  formatAgentProfileRef,
  parseAgentProfileRef,
  type AgentProfileAudience,
  type AgentProfileLibraryItem,
  type AgentProfileRef,
  type AgentProfileTier,
} from "@/lib/agent-profiles/schemas";
import { agentProfileTierPresentation } from "./agent-profile-tier";

/**
 * What the shared profile picker offers and what it says about a choice.
 *
 * Kept apart from the component because both rules it encodes are contracts
 * rather than presentation: the Standard Agent is an explicit selectable
 * default that exists before any listing arrives (R7 — there is no nullable
 * "no profile" path), and `recommendedFor` is advisory, so a mismatch produces
 * a sentence and never a disabled option (R10.2).
 */

/** The default every creation path falls back to when the author picks nothing. */
export const STANDARD_AGENT_PROFILE_REF: AgentProfileRef = Object.freeze({
  tier: "builtin",
  id: STANDARD_AGENT_PROFILE_ID,
});

/** The compact spelling a `Select` stores for the default option. */
export const STANDARD_AGENT_PROFILE_VALUE = formatAgentProfileRef(
  STANDARD_AGENT_PROFILE_REF,
);

export interface AgentProfilePickerOption {
  /** `tier:id` — the select's value, and what a text boundary would accept. */
  value: string;
  ref: AgentProfileRef;
  name: string;
  description: string;
  tier: AgentProfileTier;
  /** Advisory only; drives the warning sentence, never selectability. */
  recommendedFor: readonly AgentProfileAudience[];
  isStandardAgent: boolean;
}

export interface AgentProfilePickerGroup {
  tier: AgentProfileTier;
  label: string;
  options: AgentProfilePickerOption[];
}

/** Narrowest scope last, so a project's own profiles read as the local layer. */
const TIER_ORDER: readonly AgentProfileTier[] = [
  "builtin",
  "global",
  "project",
];

/**
 * The Standard Agent as an option, for the window before the listing resolves.
 *
 * Read from the built-in record, which is a shipped constant rather than
 * fetched data: the picker still has a complete default with nothing in hand,
 * and the option the listing later supplies says the same thing, so the
 * default's description cannot change under the author mid-query.
 */
const STANDARD_AGENT_FALLBACK: AgentProfilePickerOption = (() => {
  const standard = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);
  if (standard === undefined) {
    throw new Error("the standard-agent built-in is missing");
  }
  return {
    value: STANDARD_AGENT_PROFILE_VALUE,
    ref: STANDARD_AGENT_PROFILE_REF,
    name: standard.name,
    description: standard.description,
    tier: "builtin",
    recommendedFor: standard.recommendedFor,
    isStandardAgent: true,
  };
})();

function toOption(item: AgentProfileLibraryItem): AgentProfilePickerOption {
  return {
    value: formatAgentProfileRef(item.ref),
    ref: item.ref,
    name: item.name,
    description: item.description,
    tier: item.ref.tier,
    recommendedFor: item.recommendedFor,
    isStandardAgent:
      item.ref.tier === "builtin" && item.ref.id === STANDARD_AGENT_PROFILE_ID,
  };
}

/**
 * The picker's options, grouped by the tier each profile came from.
 *
 * The Standard Agent leads its group whether or not the listing has arrived:
 * the default has to be pickable during the query's pending state, and it is
 * the same option either way — the listing's own record replaces the fallback
 * rather than appending a second one.
 */
export function buildAgentProfilePickerGroups(
  profiles: readonly AgentProfileLibraryItem[],
): AgentProfilePickerGroup[] {
  const options = profiles.map(toOption);
  const listedStandard = options.find((option) => option.isStandardAgent);
  const standard = listedStandard ?? STANDARD_AGENT_FALLBACK;

  return TIER_ORDER.flatMap((tier) => {
    const tierOptions = options.filter(
      (option) => option.tier === tier && !option.isStandardAgent,
    );
    if (tier === "builtin") tierOptions.unshift(standard);
    if (tierOptions.length === 0) return [];
    return [
      {
        tier,
        label: agentProfileTierPresentation(tier).label,
        options: tierOptions,
      },
    ];
  });
}

/** How an audience reads in the advisory sentence. */
const AUDIENCE_LABEL: Record<AgentProfileAudience, string> = {
  conversation: "conversations",
  workflow_implementer: "workflow implementers",
  workflow_validator: "workflow validators",
};

/**
 * The advisory sentence for a selection outside its profile's recommendations,
 * or null when there is nothing to say.
 *
 * Null for an empty `recommendedFor`: an empty set states no recommendation, so
 * no choice can fall outside it, and warning anyway would train authors to
 * ignore the hint. Nothing here refuses — the caller renders this next to a
 * selection it has already accepted.
 */
export function agentProfileAdvisoryWarning(
  option: AgentProfilePickerOption | undefined,
  audience: AgentProfileAudience,
): string | null {
  if (option === undefined) return null;
  if (option.recommendedFor.length === 0) return null;
  if (option.recommendedFor.includes(audience)) return null;

  const recommended = option.recommendedFor
    .map((entry) => AUDIENCE_LABEL[entry])
    .join(" and ");
  return `${option.name} is recommended for ${recommended}, not ${AUDIENCE_LABEL[audience]}. You can still use it here.`;
}

/**
 * The reference behind a select value, or null when the value is not a
 * qualified reference. A bare id is refused rather than guessed at, for the
 * same reason `parseAgentProfileRef` refuses one: sibling tiers can hold the
 * same id.
 */
export function parseAgentProfilePickerValue(
  value: string,
): AgentProfileRef | null {
  const parsed = parseAgentProfileRef(value);
  return parsed.ok ? parsed.ref : null;
}

/** The option a value addresses, across every group. */
export function findAgentProfilePickerOption(
  groups: readonly AgentProfilePickerGroup[],
  value: string,
): AgentProfilePickerOption | undefined {
  for (const group of groups) {
    const found = group.options.find((option) => option.value === value);
    if (found !== undefined) return found;
  }
  return undefined;
}
