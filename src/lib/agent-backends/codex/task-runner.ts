import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { buildChildEnv } from "@/lib/shared/child-env";
import { neutralizeAmbientCcEnv } from "@/lib/agent-gateway/session-env";
import { createLogger } from "@/lib/logging";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "../task";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  toRawTranscriptEntries,
  type AgentTranscriptEntry,
} from "../transcript";
import { translatePortableMcpToCodex } from "./mcp-translation";
import {
  buildCodexMcpServersConfig,
  listNativeCodexMcpServers,
  type NativeCodexMcpServer,
} from "./native-mcp-suppression";
import {
  codexReasoningEffortSchema,
  getDefaultCodexModel,
  type CodexPricingTable,
  type CodexReasoningEffort,
} from "@/lib/agent-backends/schemas";
import { readConfig } from "@/lib/config/loader";
import { estimateCodexCostUsd } from "./pricing";
import {
  CODEX_DEFAULT_STALL_TIMEOUT_MS,
  toSdkModelReasoningEffort,
  toStringEnv,
} from "./shared";
import { createStallWatchdog } from "../stall-watchdog";
import { getErrorMessage } from "@/lib/shared/errors";
import { createCodexFailureClassifier } from "./failure-classifier";

const logger = createLogger("codex:task-runner");
const codexFailureClassifier = createCodexFailureClassifier();

function classifiedContinuation(
  backendRef: AgentSessionRef | null,
  error: unknown,
): Pick<AgentTaskResult, "backendRef" | "failure" | "continuationDisposition"> {
  const { failure, continuationDisposition } =
    codexFailureClassifier.classifyWithContinuation(error);
  return {
    backendRef: continuationDisposition === "clear" ? null : backendRef,
    failure,
    continuationDisposition,
  };
}

interface CodexTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

interface CodexTaskTurn {
  finalResponse?: string;
  items?: unknown[];
  usage?: CodexTurnUsage | null;
  error?: string | null;
}

