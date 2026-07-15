/**
 * Fake Codex provider ports (test-only) for the backend conformance suite.
 *
 * Supplies `CodexConversationRuntimeDeps` and `CodexTaskRunnerDeps` whose
 * `createCodex` returns scripted threads, so the REAL
 * `CodexConversationRuntime` and `CodexTaskRunner` execute their full turn
 * pipelines (event interpretation, failure classification, continuation
 * disposition, cost estimation) without spawning a codex process.
 *
 * Turn behavior is keyed by prompt text: the hanging prompt yields a stream
 * that only terminates by rejecting with an `AbortError` when the turn's
 * signal aborts — the production cancellation shape.
 */

import type { Input, ThreadEvent, TurnOptions, Usage } from "@openai/codex-sdk";
import type {
  CodexConversationRuntimeDeps,
  CodexThreadLike,
} from "../codex/conversation-runtime";
import type { CodexTaskRunnerDeps } from "../codex/task-runner";

export const FAKE_CODEX_THREAD_ID = "conformance-codex-thread-1";
export const FAKE_CODEX_TURN_TEXT = "conformance scripted codex turn";
export const FAKE_CODEX_INPUT_TOKENS = 777;

/** Prompt the fake thread never completes — hangs until the signal aborts. */
export const FAKE_CODEX_HANGING_PROMPT = "conformance: hang this codex turn";

function buildUsage(): Usage {
  return {
    input_tokens: FAKE_CODEX_INPUT_TOKENS,
    cached_input_tokens: 10,
    output_tokens: 42,
    reasoning_output_tokens: 0,
  };
}

function extractInputText(input: Input): string {
  if (typeof input === "string") return input;
  for (const item of input) {
    if (item.type === "text") return item.text;
  }
  return "";
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function successEvents(agentText: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: FAKE_CODEX_THREAD_ID },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: agentText },
    },
    { type: "turn.completed", usage: buildUsage() },
  ];
}

async function* hangingEventStream(
  signal: AbortSignal | undefined,
): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: FAKE_CODEX_THREAD_ID };
  await new Promise<void>((resolve) => {
    if (!signal) return; // no signal — hang forever (callers always pass one)
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  throw abortError();
}

export interface FakeCodexProvider {
  deps: CodexConversationRuntimeDeps;
  /** Turn options captured from the most recent `runStreamed` call. */
  readonly lastTurnOptions: TurnOptions | undefined;
}

/**
 * @param config.structuredOutput when the turn requests an `outputSchema`,
 * the scripted agent message carries this value as JSON text — the Codex
 * native structured-output shape the runtime parses.
 */
export function createFakeCodexProvider(
  config: { structuredOutput?: unknown } = {},
): FakeCodexProvider {
  let lastTurnOptions: TurnOptions | undefined;

  function makeThread(): CodexThreadLike {
    return {
      id: FAKE_CODEX_THREAD_ID,
      async runStreamed(
        input: Input,
        turnOptions?: TurnOptions,
      ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
        lastTurnOptions = turnOptions;
        const text = extractInputText(input);

        if (text.includes(FAKE_CODEX_HANGING_PROMPT)) {
          return { events: hangingEventStream(turnOptions?.signal) };
        }

        const agentText =
          turnOptions?.outputSchema !== undefined &&
          config.structuredOutput !== undefined
            ? JSON.stringify(config.structuredOutput)
            : FAKE_CODEX_TURN_TEXT;

        return {
          events: (async function* () {
            for (const event of successEvents(agentText)) {
              yield event;
            }
          })(),
        };
      },
    };
  }

  const deps: CodexConversationRuntimeDeps = {
    createCodex() {
      return {
        startThread: () => makeThread(),
        resumeThread: () => makeThread(),
      };
    },
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    toStringEnv(env) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) result[key] = value;
      }
      return result;
    },
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => "/conformance/config",
    translatePortableMcpToCodex: () => ({ mcpServers: {}, droppedFields: [] }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    now: () => Date.now(),
  };

  return {
    deps,
    get lastTurnOptions() {
      return lastTurnOptions;
    },
  };
}

// ============================================================
// Task-runner provider port
// ============================================================

export const FAKE_CODEX_TASK_TEXT = "conformance scripted codex task";
export const FAKE_CODEX_TASK_THREAD_ID = "conformance-codex-task-thread-1";

export interface FakeCodexTaskPort {
  deps: CodexTaskRunnerDeps;
  /** `outputSchema` captured from the most recent thread run. */
  readonly lastOutputSchema: unknown;
}

/**
 * @param config.structuredOutput final response carried as JSON text when the
 * task requests an `outputSchema` (the runner parses it natively).
 */
export function createFakeCodexTaskPort(
  config: { structuredOutput?: unknown } = {},
): FakeCodexTaskPort {
  let lastOutputSchema: unknown;

  const deps: CodexTaskRunnerDeps = {
    createCodex() {
      const thread = {
        id: FAKE_CODEX_TASK_THREAD_ID,
        async run(
          _input: string,
          options?: { outputSchema?: unknown; signal?: AbortSignal },
        ) {
          lastOutputSchema = options?.outputSchema;
          const finalResponse =
            options?.outputSchema !== undefined &&
            config.structuredOutput !== undefined
              ? JSON.stringify(config.structuredOutput)
              : FAKE_CODEX_TASK_TEXT;
          return {
            finalResponse,
            items: [
              { id: "item-1", type: "agent_message", text: finalResponse },
            ],
            usage: {
              input_tokens: FAKE_CODEX_INPUT_TOKENS,
              cached_input_tokens: 10,
              output_tokens: 42,
            },
            error: null,
          };
        },
      };
      return {
        startThread: () => thread,
        resumeThread: () => thread,
      };
    },
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
  };

  return {
    deps,
    get lastOutputSchema() {
      return lastOutputSchema;
    },
  };
}
