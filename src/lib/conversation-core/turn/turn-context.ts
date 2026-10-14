import type { ExecutePromptInput } from "./types";
import type { ConversationTurnDependencies } from "./dependencies";
import { getErrorMessage } from "@/lib/shared/errors";

export interface PreparedTurnContribution {
  block: string | null;
  onInputAccepted?(): Promise<void>;
  finish?(): Promise<void>;
}

/**
 * Build the effective prompt, prepending debug mode instructions on the
 * first debug turn and phase-specific context on subsequent turns.
 *
 * `activeTicketBlock` is the linked ticket's current view (5.4); it is
 * rebuilt and prepended per turn — transient by design, never baked into
 * session instructions or the persistent runtime, so attachment changes
 * appear on the next turn without runtime recreation (5.5).
 *
 * `memoryIndexBlock` is the fourth (spec `memory` R5/D4): the conversation's
 * generated `<memory-index>`, rebuilt per turn from live rows and placed
 * directly below the ticket block so the artifact being worked on reads
 * before the memory about it. Transient like the rest, never baked in.
 *
 * `runtimeRecoveryBlock` comes first when present: the previous runtime ended
 * with background tasks still running, which the agent must hear before
 * anything it might otherwise wait on.
 *
 * `checkpointSeedBlock` is the frozen CC checkpoint a fresh runtime is seeded
 * from, delivered exactly once on the first ordinary turn after readiness. It
 * leads the conversation's own context because it IS the conversation's prior
 * history — the transient blocks describe the present — and it is passed
 * through byte for byte: the saved payload's hash is what acceptance is later
 * recorded against.
 */
export function assembleTurnPrompt(input: {
  userText: string;
  /** The previous runtime's background tasks ended with it: said first, once. */
  runtimeRecoveryBlock?: string | null;
  debugContext: string | null;
  activeTicketBlock: string | null;
  memoryIndexBlock: string | null;
  checkpointSeedBlock: string | null;
  passiveBriefingBlock?: string | null;
}): string {
  return [
    input.runtimeRecoveryBlock,
    input.checkpointSeedBlock,
    input.passiveBriefingBlock,
    input.activeTicketBlock,
    input.memoryIndexBlock,
    input.debugContext,
    input.userText,
  ]
    .filter((block) => block !== null && block !== undefined && block !== "")
    .join("\n\n");
}

export async function prepareTaskPrompt(
  deps: Pick<ConversationTurnDependencies, "context" | "log">,
  input: Pick<ExecutePromptInput, "projectPath" | "target"> & {
    promptText: string;
  },
): Promise<string> {
  if (input.target.scope === "project") return input.promptText;
  try {
    const block = await deps.context.getLiveTicketBlock(
      input.projectPath,
      input.target.sessionName,
    );
    return block === null
      ? input.promptText
      : `${block}\n\n${input.promptText}`;
  } catch (error) {
    deps.log.warn("task_run.live_ticket_block_failed", {
      ...input.target,
      error: getErrorMessage(error),
    });
    return input.promptText;
  }
}

/** The parts of a turn the context contributions read. */
export type TurnContextExecution = Pick<
  ExecutePromptInput,
  | "projectPath"
  | "target"
  | "worktreePath"
  | "role"
  | "persistence"
  | "executionAttemptId"
  | "debugMode"
> & { turn: Pick<ExecutePromptInput["turn"], "inputOrigin" | "promptText"> };
