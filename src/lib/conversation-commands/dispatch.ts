import type { ConversationState } from "@/lib/conversations/schemas";
import type { safeAppendTranscriptEntry } from "@/lib/prompt/transcript";
import type { RunCommandInput, RunCommandOutcome } from "./service";

export type ConversationCommandDispatchInput = RunCommandInput & {
  /** The user's message exactly as submitted, persisted to the transcript. */
  rawText: string;
};

export interface CommandDispatchDeps {
  getTranscriptPath(conversationId: string): Promise<string>;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
  appendEntry(
    ...args: Parameters<typeof safeAppendTranscriptEntry>
  ): ReturnType<typeof safeAppendTranscriptEntry>;
  run(input: RunCommandInput): Promise<RunCommandOutcome>;
}

const defaultDeps: CommandDispatchDeps = {
  async getTranscriptPath(id) {
    return (await import("@/lib/prompt/transcript")).getTranscriptPath(id);
  },
  async mutateConversation(...args) {
    return (await import("@/lib/state-store")).mutateConversation(...args);
  },
  async appendEntry(...args) {
    return (await import("@/lib/prompt/transcript")).safeAppendTranscriptEntry(
      ...args,
    );
  },
  async run(input) {
    return (await import("./service")).conversationCommandService.run(input);
  },
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
  deps: CommandDispatchDeps = defaultDeps,
): Promise<RunCommandOutcome> {
  const storeSessionName = input.sessionName ?? input.noticeSessionName ?? "";
  const transcriptPath = await deps.getTranscriptPath(input.conversationId);
  await deps.mutateConversation(
    input.projectPath,
    storeSessionName,
    input.conversationId,
    "command-transcript-initialize",
    (conversation) => {
      conversation.transcriptPath ??= transcriptPath;
    },
  );
  const { createLogger } = await import("@/lib/logging");
  createLogger("conversation-commands.dispatch").debug(
    "command.transcript_ready",
    {
      projectName: input.projectName,
      conversationId: input.conversationId,
      command: input.parsed.command,
    },
  );
  await deps.appendEntry(
    input.conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: [{ type: "text", text: input.rawText }],
      ...(input.modelSelection !== undefined
        ? { modelSelection: input.modelSelection }
        : {}),
    },
    undefined,
    undefined,
    {
      projectName: input.projectName,
      storeSessionName,
    },
  );
  return deps.run(input);
}
