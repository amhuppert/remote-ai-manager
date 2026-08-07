import {
  ASSIGNMENT_FOCUS_MAX_LENGTH,
  findReservedSequence,
  normalizeAssignmentFocus,
  RESERVED_INSTRUCTION_SEQUENCES,
} from "@/lib/agent-profiles/block";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";

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

/**
 * The two refusals that hold whatever force the text carries. They belong to
 * the composer, not to an authority: both faces of the field are rendered
 * alongside the same delimited profile block.
 */
export const ASSIGNMENT_INSTRUCTIONS_RULES_HINT = `Up to ${ASSIGNMENT_FOCUS_MAX_LENGTH} characters, and it may not contain ${QUOTED_SEQUENCES}, which would end the profile block it renders inside.`;

export interface AssignmentInstructionsPresentation {
  label: string;
  hint: string;
  placeholder: string;
}

/**
 * How the ONE instructions field presents itself at each authority (R12.2/D12).
 *
 * There is a single field, and the authority alone decides its force: a
 * blocking seat's text is the mandate its issues must trace to, rendered in the
 * authoritative layer; an advisory seat's is a subordinate steer inside the
 * profile block. Since the stored value is identical either way, the label and
 * help are the only place an author can see which one they are writing — so
 * they name the force outright rather than letting one word mean both.
 */
export const ASSIGNMENT_INSTRUCTIONS_PRESENTATION: Record<
  ValidatorAuthority,
  AssignmentInstructionsPresentation
> = {
  blocking: {
    label: "Mandate",
    hint: `This assignment's authoritative mandate — every blocking issue it raises must trace back to this text, and anything beyond it goes to the implementer as an advisory. ${ASSIGNMENT_INSTRUCTIONS_RULES_HINT}`,
    placeholder: "What this validator is bound to check, and nothing else",
  },
  advisory: {
    label: "Focus",
    hint: `Subordinate focus inside the profile block — it narrows the profile at this use site, and durable behaviour belongs in the profile itself. ${ASSIGNMENT_INSTRUCTIONS_RULES_HINT}`,
    placeholder: "Optional — narrow this profile for this use site",
  },
};

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
