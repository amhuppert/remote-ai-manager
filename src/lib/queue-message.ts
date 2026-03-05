/**
 * Queue a user message into an actively running conversation.
 *
 * Uses `query.streamInput()` from the Agent SDK to deliver the message
 * to the running SDK query, which buffers it for delivery when the
 * current turn ends.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getQuery as defaultGetQuery } from "./query-registry";
import { appendTranscriptEntry as defaultAppendTranscriptEntry } from "./transcript";
import {
  broadcast as defaultBroadcast,
  type BroadcastFn,
} from "./sse-broadcaster";
import { createLogger } from "./logging";

const logger = createLogger("queue-message");

export interface QueueMessageDeps {
  getQuery: typeof defaultGetQuery;
  appendTranscriptEntry: typeof defaultAppendTranscriptEntry;
  broadcast: BroadcastFn;
}

const defaultDeps: QueueMessageDeps = {
  getQuery: defaultGetQuery,
  appendTranscriptEntry: defaultAppendTranscriptEntry,
  broadcast: defaultBroadcast,
};

interface QueueMessageParams {
  conversationId: string;
  projectName: string;
  sessionName: string;
  text: string;
  /** @deprecated Use the `deps` parameter instead for DI. */
  broadcast?: BroadcastFn;
  /** Optional dependency overrides for testing. */
  deps?: Partial<QueueMessageDeps>;
}

export async function queueMessage(params: QueueMessageParams): Promise<void> {
  const {
    conversationId,
    projectName,
    sessionName,
    text,
    broadcast: broadcastOverride,
    deps: depsOverride,
  } = params;

  const d = {
    ...defaultDeps,
    ...depsOverride,
    ...(broadcastOverride ? { broadcast: broadcastOverride } : {}),
  };

  const q = d.getQuery(conversationId);
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
  await d.appendTranscriptEntry(conversationId, {
    timestamp: new Date().toISOString(),
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  });

  // Feed into the running SDK query
  await q.streamInput(buildMessage());

  // Notify connected UI clients
  try {
    d.broadcast({
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
