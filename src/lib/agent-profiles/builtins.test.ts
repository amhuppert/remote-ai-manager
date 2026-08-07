import { describe, it, expect } from "vitest";

import {
  BUILTIN_AGENT_PROFILES,
  STANDARD_AGENT_PROFILE_ID,
  findBuiltinAgentProfile,
} from "./builtins";
import {
  agentProfileSchema,
  assertMutableProfileTier,
  AgentProfileTierReadOnlyError,
} from "./schemas";
import {
  composeProfileBlock,
  findReservedSequence,
  PROFILE_BLOCK_BEGIN,
} from "./composer";
import { computeContentHash } from "./hashing";

const EXPECTED_IDS = [
  "standard-agent",
  "general-implementer",
  "general-reviewer",
  "security-reviewer",
  "type-api-contract-reviewer",
  "test-reliability-reviewer",
];

/** The reviewers whose lens reaches past any one context's acceptance criteria. */
const SPECIALIST_REVIEWER_IDS = [
  "security-reviewer",
  "type-api-contract-reviewer",
  "test-reliability-reviewer",
];

/**
 * The advisory item's `kind` values, as the validator output schema defines
 * them. Restated rather than imported: `agent-profiles` never depends on
 * `workflow-graph`, and the point of the assertion is that the shipped prose
 * names the enum members a validator's structured output must actually carry —
 * a profile steering an agent toward some other word would fail the gate.
 */
const ADVISORY_KINDS = ["implementation", "plan", "out_of_scope"];

/**
 * Text that would presume a blocking channel. A specialist profile is legal on
 * either authority, and an advisory seat's verdict schema has no `issues` field
 * and no way to reopen anything — so a profile naming one would be instructing
 * output the seat cannot emit.
 */
const BLOCKING_CHANNEL_PRESUMPTIONS = [
  /`issues`/,
  /\breopen\b/i,
  /\bfail(?:ing)? (?:the|this) context\b/i,
];

describe("built-in agent profiles (R3.1)", () => {
  it("ships exactly the curated set", () => {
    expect([...BUILTIN_AGENT_PROFILES].map((p) => p.id).sort()).toEqual(
      [...EXPECTED_IDS].sort(),
    );
  });

  it("parses every built-in through the profile schema", () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      const result = agentProfileSchema.safeParse(profile);
      expect(
        result.success,
        `${profile.id} must satisfy the profile schema: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
      ).toBe(true);
      expect(result.success && result.data).toEqual(profile);
    }
  });

  it("gives every built-in a distinct id, a display name, and a discovery description", () => {
    const ids = BUILTIN_AGENT_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const profile of BUILTIN_AGENT_PROFILES) {
      expect(profile.name.trim().length, profile.id).toBeGreaterThan(0);
      // Planning agents staff assignments by reading these descriptions, so a
      // placeholder description would be a silent staffing failure.
      expect(profile.description.trim().length, profile.id).toBeGreaterThan(30);
      expect(profile.revision, profile.id).toBe(1);
    }
  });

  it("ships standard-agent with empty instructions — the no-op default", () => {
    const standard = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);

    expect(standard).toBeDefined();
    expect(standard?.instructions).toBe("");
    expect(agentProfileSchema.safeParse(standard).success).toBe(true);
  });

  it("keeps the no-op default's identity: name, description, audiences, tags", () => {
    const standard = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);

    expect(standard?.name).toBe("Standard Agent");
    expect(standard?.description.trim().length ?? 0).toBeGreaterThan(30);
    expect(standard?.recommendedFor).toContain("conversation");
    expect(standard?.tags).toContain("default");
  });

  it("gives every specialized built-in explicit instructions", () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      if (profile.id === STANDARD_AGENT_PROFILE_ID) continue;
      expect(profile.instructions.trim().length, profile.id).toBeGreaterThan(0);
    }
  });

  it("recommends each reviewer profile to workflow validators", () => {
    for (const id of [
      "general-reviewer",
      "security-reviewer",
      "type-api-contract-reviewer",
      "test-reliability-reviewer",
    ]) {
      expect(findBuiltinAgentProfile(id)?.recommendedFor, id).toContain(
        "workflow_validator",
      );
    }
    expect(
      findBuiltinAgentProfile("general-implementer")?.recommendedFor,
    ).toContain("workflow_implementer");
  });

  it("renders every built-in through the composer without a reserved-sequence collision", () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      expect(findReservedSequence(profile.instructions), profile.id).toBeNull();

      const { block, resolvedInstructionHash } = composeProfileBlock({
        tier: "builtin",
        id: profile.id,
        name: profile.name,
        revision: profile.revision,
        sourceContentHash: computeContentHash(profile.instructions),
        instructions: profile.instructions,
      });

      if (profile.id === STANDARD_AGENT_PROFILE_ID) {
        // The no-op default composes to nothing at all — see the empty-content
        // rule in composer.test.ts.
        expect(block).toBe("");
      } else {
        expect(block, profile.id).toContain(profile.instructions);
        expect(block, profile.id).toContain(PROFILE_BLOCK_BEGIN);
      }
      expect(resolvedInstructionHash).toBe(computeContentHash(block));
    }
  });

  it("looks a built-in up by id and reports an unknown id as missing", () => {
    expect(findBuiltinAgentProfile("security-reviewer")?.name).toBe(
      "Security Reviewer",
    );
    expect(findBuiltinAgentProfile("does-not-exist")).toBeUndefined();
  });

  it("refuses every mutation of a builtin-tier profile with a typed error", () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      for (const operation of ["create", "update", "delete"] as const) {
        expect(
          () =>
            assertMutableProfileTier(
              { tier: "builtin", id: profile.id },
              operation,
            ),
          `${operation} ${profile.id}`,
        ).toThrow(AgentProfileTierReadOnlyError);
      }
    }
  });
});

describe("specialist reviewer advisory routing (R11.1)", () => {
  it("routes a beyond-mandate finding to an advisory of a named kind", () => {
    for (const id of SPECIALIST_REVIEWER_IDS) {
      const instructions = findBuiltinAgentProfile(id)?.instructions ?? "";

      expect(instructions, id).toMatch(/\bmandate\b/);
      expect(instructions, id).toMatch(/\badvisor(?:y|ies)\b/);
      for (const kind of ADVISORY_KINDS) {
        expect(instructions, `${id} names the \`${kind}\` kind`).toContain(
          `\`${kind}\``,
        );
      }
    }
  });

  it("keeps specialist instructions legal on an advisory seat", () => {
    for (const id of SPECIALIST_REVIEWER_IDS) {
      const instructions = findBuiltinAgentProfile(id)?.instructions ?? "";

      for (const presumption of BLOCKING_CHANNEL_PRESUMPTIONS) {
        expect(instructions, `${id} vs ${presumption}`).not.toMatch(
          presumption,
        );
      }
    }
  });
});
