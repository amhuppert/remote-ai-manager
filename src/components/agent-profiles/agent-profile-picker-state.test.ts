/**
 * The picker's decisions, apart from its rendering: which options exist, which
 * one is the default, and when a selection earns an advisory warning.
 *
 * R7.1 makes the Standard Agent an explicit selectable option rather than an
 * empty state, and R10.2 makes `recommendedFor` advisory — a warning, never a
 * refusal — so both are pinned here where they can be asserted without a DOM.
 */

import { describe, expect, it } from "vitest";

import {
  findBuiltinAgentProfile,
  STANDARD_AGENT_PROFILE_ID,
} from "@/lib/agent-profiles/builtins";
import type { AgentProfileLibraryItem } from "@/lib/agent-profiles/schemas";

import { agentProfileTierPresentation } from "./agent-profile-tier";
import {
  STANDARD_AGENT_PROFILE_REF,
  STANDARD_AGENT_PROFILE_VALUE,
  agentProfileAdvisoryWarning,
  buildAgentProfilePickerGroups,
  parseAgentProfilePickerValue,
} from "./agent-profile-picker-state";

function item(
  overrides: Partial<AgentProfileLibraryItem> &
    Pick<AgentProfileLibraryItem, "ref">,
): AgentProfileLibraryItem {
  return {
    name: `Profile ${overrides.ref.id}`,
    description: `Description for ${overrides.ref.id}`,
    revision: 1,
    recommendedFor: [],
    tags: [],
    readOnly: overrides.ref.tier === "builtin",
    ...overrides,
  };
}

const STANDARD_AGENT_ITEM = item({
  ref: { tier: "builtin", id: "standard-agent" },
  name: "Standard Agent",
  recommendedFor: ["conversation"],
});

describe("buildAgentProfilePickerGroups", () => {
  it("offers the Standard Agent default before the library has loaded", () => {
    const groups = buildAgentProfilePickerGroups([]);

    const options = groups.flatMap((group) => group.options);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      value: STANDARD_AGENT_PROFILE_VALUE,
      name: "Standard Agent",
      isStandardAgent: true,
    });
    // A selectable default, not a nullable "no profile" state (R7).
    expect(options[0]?.ref).toEqual(STANDARD_AGENT_PROFILE_REF);
  });

  it("describes the pre-listing default exactly as the built-in record does", () => {
    const standard = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);
    if (standard === undefined) throw new Error("missing built-in");

    const fallback = buildAgentProfilePickerGroups([]).flatMap(
      (group) => group.options,
    )[0];

    // The listing's own record replaces this option when it arrives, so a
    // fallback that said something else would make the default's description
    // change under the author mid-query.
    expect(fallback?.name).toBe(standard.name);
    expect(fallback?.description).toBe(standard.description);
    expect(fallback?.recommendedFor).toEqual(standard.recommendedFor);
  });

  it("puts the Standard Agent first and never repeats it once the library lists it", () => {
    const groups = buildAgentProfilePickerGroups([
      item({ ref: { tier: "project", id: "house-style" } }),
      item({ ref: { tier: "builtin", id: "general-reviewer" } }),
      STANDARD_AGENT_ITEM,
      item({ ref: { tier: "global", id: "my-reviewer" } }),
    ]);

    const options = groups.flatMap((group) => group.options);
    expect(options[0]?.value).toBe(STANDARD_AGENT_PROFILE_VALUE);
    expect(
      options.filter((o) => o.value === STANDARD_AGENT_PROFILE_VALUE),
    ).toHaveLength(1);
    // Tiers are sibling scopes, so provenance travels with every option.
    expect(options.map((o) => o.value)).toEqual([
      "builtin:standard-agent",
      "builtin:general-reviewer",
      "global:my-reviewer",
      "project:house-style",
    ]);
  });

  it("groups by tier in builtin → global → project order and omits empty tiers", () => {
    const groups = buildAgentProfilePickerGroups([
      item({ ref: { tier: "project", id: "house-style" } }),
    ]);

    expect(groups.map((group) => group.tier)).toEqual(["builtin", "project"]);
    expect(groups.map((group) => group.label)).toEqual(["Built-in", "Project"]);
  });
});

describe("agentProfileAdvisoryWarning", () => {
  const forValidatorsOnly = buildAgentProfilePickerGroups([
    item({
      ref: { tier: "global", id: "security-reviewer" },
      name: "Security Reviewer",
      recommendedFor: ["workflow_validator"],
    }),
  ])
    .flatMap((group) => group.options)
    .find((option) => option.value === "global:security-reviewer");

  it("warns — advisory only — when the selection sits outside recommendedFor", () => {
    const warning = agentProfileAdvisoryWarning(
      forValidatorsOnly,
      "conversation",
    );

    expect(warning).not.toBeNull();
    expect(warning).toContain("Security Reviewer");
    // Advisory wording: it reports a mismatch, it does not forbid the choice.
    expect(warning?.toLowerCase()).not.toMatch(/cannot|not allowed|forbidden/);
  });

  it("stays silent when the audience is recommended", () => {
    const standard = buildAgentProfilePickerGroups([STANDARD_AGENT_ITEM])
      .flatMap((group) => group.options)
      .find((option) => option.value === STANDARD_AGENT_PROFILE_VALUE);

    expect(agentProfileAdvisoryWarning(standard, "conversation")).toBeNull();
  });

  it("stays silent when a profile recommends nobody in particular", () => {
    const unopinionated = buildAgentProfilePickerGroups([
      item({ ref: { tier: "global", id: "unopinionated" } }),
    ])
      .flatMap((group) => group.options)
      .find((option) => option.value === "global:unopinionated");

    // An empty set states no recommendation, so there is nothing to fall
    // outside of — warning on it would make the advisory hint noise.
    expect(
      agentProfileAdvisoryWarning(unopinionated, "conversation"),
    ).toBeNull();
  });

  it("stays silent for an option the listing has not produced yet", () => {
    expect(agentProfileAdvisoryWarning(undefined, "conversation")).toBeNull();
  });
});

describe("parseAgentProfilePickerValue", () => {
  it("round-trips the compact spelling the select stores", () => {
    expect(parseAgentProfilePickerValue("project:house-style")).toEqual({
      tier: "project",
      id: "house-style",
    });
    expect(parseAgentProfilePickerValue(STANDARD_AGENT_PROFILE_VALUE)).toEqual(
      STANDARD_AGENT_PROFILE_REF,
    );
  });

  it("refuses an unqualified value rather than guessing a tier", () => {
    expect(parseAgentProfilePickerValue("house-style")).toBeNull();
  });
});

describe("agentProfileTierPresentation", () => {
  it("names each tier for its provenance badge", () => {
    expect(agentProfileTierPresentation("builtin")).toEqual({
      label: "Built-in",
      tone: "neutral",
    });
    expect(agentProfileTierPresentation("global")).toEqual({
      label: "Global",
      tone: "cyan",
    });
    expect(agentProfileTierPresentation("project")).toEqual({
      label: "Project",
      tone: "violet",
    });
  });
});
