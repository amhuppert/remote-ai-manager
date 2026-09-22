/**
 * Fake Claude provider ports (test-only) for the backend conformance suite.
 *
 * Implements the two seams the real Claude adapters call the SDK through —
 * `CreateSdkQuery` for `QuerySession` (conversation facet, installed via
 * `_setSdkQueryForTesting`) and `ClaudeTaskRunnerDeps.runQuery` (tasks facet)
 * — so the REAL `QuerySession` pump, `ClaudeConversationRuntime`, and
 * `ClaudeTaskRunner` run against a scripted provider instead of a subprocess.
 *
 * Turn behavior is keyed by prompt text so the shared conformance checks can
 * drive completion, hanging (cancellation), and mid-turn queued-input holds
 * without reaching into port internals. All emitted frames are honest
 * fully-typed SDK messages built without assertion fictions, so a consumer
 * type drift fails typecheck here rather than lying at runtime.
 */

import { randomUUID } from "node:crypto";
import type {
  ModelUsage,
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeSdkQueryPort,
  CreateSdkQuery,
} from "../claude/query-session";
import type { ClaudeTaskRunnerDeps } from "../claude/task-runner";

export const FAKE_CLAUDE_SESSION_ID = "conformance-claude-session-1";
export const FAKE_CLAUDE_MODEL = "sonnet";
export const FAKE_CLAUDE_TURN_TEXT = "conformance scripted claude turn";

/** Prompt the port never answers — the turn hangs until aborted/closed. */
export const FAKE_CLAUDE_HANGING_PROMPT = "conformance: hang this turn";
/**
 * Prompt the port holds open until it consumes ONE more user message from the
 * session's persistent input channel (i.e. a mid-turn `queueUserInput`
 * delivery), then completes — proving in-turn queue delivery end to end.
 */
export const FAKE_CLAUDE_QUEUE_HOLD_PROMPT =
  "conformance: hold until queued input arrives";

export const FAKE_CLAUDE_INPUT_TOKENS = 1_000;
export const FAKE_CLAUDE_CACHE_READ_TOKENS = 200;
export const FAKE_CLAUDE_CONTEXT_WINDOW = 200_000;

export function buildNonNullableUsage(): NonNullableUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: FAKE_CLAUDE_CACHE_READ_TOKENS,
    inference_geo: "us",
    input_tokens: FAKE_CLAUDE_INPUT_TOKENS,
    iterations: [],
    output_tokens: 50,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };
}

export function buildModelUsage(): Record<string, ModelUsage> {
  return {
    [FAKE_CLAUDE_MODEL]: {
      inputTokens: FAKE_CLAUDE_INPUT_TOKENS,
      outputTokens: 50,
      cacheReadInputTokens: FAKE_CLAUDE_CACHE_READ_TOKENS,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.01,
      contextWindow: FAKE_CLAUDE_CONTEXT_WINDOW,
      maxOutputTokens: 32_000,
    },
  };
}

function buildAssistantMessage(text: string): SDKAssistantMessage {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: FAKE_CLAUDE_SESSION_ID,
    parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: FAKE_CLAUDE_MODEL,
      container: null,
      context_management: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text, citations: null }],
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: FAKE_CLAUDE_CACHE_READ_TOKENS,
        inference_geo: null,
        input_tokens: FAKE_CLAUDE_INPUT_TOKENS,
        iterations: null,
        output_tokens: 50,
        server_tool_use: null,
        service_tier: "standard",
        speed: null,
      },
    },
  };
}

function buildResultSuccess(structuredOutput: unknown): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    uuid: randomUUID(),
    session_id: FAKE_CLAUDE_SESSION_ID,
    duration_ms: 120,
    duration_api_ms: 100,
    is_error: false,
    num_turns: 1,
    result: FAKE_CLAUDE_TURN_TEXT,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: buildNonNullableUsage(),
    modelUsage: buildModelUsage(),
    permission_denials: [],
    ...(structuredOutput !== undefined
      ? { structured_output: structuredOutput }
      : {}),
  };
}

/** Concatenated text-block content of a user message from the input channel. */
function extractUserText(msg: SDKUserMessage): string {
  const content = msg.message.content;
  if (typeof content === "string") return content;
  const textBlocks: string[] = [];
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      textBlocks.push(block.text);
    }
  }
  return textBlocks.join("\n");
}

export interface FakeClaudeSdkController {
  /** Install via `_setSdkQueryForTesting(controller.createSdkQuery)`. */
  createSdkQuery: CreateSdkQuery;
  /** Options captured from the most recent `QuerySession` creation. */
  readonly lastOptions: Options | null;
  /** Full text content captured from the most recent dispatched user prompt. */
  readonly lastPromptText: string | undefined;
  /**
   * Emit one unsolicited provider turn (assistant + result) through the most
   * recently created port while no caller turn is pending — the real SDK's
   * background-task auto-continuation shape that drives external turns.
   */
  pushExternalTurn(): void;
}

