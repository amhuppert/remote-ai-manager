import {
  ASSIGNMENT_FOCUS_MAX_LENGTH,
  findReservedSequence,
  normalizeAssignmentFocus,
  RESERVED_INSTRUCTION_SEQUENCES,
} from "@/lib/agent-profiles/block";

/**
 * What an authoring surface says about a use-site focus, before and after the
 * author trips a rule.
 *
 * Both read from the composer's own constants rather than restating them: the
 * refusal shown while typing has to be exactly the refusal the renderer would
 * raise later, or an assignment could save here and then fail to compose when a
 * lane runs it.
 */

const QUOTED_SEQUENCES = RESERVED_INSTRUCTION_SEQUENCES.map(
  (sequence) => `"${sequence}"`,
).join(" or ");

export const ASSIGNMENT_FOCUS_RULES_HINT = `Narrows the profile at this use site — durable behaviour belongs in the profile itself. Up to ${ASSIGNMENT_FOCUS_MAX_LENGTH} characters, and it may not contain ${QUOTED_SEQUENCES}, which would end the profile block it renders inside.`;

/**
 * Why this focus cannot be composed, or null when it can.
 *
 * Measured against the NORMALIZED focus, like the renderer: trailing whitespace
 * is not text the author has to delete to get under the cap.
 */
export function assignmentFocusRefusal(text: string): string | null {
  const focus = normalizeAssignmentFocus(text);
  if (focus === null) return null;

  if (focus.length > ASSIGNMENT_FOCUS_MAX_LENGTH) {
    return `This focus is ${focus.length} characters; the maximum is ${ASSIGNMENT_FOCUS_MAX_LENGTH}.`;
  }

  const collision = findReservedSequence(focus);
  if (collision !== null) {
    return `A focus may not contain "${collision.sequence}" (at character ${collision.offset + 1}) — it would terminate the profile block it is rendered inside.`;
  }

  return null;
}