interface CodexTaskThread {
  readonly id: string | null;
  run(
    input: CodexTaskInput,
    options?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<CodexTaskTurn>;
  runStreamed?(
    input: CodexTaskInput,
    options?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<unknown> }>;
}

type CodexTaskInput =
  | string
  | Array<
      { type: "text"; text: string } | { type: "local_image"; path: string }
    >;

interface CodexTaskRunnerClient {
  startThread(options?: ThreadOptions): CodexTaskThread;
  resumeThread(id: string, options?: ThreadOptions): CodexTaskThread;
}

export interface CodexTaskRunnerDeps {
  createCodex(options: CodexOptions): CodexTaskRunnerClient;
  buildChildEnv(): NodeJS.ProcessEnv;
  listNativeCodexMcpServers(input: {
    cwd: string;
    env: Record<string, string>;
  }): Promise<NativeCodexMcpServer[]>;
  /** Per-model rate overrides from `codex.pricing` in config.json; null when unset. */
  getCodexPricingOverrides(): Promise<CodexPricingTable | null>;
}

const defaultDeps: CodexTaskRunnerDeps = {
  createCodex: (options) =>
    new Codex(options) as unknown as CodexTaskRunnerClient,
  buildChildEnv,
  listNativeCodexMcpServers,
  getCodexPricingOverrides: async () =>
    (await readConfig()).codex?.pricing ?? null,
};

function buildPrompt(input: AgentTaskRequest): CodexTaskInput {
  const parts: string[] = [];

  if (input.systemInstructions?.length) {
    parts.push(
      "```\n## System Instructions\n" +
        input.systemInstructions.join("\n\n") +
        "\n```",
    );
  }

  parts.push(input.prompt);

  const prompt = parts.join("\n\n");
  if (!input.imagePaths?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...input.imagePaths.map((path) => ({ type: "local_image" as const, path })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eventMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const message = value.message;
  return typeof message === "string" ? message : null;
}

async function runCodexTurn(
  thread: CodexTaskThread,
  prompt: CodexTaskInput,
  options: {
    outputSchema?: unknown;
    signal?: AbortSignal;
    onActivity?: () => void;
  },
): Promise<CodexTaskTurn> {
  if (typeof thread.runStreamed !== "function") {
    return thread.run(prompt, options);
  }

  const streamed = await thread.runStreamed(prompt, options);
  const items: unknown[] = [];
  let finalResponse = "";
  let usage: CodexTurnUsage | null = null;
  let error: string | null = null;

  for await (const event of streamed.events) {
    options.onActivity?.();
    if (!isRecord(event) || typeof event.type !== "string") continue;

    if (event.type === "item.completed") {
      const item = event.item;
      items.push(item);
      if (
        isRecord(item) &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        finalResponse = item.text;
      }
      continue;
    }

    if (event.type === "turn.completed") {
      usage = isRecord(event.usage)
        ? (event.usage as unknown as CodexTurnUsage)
        : null;
      continue;
    }

    if (event.type === "turn.failed") {
      error = eventMessage(event.error) ?? "Codex turn failed";
      break;
    }

    if (event.type === "error") {
      error = eventMessage(event) ?? "Codex stream failed";
      break;
    }
  }

  return { items, finalResponse, usage, error };
}

// ============================================================
// Codex Task Runner
// ============================================================

export class CodexTaskRunner implements AgentTaskRunner {
  readonly backend: AgentBackendId = "codex";

  constructor(private readonly deps: CodexTaskRunnerDeps = defaultDeps) {}

  async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
    if (input.executionProfile === "isolated-one-shot") {
      const error =
        'CodexTaskRunner does not support execution profile "isolated-one-shot"';
      logger.warn("codex-task-runner.execution_profile_unsupported", {
        workingDirectory: input.workingDirectory,
        executionProfile: input.executionProfile,
      });
      return {
        backendRef: null,
        text: null,
        usage: null,
        error,
        timedOut: false,
        failure: {
          kind: "capability_unavailable",
          message: error,
          retryable: false,
        },
        continuationDisposition: "retain",
      };
    }

    let validatedReasoningEffort: CodexReasoningEffort | undefined;
    if (input.reasoningEffort !== undefined) {
      const effortResult = codexReasoningEffortSchema.safeParse(
        input.reasoningEffort,
      );
      if (!effortResult.success) {
        const error = `Invalid Codex reasoning effort: "${input.reasoningEffort}"`;
        logger.error("codex-task-runner.invalid_reasoning_effort", {
          workingDirectory: input.workingDirectory,
          reasoningEffort: input.reasoningEffort,
        });
        return {
          ...classifiedContinuation(
            input.resumeRef?.backend === "codex" ? input.resumeRef : null,
            error,
          ),
          text: null,
          usage: null,
          error,
          timedOut: false,
        };
      }
      validatedReasoningEffort = effortResult.data;
    }

    const threadOptions: ThreadOptions = {
      workingDirectory: input.workingDirectory,
      sandboxMode: input.sandboxMode ?? "danger-full-access",
      approvalPolicy: input.approvalPolicy ?? "never",
      webSearchMode: input.webSearchMode ?? "disabled",
      skipGitRepoCheck: input.skipGitRepoCheck ?? true,
      ...(input.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: input.networkAccessEnabled }
        : {}),
      ...(input.additionalDirectories
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      // Always pin a model. With no model the Codex SDK falls back to its own
      // built-in default, which is rejected for ChatGPT-account auth.
      model: input.modelId ?? getDefaultCodexModel(),
      ...(validatedReasoningEffort
        ? {
            modelReasoningEffort: toSdkModelReasoningEffort(
              validatedReasoningEffort,
            ),
          }
        : {}),
    };

    logger.info("codex-task-runner.start", {
      workingDirectory: input.workingDirectory,
      hasResume: !!input.resumeRef,
      timeoutMs: input.timeoutMs,
      sandboxMode: threadOptions.sandboxMode,
      approvalPolicy: threadOptions.approvalPolicy,
      webSearchMode: threadOptions.webSearchMode,
      skipGitRepoCheck: threadOptions.skipGitRepoCheck,
      executionProfile: input.executionProfile ?? "standard",
    });

    if (input.resumeRef != null && input.resumeRef.backend !== "codex") {
      const error = `Cannot resume a ${input.resumeRef.backend} session with CodexTaskRunner`;
      logger.error("codex-task-runner.resume_backend_mismatch", {
        resumeBackend: input.resumeRef.backend,
      });
      return {
        ...classifiedContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    // Task subprocesses get no session-env contract, so ambient CC_* (an
    // outer instance's server URL/token) must be blanked here. Copy before
    // neutralizing — the helper mutates, and an injected dep may hand out a
    // shared object.
    const env = toStringEnv({
      ...neutralizeAmbientCcEnv({ ...this.deps.buildChildEnv() }),
      CLAUDECODE: "",
    });
    let mcpServersConfig: Record<string, unknown> | undefined;
    if (input.tooling?.portableMcp) {
      const translated = translatePortableMcpToCodex(input.tooling.portableMcp);
      if (translated.droppedFields.length > 0) {
        logger.warn("codex-task-runner.mcp_dropped_fields", {
          droppedFields: translated.droppedFields,
        });
      }
      const nativeServers = await listNativeMcpServers(
        input.workingDirectory,
        env,
        this.deps,
      );
      mcpServersConfig = buildCodexMcpServersConfig({
        managedMcpServers: translated.mcpServers,
        nativeServers,
      });
      logger.info("codex-task-runner.mcp_config", {
        serverCount: Object.keys(mcpServersConfig).length,
        managedServerCount: Object.keys(translated.mcpServers).length,
        disabledNativeServerCount:
          Object.keys(mcpServersConfig).length -
          Object.keys(translated.mcpServers).length,
      });
    }

    const codexOptions: CodexOptions = {
      env,
      ...(mcpServersConfig !== undefined
        ? {
            config: { mcp_servers: mcpServersConfig } as CodexOptions["config"],
          }
        : {}),
    };

    const prompt = buildPrompt(input);

    const abortController = new AbortController();
    let timedOut = false;

    // timeoutMs=0 means "no timeout" — skip the timer entirely
    const timeoutHandle =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            logger.warn("codex-task-runner.timeout", {
              workingDirectory: input.workingDirectory,
              timeoutMs: input.timeoutMs,
            });
            abortController.abort();
          }, input.timeoutMs)
        : null;

    // Fold an external cancellation signal into the same abort path so a
    // job-shaped caller can cancel a live run.
    const externalSignal = input.signal;
    const onExternalAbort = () => abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abortController.abort();
      else externalSignal.addEventListener("abort", onExternalAbort);
    }

    // Inactivity watchdog: unlike the whole-run timeout above, this only
    // trips on dead air — every streamed thread event resets it.
    const stallTimeoutMs =
      input.stallTimeoutMs ?? CODEX_DEFAULT_STALL_TIMEOUT_MS;
    const stallWatchdog = createStallWatchdog({
      stallTimeoutMs,
      onStall: () => {
        logger.warn("codex-task-runner.stalled", {
          workingDirectory: input.workingDirectory,
          stallTimeoutMs,
        });
        abortController.abort();
      },
    });

    let threadId: string | null = null;
    let text: string | null = null;
    let structuredOutput: unknown;
    let usageResult: AgentTaskResult["usage"] = null;
    let transcript: AgentTranscriptEntry[] | undefined;
    let error: string | null = null;
    let processFailed = false;
    const wasResume = input.resumeRef?.backend === "codex";

    try {
      const codex = this.deps.createCodex(codexOptions);

      let thread;
      if (input.resumeRef?.backend === "codex") {
        logger.info("codex-task-runner.resume", {
          threadId: input.resumeRef.ref,
        });
        thread = codex.resumeThread(input.resumeRef.ref, threadOptions);
      } else {
        thread = codex.startThread(threadOptions);
      }

      const turn = await runCodexTurn(thread, prompt, {
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
        signal: abortController.signal,
        onActivity: () => stallWatchdog.touch(),
      });

      // Read the thread id only after the turn: the SDK assigns a fresh
      // thread's id when the `thread.started` event arrives mid-run.
      threadId = thread.id;

      if (turn.items && turn.items.length > 0) {
        transcript = toRawTranscriptEntries("codex", turn.items);
      }

      if (turn.error) {
        error = turn.error;
        logger.warn("codex-task-runner.turn_failed", {
          workingDirectory: input.workingDirectory,
          error,
        });
      }

      if (turn.finalResponse) {
        text = turn.finalResponse;

        if (input.outputSchema && !turn.error) {
          try {
            structuredOutput = JSON.parse(turn.finalResponse);
          } catch {
            // finalResponse is not valid JSON despite outputSchema being set
          }
        }
      }

      if (turn.usage) {
        let pricingOverrides: CodexPricingTable | null = null;
        try {
          pricingOverrides = await this.deps.getCodexPricingOverrides();
        } catch (err) {
          logger.warn("codex-task-runner.pricing_overrides_unavailable", {
            workingDirectory: input.workingDirectory,
            error: getErrorMessage(err),
          });
        }
        usageResult = {
          inputTokens: turn.usage.input_tokens,
          cachedInputTokens: turn.usage.cached_input_tokens,
          outputTokens: turn.usage.output_tokens,
          costUsd: estimateCodexCostUsd(
            turn.usage,
            input.modelId ?? getDefaultCodexModel(),
            pricingOverrides,
          ),
        };
      }
    } catch (err) {
      if (!timedOut) {
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError" || name === "TimeoutError") {
          timedOut = true;
        } else {
          processFailed = true;
          error = getErrorMessage(err);
          logger.error("codex-task-runner.run_error", {
            workingDirectory: input.workingDirectory,
            error,
          });
        }
      }
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      stallWatchdog.cancel();
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    const candidateBackendRef = threadId
      ? { backend: "codex" as const, ref: threadId }
      : wasResume
        ? input.resumeRef!
        : null;
    // A stall abort may surface as an AbortError throw or as a graceful
    // turn.failed reply to the interrupt; either way the stall is the cause.
    const stalled = stallWatchdog.fired();
    if (stalled) timedOut = true;
    const finalError = stalled
      ? `Task stalled: no backend activity for ${stallTimeoutMs}ms`
      : (error ?? (timedOut ? "Task timed out" : null));
    const failure =
      finalError === null ? null : codexFailureClassifier.classify(finalError);
    const continuationDisposition =
      failure?.kind === "stale_resume_ref" ||
      (failure !== null && processFailed && !wasResume)
        ? "clear"
        : "retain";
    const backendRef =
      continuationDisposition === "clear" ? null : candidateBackendRef;

    logger.info("codex-task-runner.complete", {
      workingDirectory: input.workingDirectory,
      threadId,
      timedOut,
      stalled,
      hasError: !!error,
      executionProfile: input.executionProfile ?? "standard",
    });

    return {
      backendRef,
      text,
      structuredOutput,
      usage: usageResult,
      ...(transcript ? { transcript } : {}),
      error: finalError,
      timedOut,
      failure,
      continuationDisposition,
    };
  }
}

async function listNativeMcpServers(
  cwd: string,
  env: Record<string, string>,
  deps: Pick<CodexTaskRunnerDeps, "listNativeCodexMcpServers">,
): Promise<NativeCodexMcpServer[]> {
  try {
    const servers = await deps.listNativeCodexMcpServers({ cwd, env });
    logger.info("codex-task-runner.mcp_native_servers_listed", {
      workingDirectory: cwd,
      nativeServerCount: servers.length,
    });
    return servers;
  } catch (err) {
    logger.warn("codex-task-runner.mcp_native_server_list_failed", {
      workingDirectory: cwd,
      error: getErrorMessage(err),
    });
    return [];
  }
}

export const codexTaskRunner = new CodexTaskRunner();
