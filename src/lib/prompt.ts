import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKUserMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeModel,
  SessionState,
  ConversationState,
  ConversationMetrics,
  MessageContentBlock,
  ImagePayload,
} from "@/types";
import { conversationMetricsSchema } from "./schemas";
import { readConfig } from "./config";
import { getSession, updateSession } from "./state";
import { acquireSessionLock } from "./lock";
import { createLogger } from "./logging";
import { getConversation, createConversation } from "./conversations";
import { appendTranscriptEntry, getTranscriptPath } from "./transcript";
import type { TranscriptEntry } from "./transcript";
import { broadcast } from "./sse-broadcaster";
import { registerQuestion } from "./question-registry";
import {
  registerAbortController,
  unregisterAbortController,
} from "./abort-registry";
import { randomUUID } from "node:crypto";

// Prevent nested session detection when CSM runs inside Claude Code
delete process.env.CLAUDECODE;

const logger = createLogger("prompt");

/**
 * Execute a prompt via the Agents SDK query() API,
 * streaming output via SSE events.
 *
 * - New conversation:       creates a new SDK session
 * - Existing conversation:  resumes an existing SDK session via claudeSessionId
 *
 * If conversationId is not provided, creates a new conversation.
 * Emits SSE events via the `emit` callback as content arrives.
 * Appends all messages to our own JSONL transcript.
 *
 * Acquires a single-flight lock so only one prompt runs per session.
 * Updates conversation status (running -> awaiting) and prompt count.
 */
