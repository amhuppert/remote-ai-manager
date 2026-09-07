/**
 * Transport-agnostic authoring logic behind the agent-facing HTTP endpoints
 * used by `cctl`. Keeping the attended-runtime gate and defensive open-draft
 * fill here gives both commands one lifecycle: charter fill returns
 * `draft_ready` for `/align` or `activated` for approved-decision
 * incorporation, while proposals persist for review.
 */
import type { ActiveConversationTurnDescription } from "@/lib/workflows/conversation/manager";
import type { ConversationAddress } from "@/lib/workflows/conversation/turn-spec";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";

import {
  AlignmentDraftNotFoundError,
  type BeginDraftInput,
  type FillDraftInput,
  type FillDraftResult,
  type ProposeDecisionsInput,
} from "./service";

// Alignment authoring is attended-only because every activation is authorized
// by either charter approval or decision approval (R12.3).
export const ALIGNMENT_AUTONOMOUS_DENIAL_MESSAGE =
  "Autonomous optimistic mode — alignment tools are unavailable; make your best judgment and proceed.";

export interface AlignmentAuthoringContext {
  projectName: string;
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

/** Service + runtime seams (method syntax → bivariant params). */
export interface AlignmentAuthoringDeps {
  describeActiveTurn(
    address: ConversationAddress,
  ): ActiveConversationTurnDescription | null;
  beginDraft(
    input: BeginDraftInput,
  ): Promise<{ authoringPrompt: string; draftId: string }>;
  fillDraft(input: FillDraftInput): Promise<FillDraftResult>;
  proposeDecisions(input: ProposeDecisionsInput): Promise<{ batchId: string }>;
}

export type AttendedRuntimeResolution =
  | { ok: true; runtime: ActiveConversationTurnDescription }
  | { ok: false; reason: "no_runtime" | "autonomous" };

/**
 * Resolve the conversation runtime and classify whether alignment authoring may
 * proceed. Absent runtime (`no_runtime`) or an autonomous turn (`autonomous`)
 * both short-circuit before any service call — each transport renders the
 * refusal in its own format.
 */
export function resolveAttendedRuntime(
  context: AlignmentAuthoringContext,
  deps: Pick<AlignmentAuthoringDeps, "describeActiveTurn">,
): AttendedRuntimeResolution {
  const runtime = deps.describeActiveTurn({
    projectPath: context.projectPath,
    target: sessionConversationTarget(
      context.projectName,
      context.sessionName,
      context.conversationId,
    ),
  });
  if (!runtime) {
    return { ok: false, reason: "no_runtime" };
  }
  if (runtime.autonomous === true) {
    return { ok: false, reason: "autonomous" };
  }
  return { ok: true, runtime };
}

/**
 * Fill the session's open draft. If none is open (e.g. the agent wrote a charter
 * without running `/align` first), defensively begin a gated draft and fill it —
 * the same recovery both transports rely on to return `draft_ready`.
 */
export async function fillOpenDraft(
  deps: Pick<AlignmentAuthoringDeps, "beginDraft" | "fillDraft">,
  context: AlignmentAuthoringContext,
  content: string,
): Promise<FillDraftResult> {
  const fillInput: FillDraftInput = {
    projectPath: context.projectPath,
    sessionName: context.sessionName,
    conversationId: context.conversationId,
    content,
  };
  try {
    return await deps.fillDraft(fillInput);
  } catch (err) {
    if (!(err instanceof AlignmentDraftNotFoundError)) {
      throw err;
    }
    await deps.beginDraft({
      projectPath: context.projectPath,
      sessionName: context.sessionName,
      conversationId: context.conversationId,
    });
    return deps.fillDraft(fillInput);
  }
}
