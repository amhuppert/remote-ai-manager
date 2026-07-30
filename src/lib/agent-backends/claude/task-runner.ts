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
import {
  buildSessionEnvContract,
  neutralizeAmbientCcEnv,
  type SessionEnv,
} from "@/lib/agent-gateway/session-env";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import {
  ccTaskSessionScopeSchema,
  type AgentTaskRequest,
  type AgentTaskResult,
  type AgentTaskRunner,
} from "../task";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import { translatePortableMcpToClaude } from "../mcp-translation";
import { appendStructuredOutputInstruction } from "../structured-output-prompt";
import {
  toRawTranscriptEntries,
  type AgentTranscriptEntry,
} from "../transcript";
import {
  claudeEffortLevelSchema,
  type ClaudeEffortLevel,
} from "@/lib/agent-backends/schemas";
// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/shared/sdk-env";
import { getErrorMessage } from "@/lib/shared/errors";
import { createClaudeFailureClassifier } from "./failure-classifier";
import { createStallWatchdog } from "../stall-watchdog";
import { resolveClaudeManagedSkillsForLaunch } from "./managed-skills";
import { mapErrorSubtype } from "./process-message";

const logger = createLogger("claude:task-runner");
const claudeFailureClassifier = createClaudeFailureClassifier();

function resolveTaskContinuation(
  backendRef: AgentSessionRef | null,
  error: unknown | null,
): Pick<AgentTaskResult, "backendRef" | "failure" | "continuationDisposition"> {
  if (error === null) {
    return { backendRef, failure: null, continuationDisposition: "retain" };
  }
  const { failure, continuationDisposition } =
    claudeFailureClassifier.classifyWithContinuation(error);
  return {
    backendRef: continuationDisposition === "clear" ? null : backendRef,
    failure,
    continuationDisposition,
  };
}

// ============================================================
// Claude Task Runner
// ============================================================

/**
 * Provider port for the one SDK call the task runner makes. Injected so the
 * conformance suite can drive the real runner against a fake message stream;
 * the runner only iterates the returned stream, so the port is structural.
 */
export interface ClaudeTaskRunnerDeps {
  runQuery(args: {
    prompt: string;
    options: Options;
  }): AsyncIterable<SDKMessage>;
  /**
   * Server coordinates and config location for the session env contract, read
   * here (never from the request) so a scoped run cannot be handed credentials
   * by its caller. Only consulted for a run carrying a `ccSessionScope`.
   */
  getServerUrl(): string | null;
  getApiToken(): string | null;
  getConfigDir(): string;
}

const defaultDeps: ClaudeTaskRunnerDeps = {
  runQuery: (args) => query(args),
  getServerUrl: getServerBaseUrl,
  getApiToken: getCachedInstanceToken,
  getConfigDir: getConfigDirPath,
};

export class ClaudeTaskRunner implements AgentTaskRunner {
  readonly backend: AgentBackendId = "claude";

  constructor(private readonly deps: ClaudeTaskRunnerDeps = defaultDeps) {}

  /**
   * Ambient CC_* (an outer instance's server URL/token, an outer lane's
   * workflow ids) is blanked FIRST, whether or not this run is scoped, so
   * nothing inherited can survive into the child. A run carrying a trusted
   * `ccSessionScope` then gets the full session env contract on top —
   * credentials and paths resolved here, server-side: the scope names an
   * identity, it never carries the means to act as one.
   */
  private resolveChildEnv(
    input: AgentTaskRequest,
    isolatedOneShot: boolean,
  ):
    | { kind: "resolved"; env: Record<string, string> }
    | { kind: "invalid_scope"; invalidFields: string } {
    const neutralizedEnv: SessionEnv = {
      ...neutralizeAmbientCcEnv(buildChildEnv()),
      ...(isolatedOneShot ? { CLAUDECODE: "" } : {}),
    };

    if (input.ccSessionScope === undefined) {
      return {
        kind: "resolved",
        env: neutralizedEnv as Record<string, string>,
      };
    }

    const scope = ccTaskSessionScopeSchema.safeParse(input.ccSessionScope);
    if (!scope.success) {
      // Field paths only — a scope value could be any string the caller built,
      // and this error travels into results and logs.
      return {
        kind: "invalid_scope",
        invalidFields: [
          ...new Set(scope.error.issues.map((issue) => issue.path.join("."))),
        ].join(", "),
      };
    }

    return {
      kind: "resolved",
      env: buildSessionEnvContract({
        baseEnv: neutralizedEnv,
        serverUrl: this.deps.getServerUrl(),
        apiToken: this.deps.getApiToken(),
        // The scope names a session-keyed identity, so it crosses into the
        // public target vocabulary through the one sanctioned adapter: a task
        // lane spawned from a project conversation carries the sentinel here,
        // and the target union is what keeps it out of CC_SESSION.
        target: targetFromStoreSessionName(
          scope.data.project,
          scope.data.session,
          scope.data.conversationId,
        ),
        configDir: this.deps.getConfigDir(),
      }) as Record<string, string>,
    };
  }

  async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
    const isolatedOneShot = input.executionProfile === "isolated-one-shot";