export async function executePromptStream(
  projectPath: string,
  session: SessionState,
  promptText: string,
  emit: (event: string, data: unknown) => void,
  conversationId?: string,
  modelId?: ClaudeModel,
  images?: ImagePayload[],
): Promise<{ conversationId: string }> {
  const config = await readConfig();
  const release = acquireSessionLock(projectPath, session.sessionName);

  // Get or create conversation
  let conversation: ConversationState;
  if (conversationId) {
    const existingConv = await getConversation(
      projectPath,
      session.sessionName,
      conversationId,
    );
    if (!existingConv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    conversation = existingConv;
  } else {
    conversation = await createConversation(projectPath, session.sessionName);
    conversationId = conversation.id;
  }

  // Set transcript path eagerly so messages are readable immediately
  const transcriptPath = await getTranscriptPath(conversationId);
  if (!conversation.transcriptPath) {
    await mutateConversation(
      projectPath,
      session.sessionName,
      conversationId,
      (c) => {
        c.transcriptPath = transcriptPath;
      },
    );
    conversation.transcriptPath = transcriptPath;
  }

  // Resolve model: explicit parameter > config default
  const effectiveModel = modelId ?? config.defaultModel;

  const projectName = projectPath.split("/").pop() ?? projectPath;

  // Declared here so `finally` can clear it
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // Mark conversation as running
    await mutateConversation(
      projectPath,
      session.sessionName,
      conversationId,
      (c) => {
        c.status = "running";
      },
    );

    // Broadcast running status
    try {
      broadcast({
        type: "conversation-status",
        projectName,
        sessionName: session.sessionName,
        conversationId,
        status: "running",
      });
    } catch {
      // fire-and-forget
    }

    logger.info("prompt.submit", {
      sessionName: session.sessionName,
      promptLength: promptText.length,
      model: effectiveModel ?? "default",
      resume: !!conversation.claudeSessionId,
    });

    // Build user content blocks for transcript
    const userContentBlocks: MessageContentBlock[] = [
      ...(promptText ? [{ type: "text" as const, text: promptText }] : []),
      ...(images ?? []).map((img) => ({
        type: "image" as const,
        mediaType: img.mediaType,
        base64Data: img.base64Data,
      })),
    ];

    // Persist the user's prompt in the transcript
    await appendEntry(conversationId, {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: userContentBlocks,
    });

    const promptStart = Date.now();

    // Build SDK prompt: multi-modal async iterable when images present, plain string otherwise
    const hasImages = images && images.length > 0;
    const sdkPrompt:
      | string
      | AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage> =
      hasImages ? buildMultiModalPrompt(promptText, images) : promptText;

    // Create SDK query
    const abortController = new AbortController();
    registerAbortController(conversationId, abortController);
    const q: Query = query({
      prompt: sdkPrompt,
      options: {
        model: effectiveModel ?? undefined,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: session.objective
            ? `<objective>${session.objective}</objective>`
            : undefined,
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: session.worktreePath,
        maxTurns: config.maxTurns,
        resume:
          conversation.claudeSessionId ??
          conversation.forkedFrom?.sourceClaudeSessionId ??
          undefined,
        forkSession:
          conversation.forkedFrom != null &&
          conversation.claudeSessionId == null
            ? true
            : undefined,
        persistSession: true,
        abortController,
        env: { CLAUDECODE: "" },
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          if (toolName === "AskUserQuestion") {
            const questions = input.questions;
            if (!questions || !Array.isArray(questions)) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            const questionId = randomUUID();

            // Set conversation status to waiting_for_input and persist question data
            await mutateConversation(
              projectPath,
              session.sessionName,
              conversationId!,
              (c) => {
                c.status = "waiting_for_input";
                c.pendingQuestionId = questionId;
                c.pendingQuestions =
                  questions as ConversationState["pendingQuestions"];
              },
            ).catch(() => {});

            try {
              broadcast({
                type: "conversation-status",
                projectName,
                sessionName: session.sessionName,
                conversationId: conversationId!,
                status: "waiting_for_input",
              });
            } catch {
              /* fire-and-forget */
            }

            // Emit question data on the prompt SSE stream
            emit("ask-question", { questionId, questions });

            // Block until user answers via the answer API
            const answers = await registerQuestion(questionId, conversationId!);

            // Restore running status and clear persisted question data
            await mutateConversation(
              projectPath,
              session.sessionName,
              conversationId!,
              (c) => {
                c.status = "running";
                c.pendingQuestionId = null;
                c.pendingQuestions = null;
              },
            ).catch(() => {});

            try {
              broadcast({
                type: "conversation-status",
                projectName,
                sessionName: session.sessionName,
                conversationId: conversationId!,
                status: "running",
              });
            } catch {
              /* fire-and-forget */
            }

            return {
              behavior: "allow" as const,
              updatedInput: { ...input, answers },
            };
          }

          // Auto-approve all other tools (bypassPermissions mode)
          return { behavior: "allow" as const, updatedInput: input };
        },
      },
    });

    // Safety-net timeout: abort if prompt exceeds configured max duration
    timeoutHandle = setTimeout(() => {
      logger.warn("prompt.timeout", {
        sessionName: session.sessionName,
        timeoutMs: config.claudeTimeoutMs,
      });
      abortController.abort();
    }, config.claudeTimeoutMs);

    // Track state across the message loop
    let sessionId: string | null = null;
    let resultMetrics: Partial<ConversationMetrics> | null = null;
    const contentBlocks: MessageContentBlock[] = [];

    // Helper to persist metrics and broadcast SSE update.
    // metricsProducer receives existing metrics so it can accumulate values.
    const persistMetricsUpdate = async (
      metricsProducer:
        | Partial<ConversationMetrics>
        | ((
            existing: ConversationMetrics | null,
          ) => Partial<ConversationMetrics>),
    ) => {
      let metricsUpdate: Partial<ConversationMetrics>;
      await mutateConversation(
        projectPath,
        session.sessionName,
        conversationId,
        (c) => {
          const existing = c.metrics ?? conversationMetricsSchema.parse({});
          metricsUpdate =
            typeof metricsProducer === "function"
              ? metricsProducer(c.metrics)
              : metricsProducer;
          c.metrics = { ...existing, ...metricsUpdate };
        },
      ).catch(() => {});

      try {
        broadcast({
          type: "metrics-update",
          projectName,
          sessionName: session.sessionName,
          conversationId,
          metrics: metricsUpdate!,
        });
      } catch {
        // fire-and-forget
      }
    };

    try {
      for await (const message of q) {
        await processMessage(
          message,
          conversationId,
          emit,
          contentBlocks,
          (id) => {
            sessionId = id;
          },
          async (metricsUpdate) => {
            resultMetrics = metricsUpdate;
          },
          persistMetricsUpdate,
        );
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        logger.info("prompt.aborted", {
          sessionName: session.sessionName,
        });
        emit("aborted", { message: "Prompt execution was cancelled" });
      } else {
        const errorMsg =
          err instanceof Error ? err.message : "Unknown SDK error";
        logger.error("prompt.sdk_error", {
          sessionName: session.sessionName,
          error: errorMsg,
        });
        emit("error", { message: `SDK error: ${errorMsg}` });
      }
    }

    const durationMs = Date.now() - promptStart;
    logger.info("prompt.complete", {
      sessionName: session.sessionName,
      durationMs,
      contentBlocks: contentBlocks.length,
      costUsd: (resultMetrics as Partial<ConversationMetrics> | null)
        ?.totalCostUsd,
      numTurns: (resultMetrics as Partial<ConversationMetrics> | null)
        ?.numTurns,
    });

    // Update conversation metadata
    if (contentBlocks.length > 0 || sessionId) {
      await mutateConversation(
        projectPath,
        session.sessionName,
        conversationId,
        (c) => {
          c.promptCount++;
          if (sessionId) {
            c.claudeSessionId = sessionId;
          }
          // Result metrics already persisted via persistMetricsUpdate in processMessage
        },
      ).catch((storeErr) => {
        logger.error("prompt.store_response_failed", {
          sessionName: session.sessionName,
          error:
            storeErr instanceof Error ? storeErr.message : String(storeErr),
        });
      });
    } else {
      // No content and no session — likely a startup failure
      emit("error", {
        message: "Claude exited without producing a response",
      });
      logger.warn("prompt.empty_response", {
        sessionName: session.sessionName,
      });
    }

    emit("done", {});
    return { conversationId };
  } finally {
    // Clear safety-net timeout
    clearTimeout(timeoutHandle);

    // Clean up abort controller registration
    unregisterAbortController(conversationId);

    // Always mark conversation as awaiting when done (even on error)
    await mutateConversation(
      projectPath,
      session.sessionName,
      conversationId,
      (c) => {
        c.status = "awaiting";
        c.pendingQuestionId = null;
        c.pendingQuestions = null;
      },
    ).catch(() => {
      // best-effort status reset
    });

    // Broadcast awaiting status
    try {
      broadcast({
        type: "conversation-status",
        projectName,
        sessionName: session.sessionName,
        conversationId,
        status: "awaiting",
      });
    } catch {
      // fire-and-forget
    }

    release();
  }
}

