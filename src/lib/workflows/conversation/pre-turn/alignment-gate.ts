/**
 * Pre-turn step: session-alignment (charter) gating.
 *
 * Hides the eligibility rule R12.1/R12.2 — alignment governs only attended
 * normal sessions (not project conversations, not optimistic sessions, not
 * autonomous turns) — plus the per-turn version comparison that guarantees a
 * charter change propagates to an already-running runtime (R7.3) and the
 * post-turn seen-version record used for stale detection (R8.4).
 */

import type { AlignmentInjection } from "@/lib/session-alignment/render";
import { ALIGN_SUGGESTION_INSTRUCTIONS } from "@/lib/session-alignment/render";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

export interface AlignmentGateDeps {
  getActiveAlignmentInjection(
    projectPath: string,
    sessionName: string,
  ): Promise<AlignmentInjection | null>;
  getActiveAlignmentVersion(
    projectPath: string,
    sessionName: string,
  ): Promise<number | null>;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
}

/** R12.1/R12.2: alignment governs attended normal-session turns only. */
export function isAlignmentEligibleTurn(input: {
  creationMode: SessionState["creationMode"] | undefined;
  isProjectConversation: boolean;
  autonomous: boolean | undefined;
}): boolean {
  return (
    input.creationMode === "normal" &&
    !input.isProjectConversation &&
    input.autonomous !== true
  );
}

/**
 * Cheap active-version read for the reused-runtime recreate gate (R7.3).
 * Returns null (no comparison) for ineligible turns; a new runtime bakes in
 * the current version directly, so this is only read when a runtime exists.
 */
export async function resolveAlignmentGateForReusedRuntime(
  deps: Pick<AlignmentGateDeps, "getActiveAlignmentVersion">,
  input: {
    projectPath: string;
    sessionName: string;
    creationMode: SessionState["creationMode"] | undefined;
    isProjectConversation: boolean;
    autonomous: boolean | undefined;
  },
): Promise<{ eligible: boolean; desiredAlignmentVersion: number | null }> {
  const eligible = isAlignmentEligibleTurn(input);
  const desiredAlignmentVersion = eligible
    ? await deps.getActiveAlignmentVersion(input.projectPath, input.sessionName)
    : null;
  return { eligible, desiredAlignmentVersion };
}

export interface AlignmentInstructionResolution {
  eligible: boolean;
  /** Version baked into a freshly-created runtime; null when no charter governs. */
  activeAlignmentVersion: number | null;
  /** Governing charter section, `/align` suggestion, or nothing. */
  alignmentInstruction: string | null;
}

/**
 * Resolve the alignment instruction baked into a new runtime's session
 * instructions: the governing charter section (inline or bounded digest,
 * R7.1/R7.2/R7.4) when one is active, else the `/align` suggestion nudge
 * (R2.5) for eligible sessions without a charter.
 */
export async function resolveAlignmentInstructionForNewRuntime(
  deps: Pick<AlignmentGateDeps, "getActiveAlignmentInjection">,
  input: {
    projectPath: string;
    sessionName: string;
    creationMode: SessionState["creationMode"] | undefined;
    isProjectConversation: boolean;
    autonomous: boolean | undefined;
  },
): Promise<AlignmentInstructionResolution> {
  const eligible = isAlignmentEligibleTurn(input);
  if (!eligible) {
    return {
      eligible,
      activeAlignmentVersion: null,
      alignmentInstruction: null,
    };
  }

  const injection = await deps.getActiveAlignmentInjection(
    input.projectPath,
    input.sessionName,
  );
  if (injection) {
    return {
      eligible,
      activeAlignmentVersion: injection.version,
      alignmentInstruction: injection.text,
    };
  }
  return {
    eligible,
    activeAlignmentVersion: null,
    alignmentInstruction: ALIGN_SUGGESTION_INSTRUCTIONS,
  };
}

/**
 * R8.4: record which charter version this conversation's turn ran with, for
 * stale detection. Only called for alignment-eligible turns, so project/
 * optimistic/autonomous turns leave the seen-version untouched.
 */
export async function recordSeenAlignmentVersion(
  deps: Pick<AlignmentGateDeps, "mutateConversation">,
  input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    seenAlignmentVersion: number | null;
  },
): Promise<void> {
  await deps.mutateConversation(
    input.projectPath,
    input.sessionName,
    input.conversationId,
    "prompt.recordSeenAlignmentVersion",
    (c) => {
      c.lastSeenAlignmentVersion = input.seenAlignmentVersion;
    },
  );
}