    logger.info("claude-task-runner.start", {
      workingDirectory: input.workingDirectory,
      hasResume: !!input.resumeRef,
      timeoutMs: input.timeoutMs,
      executionProfile: input.executionProfile ?? "standard",
      hasOutputSchema: input.outputSchema !== undefined,
      hasCcSessionScope: input.ccSessionScope !== undefined,
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
          ...resolveTaskContinuation(
            input.resumeRef?.backend === "claude" ? input.resumeRef : null,
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

    // Cannot resume a different backend's session
    if (
      !isolatedOneShot &&
      input.resumeRef != null &&
      input.resumeRef.backend !== "claude"
    ) {
      const error = `Cannot resume a ${input.resumeRef.backend} session with ClaudeTaskRunner`;
      logger.error("claude-task-runner.resume_backend_mismatch", {
        resumeBackend: input.resumeRef.backend,
      });
      return {
        ...resolveTaskContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    const resumeSessionId =
      !isolatedOneShot && input.resumeRef?.backend === "claude"
        ? input.resumeRef.ref
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

    if (!isolatedOneShot && input.tooling?.portableMcp) {
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

    const prompt = input.outputSchema
      ? appendStructuredOutputInstruction(input.prompt, input.outputSchema)
      : input.prompt;

    const childEnv = this.resolveChildEnv(input, isolatedOneShot);
    if (childEnv.kind === "invalid_scope") {
      const error = `Invalid ccSessionScope for a Claude task run: ${childEnv.invalidFields}`;
      logger.error("claude-task-runner.invalid_session_scope", {
        workingDirectory: input.workingDirectory,
        invalidFields: childEnv.invalidFields,
      });
      return {
        ...resolveTaskContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

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

    // Fold an external cancellation signal into the same abort path so a
    // job-shaped caller can cancel a live run.
    const externalSignal = input.signal;
    const onExternalAbort = () => abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abortController.abort();
      else externalSignal.addEventListener("abort", onExternalAbort);
    }

    // Inactivity watchdog: disabled unless the caller passes a bound (the
    // claude descriptor declares no default — background-task waits produce
    // legitimate long silences and the safety-net timeout caps a hung turn).
    const stallTimeoutMs = input.stallTimeoutMs ?? 0;
    const stallWatchdog = createStallWatchdog({
      stallTimeoutMs,
      onStall: () => {
        logger.warn("claude-task-runner.stalled", {
          workingDirectory: input.workingDirectory,
          stallTimeoutMs,
        });
        abortController.abort();
      },
    });

    let sessionId: string | null = null;
    const textBlocks: string[] = [];
    const rawMessages: unknown[] = [];
    let finalResponseText: string | undefined;
    let usageResult: AgentTaskResult["usage"] = null;
    let error: string | null = null;

    // Managed skill bundle: standard task runs get the same attachment as
    // conversations; the isolated one-shot profile is hermetic by contract.
    const managedSkills = isolatedOneShot
      ? { plugins: [], enabledPluginsOverride: {} }
      : await resolveClaudeManagedSkillsForLaunch();

    try {
      const stream = this.deps.runQuery({
        prompt,
        options: {
          cwd: input.workingDirectory,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemPromptAppend,
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: isolatedOneShot ? [] : ["user", "project", "local"],
          ...(managedSkills.plugins.length > 0
            ? { plugins: managedSkills.plugins }
            : {}),
          ...(Object.keys(managedSkills.enabledPluginsOverride).length > 0
            ? {
                settings: {
                  enabledPlugins: managedSkills.enabledPluginsOverride,
                },
              }
            : {}),
          ...(isolatedOneShot
            ? { maxTurns: 1, tools: [], strictMcpConfig: true }
            : {}),
          ...(input.modelId ? { model: input.modelId } : {}),
          ...(validatedReasoningEffort
            ? { effort: validatedReasoningEffort as Options["effort"] }
            : {}),
          resume: resumeSessionId,
          persistSession: !isolatedOneShot,
          mcpServers: mcpServers as Record<string, never>,
          abortController,
          env: childEnv.env,
        },
      });

      for await (const message of stream) {
        stallWatchdog.touch();
        const msg = message as SDKMessage;
        rawMessages.push(message);

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
            finalResponseText =
              typeof resultMsg.result === "string"
                ? resultMsg.result
                : undefined;
          } else {
            const errMsg = resultMsg as SDKResultError;
            error = mapErrorSubtype(errMsg);
          }
        }
      }
    } catch (err) {
      if (!timedOut && !stallWatchdog.fired()) {
        error = getErrorMessage(err);
        logger.error("claude-task-runner.query_error", {
          workingDirectory: input.workingDirectory,
          error,
        });
      }
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      stallWatchdog.cancel();
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    const observedBackendRef =
      sessionId && !isolatedOneShot
        ? { backend: "claude" as const, ref: sessionId }
        : null;
    const priorBackendRef =
      !isolatedOneShot && input.resumeRef?.backend === "claude"
        ? input.resumeRef
        : null;
    const stalled = stallWatchdog.fired();
    if (stalled) timedOut = true;
    const finalError = stalled
      ? `Task stalled: no backend activity for ${stallTimeoutMs}ms`
      : (error ?? (timedOut ? "Task timed out" : null));
    const continuation = resolveTaskContinuation(
      observedBackendRef ?? priorBackendRef,
      finalError,
    );

    const transcript: AgentTranscriptEntry[] | undefined =
      rawMessages.length > 0
        ? toRawTranscriptEntries("claude", rawMessages)
        : undefined;

    logger.info("claude-task-runner.complete", {
      workingDirectory: input.workingDirectory,
      sessionId,
      timedOut,
      hasError: !!error,
      executionProfile: input.executionProfile ?? "standard",
      usedFinalResponseText:
        input.outputSchema !== undefined && finalResponseText !== undefined,
    });

    const assistantText = textBlocks.length > 0 ? textBlocks.join("") : null;
    return {
      ...continuation,
      text:
        input.outputSchema !== undefined && finalResponseText !== undefined
          ? finalResponseText
          : assistantText,
      usage: usageResult,
      ...(transcript ? { transcript } : {}),
      error: finalError,
      timedOut,
    };
  }
}

export const claudeTaskRunner = new ClaudeTaskRunner();
