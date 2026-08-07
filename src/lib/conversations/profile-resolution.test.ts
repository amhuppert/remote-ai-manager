import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_PROFILE_REF,
  resolveConversationProfileSnapshot,
  type ConversationProfileResolutionDeps,
} from "./profile-resolution";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type {
  AgentProfileRef,
  ResolvedAgentProfile,
} from "@/lib/agent-profiles/schemas";
import {
  AgentProfileNotResolvableError,
  createAgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";

const PROJECT_PATH = "/repo";

/**
 * The real library service over the built-in tier, which resolves without
 * touching storage. A creation site's default must survive the production
 * resolver, not a stand-in that always answers.
 */
const libraryDeps: ConversationProfileResolutionDeps = {
  resolveProfile: (projectPath, ref) =>
    createAgentProfileLibraryService().resolve(projectPath, ref),
};

function fixedResolver(
  profile: ResolvedAgentProfile,
  seen: AgentProfileRef[] = [],
): ConversationProfileResolutionDeps {
  return {
    async resolveProfile(_projectPath, ref) {
      seen.push(ref);
      return profile;
    },
  };
}

describe("resolveConversationProfileSnapshot", () => {
  it("resolves the explicit Standard Agent default when no selection is made", async () => {
    const snapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      undefined,
      libraryDeps,
    );

    expect(snapshot.tier).toBe("builtin");
    expect(snapshot.id).toBe(STANDARD_AGENT_PROFILE_ID);
    expect(snapshot.name).toBe("Standard Agent");
    // A named default, not an absent one: the snapshot is a full record with
    // identity and provenance (R7). Its content is empty, so the block it
    // delivers is empty and both hashes cover exactly that (R3.3).
    expect(snapshot.instructions).toBe("");
    expect(snapshot.renderedInstructionBlock).toBe("");
    expect(snapshot.sourceContentHash).toBe(computeContentHash(""));
    expect(computeContentHash(snapshot.renderedInstructionBlock)).toBe(
      snapshot.resolvedInstructionHash,
    );
  });

  it("still renders a full block for a non-empty built-in", async () => {
    const snapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
      libraryDeps,
    );

    expect(snapshot.renderedInstructionBlock.length).toBeGreaterThan(0);
    expect(snapshot.renderedInstructionBlock).toContain(snapshot.instructions);
    expect(computeContentHash(snapshot.renderedInstructionBlock)).toBe(
      snapshot.resolvedInstructionHash,
    );
  });

  it("exposes the default as a qualified reference callers can pass explicitly", async () => {
    const explicit = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      DEFAULT_CONVERSATION_PROFILE_REF,
      libraryDeps,
    );
    const implicit = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      null,
      libraryDeps,
    );

    expect(explicit).toEqual(implicit);
  });

  it("snapshots the selected profile through the production composer", async () => {
    const instructions = "Read every diff as an attacker would.";
    const resolved: ResolvedAgentProfile = {
      tier: "project",
      id: "hostile-eye",
      name: "Hostile Eye",
      revision: 4,
      sourceContentHash: computeContentHash(instructions),
      instructions,
    };
    const seen: AgentProfileRef[] = [];

    const snapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "project", id: "hostile-eye" },
      fixedResolver(resolved, seen),
    );

    expect(seen).toEqual([{ tier: "project", id: "hostile-eye" }]);
    expect(snapshot).toEqual(buildAgentProfileSnapshot(resolved));
    expect(snapshot.revision).toBe(4);
  });

  it("fails closed when the reference does not resolve", async () => {
    await expect(
      resolveConversationProfileSnapshot(
        PROJECT_PATH,
        { tier: "builtin", id: "no-such-profile" },
        libraryDeps,
      ),
    ).rejects.toBeInstanceOf(AgentProfileNotResolvableError);
  });
});
