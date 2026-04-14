import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { buildChildEnv } from "@/lib/child-env";
import { createLogger } from "@/lib/logging";
import { registerTaskRunner } from "../registry-core";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "../task";
import type { AgentBackendId } from "../types";
import { translatePortableMcpToCodex } from "./mcp-translation";
import {
  codexReasoningEffortSchema,
  type CodexReasoningEffort,
} from "@/lib/schemas";
import { toStringEnv } from "./shared";

const logger = createLogger("codex:task-runner");

function buildPrompt(input: AgentTaskRequest): string {
  const parts: string[] = [];

  if (input.systemInstructions?.length) {
    parts.push(
      "```\n## System Instructions\n" +
        input.systemInstructions.join("\n\n") +
        "\n```",
    );
  }

  parts.push(input.prompt);

  return parts.join("\n\n");
}

// ============================================================
// Codex Task Runner
// ============================================================

export class CodexTaskRunner implements AgentTaskRunner {
  readonly backend: AgentBackendId = "codex";

  async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
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
          backendRef: null,
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
      sandboxMode: input.sandboxMode ?? "workspace-write",
      approvalPolicy: input.approvalPolicy ?? "never",
      webSearchMode: input.webSearchMode ?? "disabled",
      skipGitRepoCheck: input.skipGitRepoCheck ?? true,
      ...(input.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: input.networkAccessEnabled }
        : {}),
      ...(input.additionalDirectories
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(validatedReasoningEffort
        ? { modelReasoningEffort: validatedReasoningEffort }
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
    });

    if (input.resumeRef != null && input.resumeRef.backend !== "codex") {
      const error = `Cannot resume a ${input.resumeRef.backend} session with CodexTaskRunner`;
      logger.error("codex-task-runner.resume_backend_mismatch", {
        resumeBackend: input.resumeRef.backend,
      });
      return {
        backendRef: null,
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    // Handle claudeSdkServers — not supported by Codex, log warning
    if (input.tooling?.claudeSdkServers) {
      const droppedServerIds = Object.keys(input.tooling.claudeSdkServers);
      logger.warn("codex-task-runner.dropped_claude_sdk_servers", {
        droppedServerIds,
      });
    }

    // Build MCP config from portable MCP
    let mcpServersConfig: Record<string, unknown> | undefined;
    if (input.tooling?.portableMcp) {
      const { mcpServers, droppedFields } = translatePortableMcpToCodex(
        input.tooling.portableMcp,
      );
      if (droppedFields.length > 0) {
        logger.warn("codex-task-runner.mcp_dropped_fields", { droppedFields });
      }
      if (Object.keys(mcpServers).length > 0) {
        mcpServersConfig = mcpServers;
        logger.info("codex-task-runner.mcp_config", {
          serverCount: Object.keys(mcpServers).length,
        });
      }
    }

    const codexOptions: CodexOptions = {
      env: toStringEnv({ ...buildChildEnv(), CLAUDECODE: "" }),
      ...(mcpServersConfig
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

    let threadId: string | null = null;
    let text: string | null = null;
    let structuredOutput: unknown;
    let usageResult: AgentTaskResult["usage"] = null;
    let error: string | null = null;

    try {
      const codex = new Codex(codexOptions);

      let thread;
      if (input.resumeRef?.backend === "codex") {
        logger.info("codex-task-runner.resume", {
          threadId: input.resumeRef.threadId,
        });
        thread = codex.resumeThread(input.resumeRef.threadId, threadOptions);
      } else {
        thread = codex.startThread(threadOptions);
      }

      const turn = await thread.run(prompt, {
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
        signal: abortController.signal,
      });

      threadId = thread.id;

      if (turn.finalResponse) {
        text = turn.finalResponse;

        if (input.outputSchema) {
          try {
            structuredOutput = JSON.parse(turn.finalResponse);
          } catch {
            // finalResponse is not valid JSON despite outputSchema being set
          }
        }
      }

      if (turn.usage) {
        usageResult = {
          inputTokens: turn.usage.input_tokens,
          cachedInputTokens: turn.usage.cached_input_tokens,
          outputTokens: turn.usage.output_tokens,
        };
      }
    } catch (err) {
      if (!timedOut) {
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError" || name === "TimeoutError") {
          timedOut = true;
        } else {
          error = err instanceof Error ? err.message : String(err);
          logger.error("codex-task-runner.run_error", {
            workingDirectory: input.workingDirectory,
            error,
          });
        }
      }
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }

    const backendRef = threadId
      ? { backend: "codex" as const, threadId }
      : null;

    logger.info("codex-task-runner.complete", {
      workingDirectory: input.workingDirectory,
      threadId,
      timedOut,
      hasError: !!error,
    });

    return {
      backendRef,
      text,
      structuredOutput,
      usage: usageResult,
      error: error ?? (timedOut ? "Task timed out" : null),
      timedOut,
    };
  }
}

// ============================================================
// Register task runner
// ============================================================

export const codexTaskRunner = new CodexTaskRunner();
registerTaskRunner(codexTaskRunner);
