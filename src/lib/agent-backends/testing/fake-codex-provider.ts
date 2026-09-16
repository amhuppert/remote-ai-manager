/** Test provider ports: app-server conversations and SDK tasks stay independent. */
import type { Input } from "@openai/codex-sdk";
import { z } from "zod";
import type { CodexConversationRuntimeDeps } from "../codex/conversation-runtime";
import type {
  AppServerClientOptions,
  AppServerClient,
} from "../codex/app-server-client";
import { parseAppServerFrame } from "../codex/app-server-protocol";
import type { CodexInstructionRecord } from "../codex/instruction-state";
import {
  CodexTaskRunner,
  type CodexTaskRunnerDeps,
} from "../codex/task-runner";
import type { AgentTaskRunner } from "../task";

export const FAKE_CODEX_THREAD_ID = "conformance-codex-thread-1";
export const FAKE_CODEX_TURN_TEXT = "conformance scripted codex turn";
export const FAKE_CODEX_INPUT_TOKENS = 777;

/** Prompt the fake thread never completes — hangs until the signal aborts. */
export const FAKE_CODEX_HANGING_PROMPT = "conformance: hang this codex turn";
export const FAKE_CODEX_QUEUE_HOLD_PROMPT =
  "conformance: hold for codex queued input";

function extractInputText(input: Input): string {
  if (typeof input === "string") return input;
  for (const item of input) {
    if (item.type === "text") return item.text;
  }
  return "";
}

export interface FakeCodexProvider {
  deps: CodexConversationRuntimeDeps;
  readonly lastOutputSchema: unknown;
  readonly lastPrompt: string;
}

