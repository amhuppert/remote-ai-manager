import { describe, it, expect } from "vitest";

import {
  agentProfileSchema,
  agentProfileRefSchema,
  agentProfileSnapshotSchema,
  redactedAgentProfileSnapshotSchema,
  agentProfileTierSchema,
  parseAgentProfileRef,
  parseAgentProfileRefOrThrow,
  formatAgentProfileRef,
  redactAgentProfileSnapshot,
  isMutableProfileTier,
  assertMutableProfileTier,
  AgentProfileRefParseError,
  AgentProfileTierReadOnlyError,
  type AgentProfile,
  type AgentProfileSnapshot,
} from "./schemas";

const validProfile: AgentProfile = {
  id: "security-reviewer",
  revision: 3,
  name: "Security Reviewer",
  description: "Reviews changes for security defects.",
  instructions: "Read the diff as an attacker would.",
  recommendedFor: ["workflow_validator"],
  tags: ["security", "review"],
};

describe("agentProfileSchema — identity fields (R1.1)", () => {
  it("accepts a complete identity record and derives its type", () => {
    const parsed = agentProfileSchema.parse(validProfile);
    expect(parsed).toEqual(validProfile);
  });

  it("defaults the advisory metadata when omitted", () => {
    const parsed = agentProfileSchema.parse({
      id: "standard-agent",
      revision: 1,
      name: "Standard Agent",
      description: "The Command Center default.",
      instructions: "Work as Command Center's general-purpose agent.",
    });

    expect(parsed.recommendedFor).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  it("rejects runtime keys — a profile carries no backend, model, or effort", () => {
    for (const runtimeKey of [
      "backend",
      "model",
      "modelId",
      "reasoningEffort",
    ]) {
      const result = agentProfileSchema.safeParse({
        ...validProfile,
        [runtimeKey]: "anything",
      });
      expect(
        result.success,
        `${runtimeKey} must be rejected as an unknown key`,
      ).toBe(false);
    }
  });

  it("rejects policy keys — a profile carries no tools, MCP, skills, or permissions", () => {
    for (const policyKey of [
      "tools",
      "mcp",
      "mcpServers",
      "skills",
      "permissions",
      "outputSchema",
      "continuity",
      "questions",
    ]) {
      const result = agentProfileSchema.safeParse({
        ...validProfile,
        [policyKey]: {},
      });
      expect(
        result.success,
        `${policyKey} must be rejected as an unknown key`,
      ).toBe(false);
    }
  });

  it("rejects the tier as a record field — tier comes from the scope, not the record", () => {
    expect(
      agentProfileSchema.safeParse({ ...validProfile, tier: "builtin" })
        .success,
    ).toBe(false);
  });

  it("accepts lowercase kebab-case ids", () => {
    for (const id of [
      "standard-agent",
      "type-api-contract-reviewer",
      "a1",
      "reviewer2",
    ]) {
      expect(
        agentProfileSchema.safeParse({ ...validProfile, id }).success,
        `${id} should be a valid id`,
      ).toBe(true);
    }
  });

  it("rejects ids that are not lowercase kebab-case slugs", () => {
    for (const id of [
      "Security-Reviewer",
      "security_reviewer",
      "-leading",
      "trailing-",
      "double--dash",
      "has space",
      "builtin:security-reviewer",
      "",
    ]) {
      expect(
        agentProfileSchema.safeParse({ ...validProfile, id }).success,
        `${JSON.stringify(id)} should be an invalid id`,
      ).toBe(false);
    }
  });

  it("requires a non-empty name, description, and instructions", () => {
    expect(
      agentProfileSchema.safeParse({ ...validProfile, name: "" }).success,
    ).toBe(false);
    expect(
      agentProfileSchema.safeParse({ ...validProfile, description: "" })
        .success,
    ).toBe(false);
    expect(
      agentProfileSchema.safeParse({ ...validProfile, instructions: "" })
        .success,
    ).toBe(false);
  });

  it("requires a positive integer revision", () => {
    for (const revision of [0, -1, 1.5]) {
      expect(
        agentProfileSchema.safeParse({ ...validProfile, revision }).success,
        `revision ${revision} should be rejected`,
      ).toBe(false);
    }
  });

  it("constrains recommendedFor to the three advisory audiences without duplicates", () => {
    expect(
      agentProfileSchema.safeParse({
        ...validProfile,
        recommendedFor: [
          "conversation",
          "workflow_implementer",
          "workflow_validator",
        ],
      }).success,
    ).toBe(true);
    expect(
      agentProfileSchema.safeParse({
        ...validProfile,
        recommendedFor: ["reviewer"],
      }).success,
    ).toBe(false);
    expect(
      agentProfileSchema.safeParse({
        ...validProfile,
        recommendedFor: ["conversation", "conversation"],
      }).success,
    ).toBe(false);
  });
});

describe("agentProfileTierSchema and tier mutability (R2, R3.1)", () => {
  it("accepts the three sibling tiers and rejects anything else", () => {
    for (const tier of ["builtin", "global", "project"]) {
      expect(agentProfileTierSchema.safeParse(tier).success).toBe(true);
    }
    expect(agentProfileTierSchema.safeParse("local").success).toBe(false);
  });

  it("reports the builtin tier as immutable and the authored tiers as mutable", () => {
    expect(isMutableProfileTier("builtin")).toBe(false);
    expect(isMutableProfileTier("global")).toBe(true);
    expect(isMutableProfileTier("project")).toBe(true);
  });

  it("refuses a builtin-tier mutation with a typed error naming the tier and id", () => {
    let thrown: unknown;
    try {
      assertMutableProfileTier(
        { tier: "builtin", id: "security-reviewer" },
        "update",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentProfileTierReadOnlyError);
    if (!(thrown instanceof AgentProfileTierReadOnlyError)) throw thrown;
    expect(thrown.ref).toEqual({ tier: "builtin", id: "security-reviewer" });
    expect(thrown.operation).toBe("update");
    expect(thrown.message).toContain("builtin:security-reviewer");
  });

  it("allows mutation of the global and project tiers", () => {
    expect(() =>
      assertMutableProfileTier({ tier: "global", id: "my-lens" }, "update"),
    ).not.toThrow();
    expect(() =>
      assertMutableProfileTier({ tier: "project", id: "my-lens" }, "delete"),
    ).not.toThrow();
  });
});

describe("agentProfileRefSchema — persisted references (R2.2)", () => {
  it("accepts the structured qualified form", () => {
    expect(
      agentProfileRefSchema.parse({
        tier: "builtin",
        id: "security-reviewer",
      }),
    ).toEqual({ tier: "builtin", id: "security-reviewer" });
  });

  it("rejects the compact shorthand as a persisted value — persisted refs are structured", () => {
    expect(
      agentProfileRefSchema.safeParse("builtin:security-reviewer").success,
    ).toBe(false);
  });

  it("rejects an unqualified reference and unknown keys", () => {
    expect(
      agentProfileRefSchema.safeParse({ id: "security-reviewer" }).success,
    ).toBe(false);
    expect(
      agentProfileRefSchema.safeParse({
        tier: "builtin",
        id: "security-reviewer",
        name: "Security Reviewer",
      }).success,
    ).toBe(false);
  });
});

describe("parseAgentProfileRef — tier:id shorthand (R2.2)", () => {
  it("normalizes builtin:security-reviewer to the structured reference", () => {
    const result = parseAgentProfileRef("builtin:security-reviewer");

    expect(result).toEqual({
      ok: true,
      ref: { tier: "builtin", id: "security-reviewer" },
    });
  });

  it("parses every tier's shorthand", () => {
    expect(parseAgentProfileRefOrThrow("global:my-lens")).toEqual({
      tier: "global",
      id: "my-lens",
    });
    expect(parseAgentProfileRefOrThrow("project:my-lens")).toEqual({
      tier: "project",
      id: "my-lens",
    });
  });

  it("refuses an unqualified id with a typed located failure", () => {
    const result = parseAgentProfileRef("security-reviewer");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a parse failure");
    expect(result.failure.kind).toBe("unqualified");
    expect(result.failure.text).toBe("security-reviewer");
    expect(result.failure.offset).toBe(0);
    expect(result.failure.length).toBe("security-reviewer".length);
    expect(result.failure.message).toContain("builtin:security-reviewer");
  });

  it("locates the failure inside the enclosing text when a source offset is given", () => {
    const prose = "Staff this with security-reviewer please.";
    const offset = prose.indexOf("security-reviewer");

    const result = parseAgentProfileRef("security-reviewer", {
      sourceOffset: offset,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a parse failure");
    expect(result.failure.offset).toBe(offset);
    expect(
      prose.slice(
        result.failure.offset,
        result.failure.offset + result.failure.length,
      ),
    ).toBe("security-reviewer");
  });

  it("locates an unknown tier on the tier segment", () => {
    const result = parseAgentProfileRef("bogus:security-reviewer");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a parse failure");
    expect(result.failure.kind).toBe("unknown_tier");
    expect(result.failure.offset).toBe(0);
    expect(result.failure.length).toBe("bogus".length);
  });

  it("locates an invalid id on the id segment", () => {
    const result = parseAgentProfileRef("builtin:Security_Reviewer");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a parse failure");
    expect(result.failure.kind).toBe("invalid_id");
    expect(result.failure.offset).toBe("builtin:".length);
    expect(result.failure.length).toBe("Security_Reviewer".length);
  });

  it("refuses an empty id and a multi-segment reference", () => {
    for (const text of ["builtin:", "builtin:a:b", ":security-reviewer", ""]) {
      const result = parseAgentProfileRef(text);
      expect(result.ok, `${JSON.stringify(text)} should be refused`).toBe(
        false,
      );
    }
  });

  it("throws the typed error carrying the located failure", () => {
    let thrown: unknown;
    try {
      parseAgentProfileRefOrThrow("security-reviewer");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentProfileRefParseError);
    if (!(thrown instanceof AgentProfileRefParseError)) throw thrown;
    expect(thrown.failure.kind).toBe("unqualified");
    expect(thrown.failure.offset).toBe(0);
  });

  it("round-trips the structured reference through the compact spelling", () => {
    const ref = { tier: "project", id: "my-lens" } as const;
    expect(formatAgentProfileRef(ref)).toBe("project:my-lens");
    expect(parseAgentProfileRefOrThrow(formatAgentProfileRef(ref))).toEqual(
      ref,
    );
  });

  it("keeps same-id profiles in different tiers distinct", () => {
    const builtin = parseAgentProfileRefOrThrow("builtin:general-reviewer");
    const project = parseAgentProfileRefOrThrow("project:general-reviewer");

    expect(builtin).not.toEqual(project);
    expect(formatAgentProfileRef(builtin)).not.toBe(
      formatAgentProfileRef(project),
    );
  });
});

describe("profile snapshots", () => {
  const snapshot: AgentProfileSnapshot = {
    tier: "builtin",
    id: "security-reviewer",
    name: "Security Reviewer",
    revision: 3,
    sourceContentHash: `sha256:${"a".repeat(64)}`,
    instructions: "Read the diff as an attacker would.",
    renderedInstructionBlock: "rendered block",
    resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
  };

  it("accepts the private snapshot with both hashes and both instruction fields", () => {
    expect(agentProfileSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects unknown snapshot fields and malformed hashes", () => {
    expect(
      agentProfileSnapshotSchema.safeParse({ ...snapshot, backend: "claude" })
        .success,
    ).toBe(false);
    expect(
      agentProfileSnapshotSchema.safeParse({
        ...snapshot,
        sourceContentHash: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("redacts exactly the instruction fields, keeping identity and provenance", () => {
    const redacted = redactAgentProfileSnapshot(snapshot);

    expect(redacted).toEqual({
      tier: "builtin",
      id: "security-reviewer",
      name: "Security Reviewer",
      revision: 3,
      sourceContentHash: snapshot.sourceContentHash,
      resolvedInstructionHash: snapshot.resolvedInstructionHash,
    });
    expect(redactedAgentProfileSnapshotSchema.parse(redacted)).toEqual(
      redacted,
    );
  });

  it("refuses instruction fields on the redacted schema so a leak fails to parse", () => {
    expect(
      redactedAgentProfileSnapshotSchema.safeParse({
        ...redactAgentProfileSnapshot(snapshot),
        instructions: snapshot.instructions,
      }).success,
    ).toBe(false);
    expect(
      redactedAgentProfileSnapshotSchema.safeParse({
        ...redactAgentProfileSnapshot(snapshot),
        renderedInstructionBlock: snapshot.renderedInstructionBlock,
      }).success,
    ).toBe(false);
  });
});
