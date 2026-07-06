import { escapeXmlAttr } from "@/lib/shared/xml";

/**
 * Everything needed to render a `<message-ref ... />` tag. Built by the
 * per-message Copy-reference action and by the prompt-editor serializer when
 * it encounters a pasted `messageMention` chip.
 */
export interface MessageRefInput {
  projectName: string;
  /** Null for project-scoped conversations that have no owning session. */
  sessionName: string | null;
  conversationId: string;
  conversationName: string | null;
  /** 0-based index into the conversation's visible-message array. */
  messageIndex: number;
  role: "user" | "assistant" | "notice";
  timestamp: string | null;
  model: string | null;
  /** Completed message_compaction artifact covering this message, if any. */
  compaction: { artifactId: string; createdAt: string } | null;
}

/**
 * Render a self-closing `<message-ref ... />` XML tag. Alongside the locating
 * metadata it carries ready-to-run cctl commands the reading agent can copy
 * verbatim — cctl resolves the owning project/session from the conversation
 * id, so the commands need no flags. Compaction first (the dense structured
 * summary) when one exists, then the single-message read.
 */
export function buildMessageRefXml(input: MessageRefInput): string {
  const parts: string[] = ["<message-ref"];
  const push = (name: string, value: string) =>
    parts.push(`${name}="${escapeXmlAttr(value)}"`);

  push("project-name", input.projectName);
  if (input.sessionName) push("session-name", input.sessionName);
  push("conversation-id", input.conversationId);
  if (input.conversationName) {
    push("conversation-name", input.conversationName);
  }
  push("message-index", String(input.messageIndex));
  push("role", input.role);
  if (input.timestamp) push("timestamp", input.timestamp);
  if (input.model) push("model", input.model);
  push("compacted", input.compaction ? "true" : "false");
  if (input.compaction) {
    push("compact-artifact-id", input.compaction.artifactId);
    push("compact-created-at", input.compaction.createdAt);
    push(
      "compaction-command",
      `cctl conversation compaction get ${input.conversationId} --message ${input.messageIndex} --json`,
    );
  }
  push(
    "read-command",
    `cctl conversation read ${input.conversationId} --message ${input.messageIndex}`,
  );
  return `${parts.join(" ")} />`;
}
