/**
 * Transport-agnostic alignment authoring logic shared by the (soon-retired) MCP
 * tools (`tools.ts`) and the agent-facing HTTP endpoints (`agent-route-handlers.ts`).
 *
 * Keeping the attended-runtime gate and the defensive open-draft fill here — not
 * in either transport — is what makes the CLI path produce byte-equivalent
 * draft-pending-approval / pending-proposal state to the MCP path: both call the
 * same service methods through the same wrapper. Each transport only formats the
 * gate decision into its own response shape (an MCP `isError` result vs. an HTTP
 * status code).
 */
import {
  conversationRuntimeKey,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";

import {
  AlignmentDraftNotFoundError,
  type BeginDraftInput,
  type FillDraftInput,
  type FillDraftResult,
  type ProposeDecisionsInput,
} from "./service";

// Alignment authoring is attended-only: it gates the active charter behind a
// human Approve-Charter step, so it has no meaning on an autonomous turn (R12.3).
export const ALIGNMENT_AUTONOMOUS_DENIAL_MESSAGE =
  "Autonomous optimistic mode — alignment tools are unavailable; make your best judgment and proceed.";

export interface AlignmentAuthoringContext {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

/** Service + runtime seams (method syntax → bivariant params). */
export interface AlignmentAuthoringDeps {
  getRuntime(key: string): ConversationRuntimeState | undefined;
  beginDraft(
    input: BeginDraftInput,
  ): Promise<{ authoringPrompt: string; draftId: string }>;
  fillDraft(input: FillDraftInput): Promise<FillDraftResult>;
  proposeDecisions(input: ProposeDecisionsInput): Promise<{ batchId: string }>;
}

export type AttendedRuntimeResolution =
  | { ok: true; runtime: ConversationRuntimeState }
  | { ok: false; reason: "no_runtime" | "autonomous" };

/**
 * Resolve the conversation runtime and classify whether alignment authoring may
 * proceed. Absent runtime (`no_runtime`) or an autonomous turn (`autonomous`)
 * both short-circuit before any service call — each transport renders the
 * refusal in its own format.
 */
export function resolveAttendedRuntime(
  context: AlignmentAuthoringContext,
  deps: Pick<AlignmentAuthoringDeps, "getRuntime">,
): AttendedRuntimeResolution {
  const runtime = deps.getRuntime(
    conversationRuntimeKey(
      context.projectPath,
      context.sessionName,
      context.conversationId,
    ),
  );
  if (!runtime) {
    return { ok: false, reason: "no_runtime" };
  }
  if (runtime.currentTurnAutonomous === true) {
    return { ok: false, reason: "autonomous" };
  }
  return { ok: true, runtime };
}

/**
 * Fill the session's open draft. If none is open (e.g. the agent wrote a charter
 * without running `/align` first), defensively begin a gated draft and fill it —
 * the same recovery both transports rely on to land a draft-pending-approval.
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