/**
 * Build an async iterable that yields a single SDKUserMessage with image + text content blocks.
 */
async function* buildMultiModalPrompt(
  promptText: string,
  images: ImagePayload[],
): AsyncGenerator<SDKUserMessage> {
  const content = [
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.base64Data,
      },
    })),
    ...(promptText ? [{ type: "text" as const, text: promptText }] : []),
  ];

  yield {
    type: "user",
    session_id: "",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/**
 * Process a single SDK message: emit SSE events, append to transcript, track state.
 */
async function processMessage(
  message: SDKMessage,
  conversationId: string,
  emit: (event: string, data: unknown) => void,
  contentBlocks: MessageContentBlock[],
  setSessionId: (id: string) => void,
  setResultMetrics: (metrics: Partial<ConversationMetrics>) => void,
  persistMetricsUpdate: (
    metricsUpdate:
      | Partial<ConversationMetrics>
      | ((
          existing: ConversationMetrics | null,
        ) => Partial<ConversationMetrics>),
  ) => Promise<void>,
): Promise<void> {
  const timestamp = new Date().toISOString();

  switch (message.type) {
    case "system": {
      const sysMsg = message as SDKSystemMessage;
      if (sysMsg.subtype === "init") {
        setSessionId(sysMsg.session_id);
        emit("init", { sessionId: sysMsg.session_id });

        // Extract and persist session metadata
        const initMetrics = extractInitMetrics(sysMsg);
        await persistMetricsUpdate(initMetrics);

        await appendEntry(conversationId, {
          timestamp,
          type: "system",
          raw: { subtype: "init", session_id: sysMsg.session_id },
        });
      } else if (sysMsg.subtype === "compact_boundary") {
        const compactMsg = message as SDKCompactBoundaryMessage;
        await persistMetricsUpdate((existing) =>
          extractCompactionEvent(compactMsg, existing),
        );

        await appendEntry(conversationId, {
          timestamp,
          type: "system",
          raw: message,
        });
      } else if (
        sysMsg.subtype === "status" &&
        "status" in sysMsg &&
        (sysMsg as Record<string, unknown>).status === "compacting"
      ) {
        // Broadcast compacting status as metrics update
        await persistMetricsUpdate({});

        await appendEntry(conversationId, {
          timestamp,
          type: "system",
          raw: message,
        });
      } else {
        await appendEntry(conversationId, {
          timestamp,
          type: "system",
          raw: message,
        });
      }
      break;
    }

    case "assistant": {
      const asstMsg = message as SDKAssistantMessage;
      setSessionId(asstMsg.session_id);

      const blocks: MessageContentBlock[] = [];
      for (const block of asstMsg.message.content) {
        if (block.type === "text" && "text" in block) {
          const textBlock: MessageContentBlock = {
            type: "text",
            text: block.text,
          };
          blocks.push(textBlock);
          contentBlocks.push(textBlock);
          emit("content", textBlock);
        } else if (block.type === "tool_use" && "name" in block) {
          const toolBlock: MessageContentBlock = {
            type: "tool_use",
            name: block.name,
            input: block.input as Record<string, unknown> | undefined,
          };
          blocks.push(toolBlock);
          contentBlocks.push(toolBlock);
          emit("content", toolBlock);
        }
      }

      await appendEntry(conversationId, {
        timestamp,
        type: "assistant",
        role: "assistant",
        content: blocks,
      });
      break;
    }

    case "user": {
      // Internal tool_result messages — log to transcript for debugging only.
      // No role field so readConversationMessages filters these out.
      await appendEntry(conversationId, {
        timestamp,
        type: "tool_result",
        raw: message,
      });
      break;
    }

    case "result": {
      const resultMsg = message as SDKResultSuccess | SDKResultError;
      setSessionId(resultMsg.session_id);

      // Extract full metrics from result (with accumulation from existing)
      await persistMetricsUpdate((existing) => {
        const metrics = extractResultMetrics(resultMsg, existing);
        setResultMetrics(metrics);
        return metrics;
      });

      if (resultMsg.subtype === "success") {
        const success = resultMsg as SDKResultSuccess;
        emit("result", {
          sessionId: success.session_id,
          costUsd: success.total_cost_usd,
          numTurns: success.num_turns,
        });
      } else {
        const error = resultMsg as SDKResultError;
        const errorMessage = mapErrorSubtype(error);
        emit("error", { message: errorMessage });
      }

      await appendEntry(conversationId, {
        timestamp,
        type: "result",
        raw: resultMsg,
      });
      break;
    }

    default: {
      // stream_event, tool_progress, hook_*, auth_status, etc.
      // Append to transcript for debugging; no SSE emission
      await appendEntry(conversationId, {
        timestamp,
        type: message.type,
        raw: message,
      });
      break;
    }
  }
}

// ============================================================
// Metrics Extraction Functions
// ============================================================

/** Extract metrics from a result message (success or error).
 *  Accumulates totalCostUsd, durationMs, numTurns from existing metrics. */
export function extractResultMetrics(
  result: SDKResultSuccess | SDKResultError,
  existing: ConversationMetrics | null,
): Partial<ConversationMetrics> {
  const metrics: Partial<ConversationMetrics> = {};

  // Token usage from the usage field
  if (result.usage) {
    metrics.inputTokens = result.usage.inputTokens ?? null;
    metrics.outputTokens = result.usage.outputTokens ?? null;
    metrics.cacheReadInputTokens = result.usage.cacheReadInputTokens ?? null;
    metrics.cacheCreationInputTokens =
      result.usage.cacheCreationInputTokens ?? null;
  }

  // Per-model breakdown
  if (result.modelUsage) {
    const modelUsage: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        contextWindow: number;
        maxOutputTokens: number;
      }
    > = {};
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      modelUsage[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costUSD: usage.costUSD,
        contextWindow: usage.contextWindow,
        maxOutputTokens: usage.maxOutputTokens,
      };
      // Use the first model's context window as the top-level value
      if (metrics.contextWindow == null) {
        metrics.contextWindow = usage.contextWindow;
      }
    }
    metrics.modelUsage = modelUsage;
  }

  // Accumulated fields: add to existing values
  metrics.totalCostUsd = (existing?.totalCostUsd ?? 0) + result.total_cost_usd;
  metrics.durationMs = (existing?.durationMs ?? 0) + result.duration_ms;
  metrics.durationApiMs =
    (existing?.durationApiMs ?? 0) + result.duration_api_ms;
  metrics.numTurns = (existing?.numTurns ?? 0) + result.num_turns;

  // Stop/error info
  metrics.stopReason = result.stop_reason ?? null;

  if (result.subtype !== "success") {
    metrics.errorSubtype = result.subtype;
  }

  if (result.permission_denials && result.permission_denials.length > 0) {
    metrics.permissionDenials = result.permission_denials.map(
      (d) => d.tool_name,
    );
  }

  return metrics;
}

