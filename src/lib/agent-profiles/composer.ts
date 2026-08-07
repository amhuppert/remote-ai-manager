import { renderProfileBlock } from "./block";
import { computeContentHash } from "./hashing";
import {
  agentProfileSnapshotSchema,
  formatAgentProfileRef,
  type AgentProfileSnapshot,
  type ContentHash,
  type ResolvedAgentProfile,
} from "./schemas";

/**
 * The composed profile layer plus its provenance.
 *
 * The layer's FORMAT lives in `./block`, which is free of `node:crypto` so the
 * authoring UI can preview a draft in the browser. This module is the one that
 * attests to delivered bytes, which is why it owns the hashing and the
 * snapshot.
 */

export {
  ASSIGNMENT_FOCUS_MAX_LENGTH,
  PROFILE_BLOCK_BEGIN,
  PROFILE_BLOCK_END,
  PROFILE_LAYER_HEADING,
  RESERVED_INSTRUCTION_SEQUENCES,
  AgentAssignmentFocusTooLongError,
  AgentProfileInstructionCollisionError,
  findReservedSequence,
  normalizeAssignmentFocus,
  renderProfileBlock,
  type ProfileTextField,
  type RenderProfileBlockOptions,
  type ReservedSequenceCollision,
} from "./block";

/**
 * The use-site inputs the composer accepts alongside a resolved profile. One
 * interface, one channel: a focus that is not passed here has no other way to
 * reach the model, which is what makes `resolvedInstructionHash` a complete
 * account of the delivered layer.
 */
export interface ComposeProfileBlockOptions {
  assignmentFocus?: string;
}

export interface ComposedProfileBlock {
  /**
   * The complete rendered profile layer, delivered as one instruction entry —
   * empty for a profile with no instruction content, which the session
   * instruction channel then drops along with every other empty entry.
   */
  block: string;
  /** `sha256:<hex>` over exactly `block`. */
  resolvedInstructionHash: ContentHash;
}

/**
 * Render the profile layer delivered to a backend, with the hash covering
 * exactly the bytes rendered.
 *
 * The composer owns everything about the layer's structure — delimiters, the
 * precedence contract, the subordination language — so every consumer
 * (conversation start, workflow task runs) delivers a byte-identical frame and
 * differs only in the profile content it carries. The result is one entry
 * appended to the backend-neutral session-instruction channel.
 */
export function composeProfileBlock(
  profile: ResolvedAgentProfile,
  options: ComposeProfileBlockOptions = {},
): ComposedProfileBlock {
  const block = renderProfileBlock(profile, options);
  return { block, resolvedInstructionHash: computeContentHash(block) };
}

/**
 * The snapshot a consumer persists before its first runtime is created.
 *
 * Fails closed when the record's stored `sourceContentHash` does not cover its
 * stored instructions: the two hashes answer different provenance questions
 * (which library content, which delivered layer), and a snapshot that carried
 * a stale source hash would silently answer the first one wrong forever. An
 * assignment focus moves `resolvedInstructionHash` (it changes the delivered
 * layer) and never `sourceContentHash` (it is not library content).
 */
export function buildAgentProfileSnapshot(
  profile: ResolvedAgentProfile,
  options: ComposeProfileBlockOptions = {},
): AgentProfileSnapshot {
  const expected = computeContentHash(profile.instructions);
  if (profile.sourceContentHash !== expected) {
    throw new Error(
      `Resolved profile ${formatAgentProfileRef({ tier: profile.tier, id: profile.id })} has a sourceContentHash that does not cover its instructions.`,
    );
  }

  const { block, resolvedInstructionHash } = composeProfileBlock(
    profile,
    options,
  );

  return agentProfileSnapshotSchema.parse({
    ...profile,
    renderedInstructionBlock: block,
    resolvedInstructionHash,
  });
}
