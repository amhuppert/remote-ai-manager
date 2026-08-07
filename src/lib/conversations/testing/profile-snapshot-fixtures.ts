import {
  storedConversationStateSchema,
  type StoredConversationState,
} from "../schemas";
import {
  findBuiltinAgentProfile,
  STANDARD_AGENT_PROFILE_ID,
} from "@/lib/agent-profiles/builtins";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";

/**
 * Shared fixtures for the R6.3 non-leakage suites.
 *
 * Every surface assertion uses this ONE sentinel, so a hit anywhere is
 * attributable to profile instruction text rather than to incidental prose that
 * happens to resemble it.
 */
export const PROFILE_SECRET_SENTINEL = "SENTINEL-b6f0c2a1-instructions-leak";

const SENTINEL_INSTRUCTIONS = `Review for injection flaws. ${PROFILE_SECRET_SENTINEL}`;

/**
 * A real snapshot built through the production composer — not a hand-written
 * literal — so the rendered block and both hashes are exactly what a live
 * conversation would carry, and a wire assertion is testing the real bytes.
 */
export const SNAPSHOT_FIXTURE: AgentProfileSnapshot = buildAgentProfileSnapshot(
  {
    tier: "project",
    id: "security-reviewer",
    name: "Security reviewer",
    revision: 3,
    sourceContentHash: computeContentHash(SENTINEL_INSTRUCTIONS),
    instructions: SENTINEL_INSTRUCTIONS,
  },
);

/** The redacted form the projector must produce for {@link SNAPSHOT_FIXTURE}. */
export const REDACTED_SNAPSHOT_FIXTURE = {
  tier: SNAPSHOT_FIXTURE.tier,
  id: SNAPSHOT_FIXTURE.id,
  name: SNAPSHOT_FIXTURE.name,
  revision: SNAPSHOT_FIXTURE.revision,
  sourceContentHash: SNAPSHOT_FIXTURE.sourceContentHash,
  resolvedInstructionHash: SNAPSHOT_FIXTURE.resolvedInstructionHash,
};

export const BASE_CONVERSATION_FIELDS = {
  id: "conv-1",
  transcriptPath: null,
  status: "awaiting" as const,
  promptCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
};

export function buildStoredConversation(
  overrides: Record<string, unknown> = {},
): StoredConversationState {
  return storedConversationStateSchema.parse({
    ...BASE_CONVERSATION_FIELDS,
    ...overrides,
  });
}

/** A conversation carrying the sentinel profile, locked as a live one would be. */
export function buildProfiledConversation(
  overrides: Record<string, unknown> = {},
): StoredConversationState {
  return buildStoredConversation({
    profileSnapshot: SNAPSHOT_FIXTURE,
    profileLockedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  });
}

/**
 * The shipped no-op default's snapshot, composed from the builtin record rather
 * than hand-written, so a builtin that grew instruction text again would break
 * the zero-bytes suites instead of passing them on a stale literal.
 */
export const NO_OP_SNAPSHOT_FIXTURE: AgentProfileSnapshot = (() => {
  const standard = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);
  if (standard === undefined) {
    throw new Error("the standard-agent built-in is missing");
  }
  return buildAgentProfileSnapshot({
    tier: "builtin",
    id: standard.id,
    name: standard.name,
    revision: standard.revision,
    sourceContentHash: computeContentHash(standard.instructions),
    instructions: standard.instructions,
  });
})();

/** A conversation carrying the no-op default, locked as a live one would be. */
export function buildNoOpProfiledConversation(
  overrides: Record<string, unknown> = {},
): StoredConversationState {
  return buildStoredConversation({
    profileSnapshot: NO_OP_SNAPSHOT_FIXTURE,
    profileLockedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  });
}
