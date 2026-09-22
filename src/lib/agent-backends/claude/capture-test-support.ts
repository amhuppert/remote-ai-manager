import { randomUUID } from "node:crypto";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import type { CreateSdkQuery } from "./query-session";
import {
  buildModelUsage,
  buildNonNullableUsage,
} from "../testing/fake-claude-sdk-port";

export function captureInit(tools: string[] = []): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    uuid: randomUUID(),
    session_id: "source-session",
    apiKeySource: "none",
    claude_code_version: "2.1.257",
    cwd: process.cwd(),
    tools,
    mcp_servers: [],
    model: "sonnet",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
  };
}
export function captureResult(
  uuid: string | undefined,
  text = "{}",
  turns = 1,
): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    uuid: randomUUID(),
    session_id: "source-session",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: turns,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: buildNonNullableUsage(),
    modelUsage: buildModelUsage(),
    permission_denials: [],
    user_message_uuid: uuid,
  };
}
export function scriptedCaptureSdk(
  script: (input: SDKUserMessage, emit: (message: SDKMessage) => void) => void,
  collection?: {
    childCompletion?: Promise<void>;
    pumpCompletion?: Promise<void>;
    drainOnClose?: boolean;
  },
): CreateSdkQuery {
  return ({ prompt }) => {
    const messages: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const childClosed = Promise.withResolvers<void>();
    const emit = (message: SDKMessage) => {
      if (!closed) messages.push(message);
      wake?.();
    };
    void prompt[Symbol.asyncIterator]()
      .next()
      .then((input) => {
        if (!input.done) script(input.value, emit);
      });
    return {
      async awaitChildCollection() {
        await (collection?.childCompletion ?? childClosed.promise);
      },
      close() {
        childClosed.resolve();
        closed = true;
        wake?.();
      },
      async supportedCommands() {
        return [];
      },
      async supportedAgents() {
        return [];
      },
      async mcpServerStatus() {
        return [];
      },
      async applyFlagSettings() {},
      async setMcpServers() {
        return { added: [], removed: [], errors: {} };
      },
      async reloadPlugins() {},
      async *[Symbol.asyncIterator]() {
        while (!closed || (collection?.drainOnClose && messages.length > 0)) {
          const message = messages.shift();
          if (message) yield message;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
        await collection?.pumpCompletion;
      },
    };
  };
}

export function captureAssistant(
  text: string,
  id = "message-1",
): Extract<SDKMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: "source-session",
    parent_tool_use_id: null,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "sonnet",
      container: null,
      context_management: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text, citations: null }],
      usage: buildNonNullableUsage(),
    },
  };
}
export function captureDelta(
  text: string,
): Extract<SDKMessage, { type: "stream_event" }> {
  return {
    type: "stream_event",
    uuid: randomUUID(),
    session_id: "source-session",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  };
}
export function captureMaxTokens(): Extract<
  SDKMessage,
  { type: "stream_event" }
> {
  return {
    type: "stream_event",
    uuid: randomUUID(),
    session_id: "source-session",
    parent_tool_use_id: null,
    event: {
      type: "message_delta",
      context_management: null,
      delta: {
        stop_reason: "max_tokens",
        stop_sequence: null,
        container: null,
      },
      usage: {
        iterations: null,
        output_tokens: 1,
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
      },
    },
  };
}
