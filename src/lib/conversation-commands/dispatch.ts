import type { RunCommandInput, RunCommandOutcome } from "./service";

export type ConversationCommandDispatchInput = RunCommandInput & {
  /** The user's message exactly as submitted, persisted to the transcript. */
  rawText: string;
  modelId?: string;
  effort?: string;
};

/**
 * Shared command dispatch for both entry paths (prompt-route interception and
 * queue drain): persist the user's command message to the transcript, then
 * run the command service to completion — callers await the returned promise.
 *
 * Imports are dynamic so this module stays off the static import graph of
 * its consumers (sdk-driver and the conversation manager).
 */
export async function dispatchConversationCommand(
  input: ConversationCommandDispatchInput,
): Promise<RunCommandOutcome> {
  const { safeAppendTranscriptEntry } = await import("@/lib/prompt/transcript");
  await safeAppendTranscriptEntry(
    input.conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: [{ type: "text", text: input.rawText }],
      ...(input.modelId !== undefined ? { model: input.modelId } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    },
    undefined,
    undefined,
    {
      projectName: input.projectName,
      storeSessionName: input.sessionName ?? input.noticeSessionName ?? "",
    },
  );
  const { conversationCommandService } = await import("./service");
  return conversationCommandService.run(input);
}
