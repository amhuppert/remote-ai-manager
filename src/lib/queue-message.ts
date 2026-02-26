/**
 * Queue a user message into an actively running conversation.
 *
 * Uses `query.streamInput()` from the Agent SDK to deliver the message
 * to the running SDK query, which buffers it for delivery when the
 * current turn ends.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getQuery } from "./query-registry";
import { appendTranscriptEntry } from "./transcript";
import { broadcast } from "./sse-broadcaster";
import { createLogger } from "./logging";

const logger = createLogger("queue-message");

interface QueueMessageParams {
  conversationId: string;
  projectName: string;
  sessionName: string;
  text: string;
}

export async function queueMessage(params: QueueMessageParams): Promise<void> {
  const { conversationId, projectName, sessionName, text } = params;

  const q = getQuery(conversationId);
  if (!q) {
    throw new Error(
      `No active query for conversation ${conversationId} — cannot queue message`,
    );
  }

  logger.info("queue.submit", { conversationId, textLength: text.length });

  // Build an async iterable yielding a single SDKUserMessage
  async function* buildMessage(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  // Persist to transcript immediately
  await appendTranscriptEntry(conversationId, {
    timestamp: new Date().toISOString(),
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  });

  // Feed into the running SDK query
  await q.streamInput(buildMessage());

  // Notify connected UI clients
  try {
    broadcast({
      type: "message-queued",
      projectName,
      sessionName,
      conversationId,
      text,
    });
  } catch {
    // fire-and-forget
  }

  logger.info("queue.delivered", { conversationId });
}
