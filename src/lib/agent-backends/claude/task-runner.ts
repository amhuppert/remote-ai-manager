import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKAssistantMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildChildEnv } from "@/lib/shared/child-env";
import { createLogger } from "@/lib/logging";
import { registerTaskRunner } from "../registry-core";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "../task";
import type { AgentBackendId } from "../types";
import { translatePortableMcpToClaude } from "../mcp-translation";
import {
  claudeEffortLevelSchema,
  type ClaudeEffortLevel,
} from "@/lib/agent-backends/schemas";
// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/shared/sdk-env";

const logger = createLogger("claude:task-runner");

// ============================================================
// Claude Task Runner
// ============================================================

export class ClaudeTaskRunner implements AgentTaskRunner {
  readonly backend: AgentBackendId = "claude";

  async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
    logger.info("claude-task-runner.start", {
      workingDirectory: input.workingDirectory,
      hasResume: !!input.resumeRef,
      timeoutMs: input.timeoutMs,
    });

    let validatedReasoningEffort: ClaudeEffortLevel | undefined;
    if (input.reasoningEffort !== undefined) {
      const effortResult = claudeEffortLevelSchema.safeParse(
        input.reasoningEffort,
      );
      if (!effortResult.success) {
        const error = `Invalid Claude reasoning effort: "${input.reasoningEffort}"`;
        logger.error("claude-task-runner.invalid_reasoning_effort", {
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

    // Cannot resume a different backend's session
    if (input.resumeRef != null && input.resumeRef.backend !== "claude") {
      const error = `Cannot resume a ${input.resumeRef.backend} session with ClaudeTaskRunner`;
      logger.error("claude-task-runner.resume_backend_mismatch", {
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

    const resumeSessionId =
      input.resumeRef?.backend === "claude"
        ? input.resumeRef.sessionId
        : undefined;

    if (resumeSessionId) {
      logger.info("claude-task-runner.resume", { sessionId: resumeSessionId });
    }

    // Log Codex-only fields that are non-default, since Claude ignores them
    const droppedFields: string[] = [];
    if (input.sandboxMode !== undefined) droppedFields.push("sandboxMode");
    if (input.approvalPolicy !== undefined)
      droppedFields.push("approvalPolicy");
    if (input.networkAccessEnabled !== undefined)
      droppedFields.push("networkAccessEnabled");
    if (input.webSearchMode !== undefined) droppedFields.push("webSearchMode");
    if (input.additionalDirectories?.length)
      droppedFields.push("additionalDirectories");
    if (input.skipGitRepoCheck !== undefined)
      droppedFields.push("skipGitRepoCheck");
    if (droppedFields.length > 0) {
      logger.warn("claude-task-runner.dropped_fields", {
        workingDirectory: input.workingDirectory,
        droppedFields,
      });
    }

    // Build MCP servers from tooling
    const mcpServers: Record<string, unknown> = {};

    if (input.tooling?.portableMcp) {
      const {
        servers: portableServers,
        rejectedServers,
        rejectedFields,
      } = translatePortableMcpToClaude(input.tooling.portableMcp);
      if (rejectedServers.length > 0) {
        logger.warn("claude-task-runner.rejected_portable_mcp_servers", {
          workingDirectory: input.workingDirectory,
          rejectedServers,
          rejectedFields,
        });
      }
      Object.assign(mcpServers, portableServers);
    }

    const systemPromptAppend = input.systemInstructions?.length
      ? input.systemInstructions.join("\n\n")
      : undefined;

    const outputFormat = input.outputSchema
      ? { type: "json_schema" as const, schema: input.outputSchema }
      : undefined;

    // Set up timeout via AbortController
    const abortController = new AbortController();
    let timedOut = false;

    // timeoutMs=0 means "no timeout" — skip the timer entirely
    const timeoutHandle =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            logger.warn("claude-task-runner.timeout", {
              workingDirectory: input.workingDirectory,
              timeoutMs: input.timeoutMs,
            });
            abortController.abort();
          }, input.timeoutMs)
        : null;

    let sessionId: string | null = null;
    const textBlocks: string[] = [];
    let structuredOutput: unknown;
    let usageResult: AgentTaskResult["usage"] = null;
    let error: string | null = null;

    try {
      const stream = query({
        prompt: input.prompt,
        options: {
          cwd: input.workingDirectory,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemPromptAppend,
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: ["user", "project", "local"],
          ...(input.modelId ? { model: input.modelId } : {}),
          ...(validatedReasoningEffort
            ? { effort: validatedReasoningEffort as Options["effort"] }
            : {}),
          resume: resumeSessionId,
          persistSession: true,
          ...(outputFormat ? { outputFormat } : {}),
          mcpServers: mcpServers as Record<string, never>,
          abortController,
          canUseTool: async (toolName: string) => {
            if (toolName === "AskUserQuestion") {
              return {
                behavior: "deny" as const,
                message:
                  "Task runner operates autonomously — cannot ask questions.",
              };
            }
            return { behavior: "allow" as const, updatedInput: {} };
          },
          env: buildChildEnv() as Record<string, string>,
        },
      });

      for await (const message of stream) {
        const msg = message as SDKMessage;

        if (msg.type === "system") {
          const sysMsg = msg as SDKSystemMessage;
          sessionId = sysMsg.session_id;
        } else if (msg.type === "assistant") {
          const asstMsg = msg as SDKAssistantMessage;
          sessionId = asstMsg.session_id;

          for (const block of asstMsg.message.content) {
            if (block.type === "text" && "text" in block) {
              textBlocks.push(block.text);
            }
          }
        } else if (msg.type === "result") {
          const resultMsg = msg as SDKResultSuccess | SDKResultError;
          sessionId = resultMsg.session_id;

          const usage = resultMsg.usage;
          usageResult = {
            inputTokens: usage.input_tokens,
            cachedInputTokens: usage.cache_read_input_tokens,
            outputTokens: usage.output_tokens,
          };

          if (resultMsg.subtype === "success") {
            structuredOutput = (resultMsg as SDKResultSuccess)
              .structured_output;
          } else {
            const errMsg = resultMsg as SDKResultError;
            error =
              errMsg.errors?.length > 0
                ? errMsg.errors.join("; ")
                : "Task execution failed";
          }
        }
      }
    } catch (err) {
      if (!timedOut) {
        error = err instanceof Error ? err.message : String(err);
        logger.error("claude-task-runner.query_error", {
          workingDirectory: input.workingDirectory,
          error,
        });
      }
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }

    const backendRef = sessionId
      ? { backend: "claude" as const, sessionId }
      : null;

    logger.info("claude-task-runner.complete", {
      workingDirectory: input.workingDirectory,
      sessionId,
      timedOut,
      hasError: !!error,
    });

    return {
      backendRef,
      text: textBlocks.length > 0 ? textBlocks.join("") : null,
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

const claudeTaskRunner = new ClaudeTaskRunner();
registerTaskRunner(claudeTaskRunner);