interface FakePortState {
  emit(message: SDKMessage): void;
}

/**
 * @param config.structuredOutput value the scripted result carries as native
 * `structured_output` whenever the session was created with an
 * `outputFormat` — pairing declared `backend_native` support with observed
 * forwarding.
 */
export function createFakeClaudeSdkController(
  config: { structuredOutput?: unknown; responseText?: string } = {},
): FakeClaudeSdkController {
  let lastOptions: Options | null = null;
  let lastPromptText: string | undefined;
  let lastPort: FakePortState | null = null;

  const createSdkQuery: CreateSdkQuery = (args) => {
    lastOptions = args.options;
    const structuredOutput =
      args.options.outputFormat !== undefined
        ? config.structuredOutput
        : undefined;

    const outgoing: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let holdingForQueuedInput = false;

    const emit = (message: SDKMessage): void => {
      outgoing.push(message);
      wake?.();
      wake = null;
    };

    const completeTurn = (): void => {
      const text = config.responseText ?? FAKE_CLAUDE_TURN_TEXT;
      emit(buildAssistantMessage(text));
      emit({ ...buildResultSuccess(structuredOutput), result: text });
    };

    const handleUserMessage = (msg: SDKUserMessage): void => {
      const text = extractUserText(msg);
      lastPromptText = text;
      if (text.includes(FAKE_CLAUDE_HANGING_PROMPT)) {
        return;
      }
      if (text.includes(FAKE_CLAUDE_QUEUE_HOLD_PROMPT)) {
        holdingForQueuedInput = true;
        return;
      }
      if (holdingForQueuedInput) {
        holdingForQueuedInput = false;
        completeTurn();
        return;
      }
      completeTurn();
    };

    // Continuously drain the session's persistent input channel, mirroring
    // the real SDK transport: each consumed message resolves its caller-side
    // delivery promise (sendPrompt push / queueUserInput).
    void (async () => {
      for await (const msg of args.prompt) {
        handleUserMessage(msg);
      }
    })();

    const port: ClaudeSdkQueryPort = {
      async awaitChildCollection() {},
      close() {
        closed = true;
        wake?.();
        wake = null;
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
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        return {
          async next(): Promise<IteratorResult<SDKMessage>> {
            while (true) {
              const message = outgoing.shift();
              if (message !== undefined) {
                return { value: message, done: false };
              }
              if (closed) {
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
        };
      },
    };

    lastPort = { emit };
    return port;
  };

  return {
    createSdkQuery,
    get lastOptions() {
      return lastOptions;
    },
    get lastPromptText() {
      return lastPromptText;
    },
    pushExternalTurn() {
      if (!lastPort) {
        throw new Error(
          "pushExternalTurn: no fake Claude port created yet — create a runtime first",
        );
      }
      lastPort.emit(buildAssistantMessage("external continuation"));
      lastPort.emit(buildResultSuccess(undefined));
    },
  };
}

// ============================================================
// Task-runner provider port
// ============================================================

export const FAKE_CLAUDE_TASK_TEXT = "conformance scripted claude task";

export interface FakeClaudeTaskPort {
  deps: ClaudeTaskRunnerDeps;
  /** Options captured from the most recent `runQuery` call. */
  readonly lastOptions: Options | null;
  /** Prompt captured from the most recent `runQuery` call. */
  readonly lastPrompt: string | undefined;
}

/**
 * @param config.structuredOutput native `structured_output` carried by the
 * scripted result whenever the run requested an `outputFormat`.
 */
export function createFakeClaudeTaskPort(
  config: { structuredOutput?: unknown } = {},
): FakeClaudeTaskPort {
  let lastOptions: Options | null = null;
  let lastPrompt: string | undefined;

  const deps: ClaudeTaskRunnerDeps = {
    runQuery(args) {
      lastOptions = args.options;
      lastPrompt = args.prompt;
      const structuredOutput =
        args.options.outputFormat !== undefined
          ? config.structuredOutput
          : undefined;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield buildAssistantMessage(FAKE_CLAUDE_TASK_TEXT);
        yield buildResultSuccess(structuredOutput);
      })();
    },
    // Conformance runs carry no `ccSessionScope`, so no session env contract
    // is ever built from these.
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => "/conformance/config",
  };

  return {
    deps,
    get lastOptions() {
      return lastOptions;
    },
    get lastPrompt() {
      return lastPrompt;
    },
  };
}
