/**
 * Changing a conversation's agent profile.
 *
 * This is the ONE operation that rewrites a conversation's profile column after
 * creation, which is what makes it the place the lock rule is enforced rather
 * than merely available: a legacy conversation and a conversation that has
 * already run a turn are both refused here, so no caller can settle a profile
 * the requirement says is settled (R6.5).
 *
 * It composes and stores the rendered block at the swap, so the next runtime
 * replays the new profile verbatim exactly as the first one did (R6).
 */

import { createLogger } from "@/lib/logging";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import {
  AgentProfileNotResolvableError,
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import {
  formatAgentProfileRef,
  redactAgentProfileSnapshot,
  type AgentProfileRef,
  type RedactedAgentProfileSnapshot,
  type ResolvedAgentProfile,
} from "@/lib/agent-profiles/schemas";
import { assertConversationProfileChangeAllowed } from "./conversation-profile";
import type { ConversationState } from "./schemas";

const logger = createLogger("conversations");

export class ConversationNotFoundForProfileChangeError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} does not exist.`);
    this.name = "ConversationNotFoundForProfileChangeError";
  }
}

export class UnknownAgentProfileError extends Error {
  constructor(readonly ref: AgentProfileRef) {
    super(`No agent profile ${formatAgentProfileRef(ref)} exists.`);
    this.name = "UnknownAgentProfileError";
  }
}

export interface ConversationProfileChangeDeps {
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
  /** Null when no record exists in the referenced tier. */
  resolveProfile(
    projectPath: string,
    ref: AgentProfileRef,
  ): Promise<ResolvedAgentProfile | null>;
}

export interface ConversationProfileChangeIdentity {
  projectPath: string;
  /** Session-keyed storage name; the project sentinel addresses a PLC row. */
  sessionName: string;
  conversationId: string;
}

/**
 * Resolve a profile from the library — all three tiers, scoped to the project
 * the conversation lives in.
 *
 * The library's own resolution already fails closed (unknown, deleted, or
 * quarantined records raise, and it never falls back to a sibling tier); this
 * translates that one refusal into the null the change operation reports as
 * {@link UnknownAgentProfileError}, so a caller sees one "no such profile"
 * answer whatever the underlying reason was.
 */
export async function resolveLibraryAgentProfile(
  projectPath: string,
  ref: AgentProfileRef,
  library: Pick<
    AgentProfileLibraryService,
    "resolve"
  > = createAgentProfileLibraryService(),
): Promise<ResolvedAgentProfile | null> {
  try {
    return await library.resolve(projectPath, ref);
  } catch (err) {
    if (err instanceof AgentProfileNotResolvableError) return null;
    throw err;
  }
}

/**
 * Point `conversationId` at a different agent profile, returning the redacted
 * snapshot now in force.
 *
 * Throws `ConversationProfileLockedError` when the conversation's profile is
 * already settled — it has run a turn (`locked`), or it predates the library
 * and has no profile to change (`legacy`).
 */
export async function changeConversationProfile(
  deps: ConversationProfileChangeDeps,
  identity: ConversationProfileChangeIdentity,
  ref: AgentProfileRef,
): Promise<RedactedAgentProfileSnapshot> {
  const conversation = await deps.getConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  if (conversation === null) {
    throw new ConversationNotFoundForProfileChangeError(
      identity.conversationId,
    );
  }

  // Before resolution: a refusal must not depend on whether the requested
  // profile happens to exist, and a legacy row must not be read as "resolve
  // failed" when the real answer is that it can never carry a profile.
  assertConversationProfileChangeAllowed(conversation);

  const resolved = await deps.resolveProfile(identity.projectPath, ref);
  if (resolved === null) throw new UnknownAgentProfileError(ref);

  const snapshot = buildAgentProfileSnapshot(resolved);
  await deps.mutateConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
    "change-agent-profile",
    (draft) => {
      // Re-checked HERE, not only above: the read and the resolve are outside
      // the writer, so a first prompt can be admitted in between and lock the
      // profile. The single-writer re-check is what makes that race
      // deterministic — admission and this change cannot interleave, so the
      // later of the two is refused rather than overwriting the snapshot the
      // admitted turn is already running under (R8, D21).
      assertConversationProfileChangeAllowed(draft);
      draft.profileSnapshot = snapshot;
    },
  );

  const redacted = redactAgentProfileSnapshot(snapshot);
  logger.info("conversation.profile_changed", {
    conversationId: identity.conversationId,
    profile: redacted,
  });
  return redacted;
}