/** Extract session metadata from init message */
export function extractInitMetrics(
  init: SDKSystemMessage,
): Partial<ConversationMetrics> {
  return {
    model: init.model ?? null,
    claudeCodeVersion: init.claude_code_version ?? null,
    tools: init.tools ?? null,
    mcpServers:
      init.mcp_servers?.map((s) => ({ name: s.name, status: s.status })) ??
      null,
  };
}

/** Extract compaction event data from compact_boundary message */
export function extractCompactionEvent(
  compact: SDKCompactBoundaryMessage,
  existing: ConversationMetrics | null,
): Partial<ConversationMetrics> {
  const preTokens = compact.compact_metadata.pre_tokens;
  const trigger = compact.compact_metadata.trigger;
  const existingCompactions = existing?.compactions ?? [];
  const existingCount = existing?.compactionCount ?? 0;

  return {
    compactionCount: existingCount + 1,
    lastCompactionPreTokens: preTokens,
    compactions: [
      ...existingCompactions,
      {
        trigger,
        preTokens,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Map SDK error result subtypes to human-readable messages */
function mapErrorSubtype(error: SDKResultError): string {
  switch (error.subtype) {
    case "error_max_turns":
      return `Agent reached maximum turns (${error.num_turns})`;
    case "error_max_budget_usd":
      return `Agent exceeded budget limit ($${error.total_cost_usd.toFixed(2)})`;
    case "error_max_structured_output_retries":
      return "Agent exceeded structured output retry limit";
    case "error_during_execution":
      return error.errors.length > 0
        ? error.errors.join("; ")
        : "Error during execution";
    default:
      return "Unknown error";
  }
}

/** Append a transcript entry, logging failures but not throwing */
async function appendEntry(
  conversationId: string,
  entry: TranscriptEntry,
): Promise<void> {
  try {
    await appendTranscriptEntry(conversationId, entry);
  } catch (err) {
    logger.warn("prompt.transcript_write_failed", {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read a conversation, apply a mutation, and persist via updateSession */
async function mutateConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  mutate: (conversation: ConversationState) => void,
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session) return;

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) return;

  mutate(conversation);
  conversation.lastActivityAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}
