import { readConversationMessages } from "@/lib/prompt/transcript";

/** Read complete assistant answers when observing a queue-driven turn. */
export async function readProbeAssistantTexts(
  transcriptPath: string,
): Promise<string[]> {
  const messages = await readConversationMessages(transcriptPath);
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n"),
    );
}