export function createFakeCodexProvider(
  config: { structuredOutput?: unknown; onQueueReady?(): void } = {},
): FakeCodexProvider {
  let lastOutputSchema: unknown;
  let lastPrompt = "";
  const instructions = new Map<string, CodexInstructionRecord>();
  let turnSequence = 0;
  function createAppServer(options: AppServerClientOptions): AppServerClient {
    let chain = Promise.resolve();
    let closed = false;
    let turnId = "";
    let barrier = Promise.resolve();
    function emit(method: string, params: unknown): void {
      if (closed) return;
      const raw = JSON.stringify({ method, params });
      const frame = parseAppServerFrame(raw, Buffer.byteLength(raw));
      if (frame.message.kind === "notification")
        options.onNotification?.(frame.message);
      chain = chain.then(async () => {
        await barrier;
        await options.onFrame(frame);
      });
      void chain.catch((error) =>
        options.onFailure(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
    function complete(status: string): void {
      emit("turn/completed", {
        threadId: FAKE_CODEX_THREAD_ID,
        turn: { id: turnId, status, error: null, items: [] },
      });
    }
    return {
      async request(method, unknownParams) {
        const params = z.record(z.string(), z.unknown()).parse(unknownParams);
        if (method === "initialize") return { userAgent: "fake-codex" };
        if (method === "thread/start" || method === "thread/resume")
          return {
            thread: { id: FAKE_CODEX_THREAD_ID, turns: [] },
            model: params.model,
            modelProvider: "openai",
            cwd: params.cwd,
            approvalPolicy: params.approvalPolicy,
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: "medium",
            serviceTier: null,
          };
        if (method === "thread/inject_items") return {};
        if (method === "turn/interrupt") {
          complete("interrupted");
          return {};
        }
        if (method === "turn/steer") {
          if (lastPrompt.includes(FAKE_CODEX_QUEUE_HOLD_PROMPT)) {
            emit("item/completed", {
              threadId: FAKE_CODEX_THREAD_ID,
              turnId,
              item: {
                id: `${turnId}-queued-item`,
                type: "agentMessage",
                text: FAKE_CODEX_TURN_TEXT,
                phase: "final_answer",
              },
            });
            complete("completed");
          }
          return { turnId };
        }
        if (method !== "turn/start")
          throw new Error(`Unexpected fake app-server method: ${method}`);
        turnId = `conformance-turn-${++turnSequence}`;
        lastOutputSchema = params.outputSchema;
        const inputs = z
          .array(
            z.looseObject({ type: z.string(), text: z.string().optional() }),
          )
          .parse(params.input);
        lastPrompt = inputs
          .filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n");
        const active = {
          id: turnId,
          status: "inProgress",
          error: null,
          items: [],
        };
        emit("turn/started", { threadId: FAKE_CODEX_THREAD_ID, turn: active });
        if (lastPrompt.includes(FAKE_CODEX_QUEUE_HOLD_PROMPT)) {
          void chain.then(
            () => config.onQueueReady?.(),
            () => {},
          );
        } else if (!lastPrompt.includes(FAKE_CODEX_HANGING_PROMPT)) {
          const text =
            lastPrompt.includes(
              "Your final message must be a single JSON object",
            ) && config.structuredOutput !== undefined
              ? JSON.stringify(config.structuredOutput)
              : FAKE_CODEX_TURN_TEXT;
          emit("item/completed", {
            threadId: FAKE_CODEX_THREAD_ID,
            turnId,
            item: {
              id: `${turnId}-item`,
              type: "agentMessage",
              text,
              phase: "final_answer",
            },
          });
          const total = {
            inputTokens: FAKE_CODEX_INPUT_TOKENS,
            cachedInputTokens: 10,
            cacheWriteInputTokens: 0,
            outputTokens: 42,
            reasoningOutputTokens: 0,
            totalTokens: FAKE_CODEX_INPUT_TOKENS + 42,
          };
          emit("thread/tokenUsage/updated", {
            threadId: FAKE_CODEX_THREAD_ID,
            turnId,
            tokenUsage: { last: total, total },
          });
          complete("completed");
        }
        return { turn: active };
      },
      notify() {},
      barrier() {
        const pending = Promise.withResolvers<void>();
        barrier = barrier.then(() => pending.promise);
        return {
          release: pending.resolve,
          fail(error) {
            pending.resolve();
            options.onFailure(error);
          },
        };
      },
      async flush() {
        await chain;
      },
      async close() {
        closed = true;
        await chain;
      },
      stderrTail: "",
    };
  }
  const deps: CodexConversationRuntimeDeps = {
    createAppServer,
    createInstructionStore(conversationId) {
      return {
        async readLatest(threadRef) {
          return instructions.get(`${conversationId}:${threadRef}`) ?? null;
        },
        async write(record) {
          instructions.set(`${conversationId}:${record.threadRef}`, record);
        },
      };
    },
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    toStringEnv(env) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env))
        if (value !== undefined) result[key] = value;
      return result;
    },
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => "/conformance/config",
    ensureManagedSkillsBridge: async () =>
      ({ status: "skipped", reason: "no_bundle" }) as const,
    translatePortableMcpToCodex: () => ({ mcpServers: {}, droppedFields: [] }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    readPersistedCostBaseline: async () => null,
    now: () => Date.now(),
  };
  return {
    deps,
    get lastOutputSchema() {
      return lastOutputSchema;
    },
    get lastPrompt() {
      return lastPrompt;
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
  readonly lastPrompt: string;
}

/**
 * @param config.structuredOutput scripted final-message JSON for schema prompts.
 */
export function createFakeCodexTaskPort(
  config: { structuredOutput?: unknown } = {},
): FakeCodexTaskPort {
  let lastOutputSchema: unknown;
  let lastPrompt = "";

  const deps: CodexTaskRunnerDeps = {
    createCodex() {
      // Model the real SDK's id lifecycle: a fresh thread has `id: null`
      // until the `thread.started` event arrives during its first run, while
      // a resumed thread knows its id at construction.
      function makeThread(initialId: string | null) {
        const thread = {
          id: initialId,
          async run(
            input: Input,
            options?: { outputSchema?: unknown; signal?: AbortSignal },
          ) {
            thread.id = thread.id ?? FAKE_CODEX_TASK_THREAD_ID;
            lastOutputSchema = options?.outputSchema;
            lastPrompt = extractInputText(input);
            const finalResponse =
              lastPrompt.includes(
                "Your final message must be a single JSON object",
              ) && config.structuredOutput !== undefined
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
        return thread;
      }
      return {
        startThread: () => makeThread(null),
        resumeThread: (id: string) => makeThread(id),
      };
    },
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    // Conformance runs carry no `ccSessionScope`, so no session env contract
    // is ever built from these.
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => "/conformance/config",
    ensureManagedSkillsBridge: async () =>
      ({ status: "skipped", reason: "no_bundle" }) as const,
  };

  return {
    deps,
    get lastOutputSchema() {
      return lastOutputSchema;
    },
    get lastPrompt() {
      return lastPrompt;
    },
  };
}

export interface EnvCapturingCodexTaskRunner {
  runner: AgentTaskRunner;
  /** Child env of each Codex client the runner spawned, oldest first. */
  readonly capturedEnvs: ReadonlyArray<Record<string, string>>;
}

/**
 * The REAL `CodexTaskRunner` over a capturing provider, exposing the child env
 * it would spawn a codex process with.
 *
 * Lives on the backend testing surface because the runner class itself is an
 * adapter internal: a consumer outside `src/lib/agent-backends/` (e.g. the
 * collaboration production caller) cannot import it, yet proving what identity
 * and credentials reach a task subprocess requires the real env construction,
 * not a request-shaped assertion that stops at the seam.
 */
export function createEnvCapturingCodexTaskRunner(config: {
  ambientEnv: NodeJS.ProcessEnv;
  /** Server coordinates the runner resolves server-side for a scoped run. */
  serverUrl?: string | null;
  apiToken?: string | null;
  configDir?: string;
}): EnvCapturingCodexTaskRunner {
  const capturedEnvs: Array<Record<string, string>> = [];

  const runner = new CodexTaskRunner({
    createCodex: (options) => {
      capturedEnvs.push(options.env ?? {});
      const thread = {
        id: null as string | null,
        async run() {
          thread.id = thread.id ?? FAKE_CODEX_TASK_THREAD_ID;
          return {
            finalResponse: FAKE_CODEX_TASK_TEXT,
            usage: {
              input_tokens: FAKE_CODEX_INPUT_TOKENS,
              cached_input_tokens: 10,
              output_tokens: 42,
            },
            error: null,
          };
        },
      };
      return { startThread: () => thread, resumeThread: () => thread };
    },
    buildChildEnv: () => ({ ...config.ambientEnv }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    getServerUrl: () => config.serverUrl ?? null,
    getApiToken: () => config.apiToken ?? null,
    getConfigDir: () => config.configDir ?? "/conformance/config",
    ensureManagedSkillsBridge: async () =>
      ({ status: "skipped", reason: "no_bundle" }) as const,
  });

  return { runner, capturedEnvs };
}
