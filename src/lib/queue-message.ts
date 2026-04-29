/**
 * Queue a user message into an actively running conversation.
 *
 * Uses the backend runtime's `queueUserInput()` to deliver the message
 * to the running conversation, which buffers it for delivery when the
 * current turn ends.
 */

import { getRuntime as defaultGetRuntime } from "@/lib/agent-backends/runtime-registry";
import { appendTranscriptEntry as defaultAppendTranscriptEntry } from "./transcript";
import { type BroadcastFn } from "./sse-broadcaster";
import { publishSessionStatus } from "./workflows/primitives/default-session-status-bus";
import { createLogger } from "./logging";

const logger = createLogger("queue-message");

const defaultBroadcast: BroadcastFn = (event) => {
  publishSessionStatus(event);
};

export interface QueueMessageDeps {
  getRuntime: typeof defaultGetRuntime;
  appendTranscriptEntry: typeof defaultAppendTranscriptEntry;
  broadcast: BroadcastFn;
}

const defaultDeps: QueueMessageDeps = {
  getRuntime: defaultGetRuntime,
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

  const runtime = d.getRuntime(conversationId);
  if (!runtime) {
    throw new Error(
      `No active query for conversation ${conversationId} — cannot queue message`,
    );
  }

  if (!runtime.queueUserInput) {
    throw new Error("Backend does not support message queueing");
  }

  logger.info("queue.submit", { conversationId, textLength: text.length });

  // Persist to transcript immediately
  await d.appendTranscriptEntry(conversationId, {
    timestamp: new Date().toISOString(),
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  });

  // Deliver to the running backend runtime
  await runtime.queueUserInput({ content: [{ type: "text", text }] });

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
