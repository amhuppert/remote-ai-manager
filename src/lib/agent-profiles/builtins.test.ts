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
import { composeProfileBlock, findReservedSequence } from "./composer";
import { computeContentHash } from "./hashing";

const EXPECTED_IDS = [
  "standard-agent",
  "general-implementer",
  "general-reviewer",
  "security-reviewer",
  "type-api-contract-reviewer",
  "test-reliability-reviewer",
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

  it("carries an explicit instruction block for standard-agent — the named default, not a null path", () => {
    const standard = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);

    expect(standard).toBeDefined();
    expect(standard?.instructions.trim().length ?? 0).toBeGreaterThan(0);
    expect(standard?.recommendedFor).toContain("conversation");
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

      expect(block, profile.id).toContain(profile.instructions);
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
