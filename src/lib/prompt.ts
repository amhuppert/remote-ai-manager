import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKUserMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { buildChildEnv } from "./child-env";
import type {
  ClaudeModel,
  SessionState,
  ConversationState,
  MessageContentBlock,
  ImagePayload,
} from "@/types";
import { readConfig } from "./config";
import { mutateConversation } from "./state";
import { acquireSessionLock } from "./lock";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "./logging";
import { getConversation, createConversation } from "./conversations";
import { getTranscriptPath } from "./transcript";
import { externalizeImageBlocks } from "./transcript-images";
import { broadcast } from "./sse-broadcaster";
import { dispatchPushForConversationStatus } from "./push-dispatcher";
import { registerQuestion } from "./question-registry";
import {
  registerAbortController,
  unregisterAbortController,
} from "./abort-registry";
import { registerQuery, unregisterQuery } from "./query-registry";
import { acquireQuerySlot } from "./query-semaphore";
import { createInitToolServer } from "./ralph-loop/init-tool";
import { createRoadmapToolServer } from "./roadmap-tools";
import { createNotificationToolServer } from "./agent-notification-tool";
import { getProjectDisplayName } from "./project-resolver";
import { safeAppendTranscriptEntry } from "./transcript";
import { extractContextTokens, extractContextWindow } from "./context-fill";
import { resolvePluginPaths } from "./commands";
import { randomUUID } from "node:crypto";

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

const logger = createLogger("prompt");

/** Appended to the system prompt when session.tddEnabled is true. */
export const TDD_INSTRUCTIONS =
  "<methodology>Use red-green TDD. Write a failing test first, run it to confirm it fails, then write the minimum code to make it pass.</methodology>";

/** Appended to every system prompt to orient the agent about its CC environment. */
export const CC_CONTEXT =
  "<command-center>You are running inside Command Center (CC), a web-based control plane for managing remote Claude Code sessions. Your session runs in an isolated git worktree with its own branch. CC provides custom MCP tools: roadmap tools for tracking bugs/features/ideas, Ralph Loop tools for autonomous multi-iteration workflows, and a notification tool to send push notifications to the user's phone when warranted (e.g., long tasks complete, user asked to be notified). Stay within your worktree — CC manages merging, dev servers, and session lifecycle.</command-center>";

// ============================================================
// Dependency Injection
// ============================================================

export interface PromptDeps {
  readConfig: typeof readConfig;
  mutateConversation: typeof mutateConversation;
  acquireSessionLock: typeof acquireSessionLock;
  getConversation: typeof getConversation;
  createConversation: typeof createConversation;
  safeAppendTranscriptEntry: typeof safeAppendTranscriptEntry;
  getTranscriptPath: typeof getTranscriptPath;
  externalizeImageBlocks: typeof externalizeImageBlocks;
  broadcast: typeof broadcast;
  registerQuestion: typeof registerQuestion;
  registerAbortController: typeof registerAbortController;
  unregisterAbortController: typeof unregisterAbortController;
  registerQuery: typeof registerQuery;
  unregisterQuery: typeof unregisterQuery;
  acquireQuerySlot: typeof acquireQuerySlot;
  createInitToolServer: typeof createInitToolServer;
  createNotificationToolServer: typeof createNotificationToolServer;
  getProjectDisplayName: typeof getProjectDisplayName;
  buildChildEnv: typeof buildChildEnv;
}

const defaultPromptDeps: PromptDeps = {
  readConfig,
  mutateConversation,
  acquireSessionLock,
  getConversation,
  createConversation,
  safeAppendTranscriptEntry,
  getTranscriptPath,
  externalizeImageBlocks,
  broadcast,
  registerQuestion,
  registerAbortController,
  unregisterAbortController,
  registerQuery,
  unregisterQuery,
  acquireQuerySlot,
  createInitToolServer,
  createNotificationToolServer,
  getProjectDisplayName,
  buildChildEnv,
};

/**
 * Create a prompt executor with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton export.
 */
export function createPromptExecutor(deps: PromptDeps = defaultPromptDeps) {
  return {
    executePromptStream: (
      projectPath: string,
      session: SessionState,
      promptText: string,
      emit: (event: string, data: unknown) => void,
      conversationId?: string,
      modelId?: ClaudeModel,
      images?: ImagePayload[],
      options?: { autonomous?: boolean },
    ) =>
      executePromptStream(
        projectPath,
        session,
        promptText,
        emit,
        conversationId,
        modelId,
        images,
        options,
        deps,
      ),
  };
}

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
  options?: { autonomous?: boolean },
  deps: PromptDeps = defaultPromptDeps,
): Promise<{ conversationId: string }> {
  // Destructure deps — shadows module-level imports within this function scope
  const {
    readConfig,
    mutateConversation,
    acquireSessionLock,
    getConversation,
    createConversation,
    safeAppendTranscriptEntry,
    getTranscriptPath,
    externalizeImageBlocks,
    broadcast,
    registerQuestion,
    registerAbortController,
    unregisterAbortController,
    registerQuery,
    unregisterQuery,
    acquireQuerySlot,
    createInitToolServer,
    createNotificationToolServer,
    getProjectDisplayName,
    buildChildEnv,
  } = deps;

  const config = await readConfig();
  const release = acquireSessionLock(projectPath, session.sessionName);

  const projectName = getProjectDisplayName(projectPath);

  // Declared here so `finally` can clear it
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let releaseQuerySlot: (() => void) | undefined;

  try {
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
        "prompt.setTranscriptPath",
        (c) => {
          c.transcriptPath = transcriptPath;
        },
      );
      conversation.transcriptPath = transcriptPath;
    }

    // Resolve model: explicit parameter > config default
    const effectiveModel = modelId ?? config.defaultModel;

    // Acquire concurrency slot (waits if at capacity)
    releaseQuerySlot = await acquireQuerySlot(`prompt:${session.sessionName}`);
    // Mark conversation as running
    await mutateConversation(
      projectPath,
      session.sessionName,
      conversationId,
      "prompt.setRunning",
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

    // Build user content blocks (inline base64 for SDK use)
    const userContentBlocks: MessageContentBlock[] = [
      ...(promptText ? [{ type: "text" as const, text: promptText }] : []),
      ...(images ?? []).map((img) => ({
        type: "image" as const,
        mediaType: img.mediaType,
        base64Data: img.base64Data,
      })),
    ];

    // Externalize images to disk for transcript storage (base64 → file refs)
    const transcriptBlocks = images?.length
      ? await externalizeImageBlocks(conversationId, userContentBlocks)
      : userContentBlocks;

    // Persist the user's prompt in the transcript
    await safeAppendTranscriptEntry(conversationId, {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: transcriptBlocks,
    });

    const promptStart = Date.now();

    // Build SDK prompt: multi-modal async iterable when images present, plain string otherwise
    const hasImages = images && images.length > 0;
    const sdkPrompt:
      | string
      | AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage> =
      hasImages ? buildMultiModalPrompt(promptText, images) : promptText;

    // Conditionally register the Ralph Loop init tool when no workflow exists
    const initToolServer =
      session.workflow == null
        ? createInitToolServer({
            projectPath,
            sessionName: session.sessionName,
            projectName,
          })
        : null;

    // Conditionally register notification tool when push notifications are configured
    const pushConfig = config.pushNotification;
    const notificationToolEnabled = pushConfig?.enabled && pushConfig?.topic;
    const notificationToolServer = notificationToolEnabled
      ? createNotificationToolServer(
          { projectName, sessionName: session.sessionName },
          {
            sendNotification: async (title, message, tags) => {
              const { sendAgentNotification } =
                await import("./push-notification");
              await sendAgentNotification(
                pushConfig,
                title,
                message,
                tags,
                projectName,
                session.sessionName,
              );
            },
          },
        )
      : null;

    // Detect ultrathink keyword for max reasoning effort
    const ultrathinkDetected = /\bultrathink\b/i.test(promptText);
    if (ultrathinkDetected) {
      logger.info("prompt.ultrathink", {
        sessionName: session.sessionName,
      });
    }

    // Resolve enabled plugins for SDK skill loading
    const pluginPaths = await resolvePluginPaths();
    const sdkPlugins = pluginPaths.map((p) => ({
      type: "local" as const,
      path: p.path,
    }));

    // Create SDK query
    const abortController = new AbortController();
    registerAbortController(conversationId, abortController);
    const q: Query = query({
      prompt: sdkPrompt,
      options: {
        model: effectiveModel ?? undefined,
        ...(ultrathinkDetected ? { effort: "high" as const } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            [
              CC_CONTEXT,
              session.objective
                ? `<objective>${session.objective}</objective>`
                : null,
              session.tddEnabled ? TDD_INSTRUCTIONS : null,
            ]
              .filter(Boolean)
              .join("\n\n") || undefined,
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
        ...(sdkPlugins.length > 0 ? { plugins: sdkPlugins } : {}),
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
        env: { ...buildChildEnv(), CLAUDECODE: "" },
        mcpServers: {
          ...(initToolServer ? { "ralph-loop-init": initToolServer } : {}),
          ...(notificationToolServer
            ? { "agent-notification": notificationToolServer }
            : {}),
          "roadmap-tools": createRoadmapToolServer({ projectPath }),
        },
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          if (toolName === "AskUserQuestion") {
            // Autonomous mode: deny AskUserQuestion to prevent blocking
            if (options?.autonomous) {
              return {
                behavior: "deny" as const,
                message:
                  "Autonomous optimistic mode — make your best judgment and proceed without asking questions.",
              };
            }

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
              "prompt.setWaitingForInput",
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

            // Push notification to phone
            dispatchPushForConversationStatus({
              projectName,
              sessionName: session.sessionName,
              conversationId: conversationId!,
              status: "waiting_for_input",
            });

            // Emit question data on the prompt SSE stream
            emit("ask-question", { questionId, questions });

            // Block until user answers via the answer API
            const answers = await registerQuestion(questionId, conversationId!);

            // Restore running status and clear persisted question data
            await mutateConversation(
              projectPath,
              session.sessionName,
              conversationId!,
              "prompt.resumeRunning",
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

    // Register query so queued messages can be delivered via streamInput()
    registerQuery(conversationId, q);

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
    let resultCostUsd: number | null = null;
    let resultDurationMs: number | null = null;
    let resultNumTurns: number | null = null;
    let resultContextTokens: number | null = null;
    let resultContextWindow: number | null = null;
    const contentBlocks: MessageContentBlock[] = [];

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
          (cost, duration, turns) => {
            resultCostUsd = cost;
            resultDurationMs = duration;
            resultNumTurns = turns;
          },
          (tokens) => {
            resultContextTokens = tokens;
          },
          (windowMax) => {
            resultContextWindow = windowMax;
          },
          safeAppendTranscriptEntry,
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
      costUsd: resultCostUsd,
      numTurns: resultNumTurns,
    });

    // Update conversation metadata
    if (contentBlocks.length > 0 || sessionId) {
      await mutateConversation(
        projectPath,
        session.sessionName,
        conversationId,
        "prompt.storeResponse",
        (c) => {
          c.promptCount++;
          if (sessionId) {
            c.claudeSessionId = sessionId;
          }
          // Accumulate cost/duration/turns
          if (resultCostUsd != null) {
            c.totalCostUsd = (c.totalCostUsd ?? 0) + resultCostUsd;
          }
          if (resultDurationMs != null) {
            c.totalDurationMs = (c.totalDurationMs ?? 0) + resultDurationMs;
          }
          if (resultNumTurns != null) {
            c.totalTurns = (c.totalTurns ?? 0) + resultNumTurns;
          }
          // Store latest context window usage
          if (resultContextTokens != null) {
            c.contextTokens = resultContextTokens;
          }
          if (resultContextWindow != null) {
            c.contextWindowMax = resultContextWindow;
          }
        },
      ).catch((storeErr) => {
        logger.error("prompt.store_response_failed", {
          sessionName: session.sessionName,
          error: getErrorMessage(storeErr),
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

    // Release concurrency slot
    releaseQuerySlot?.();

    // Clean up abort controller and query registrations (guard for early failures
    // before conversationId is assigned — e.g. createConversation() throws)
    if (conversationId) {
      unregisterAbortController(conversationId);
      unregisterQuery(conversationId);

      // Always mark conversation as awaiting when done (even on error)
      await mutateConversation(
        projectPath,
        session.sessionName,
        conversationId,
        "prompt.setAwaiting",
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
  setResultData: (
    costUsd: number,
    durationMs: number,
    numTurns: number,
  ) => void,
  setContextTokens: (tokens: number) => void,
  setContextWindow: (windowMax: number) => void,
  safeAppendTranscriptEntry: PromptDeps["safeAppendTranscriptEntry"],
): Promise<void> {
  const timestamp = new Date().toISOString();

  switch (message.type) {
    case "system": {
      const sysMsg = message as SDKSystemMessage;
      if (sysMsg.subtype === "init") {
        setSessionId(sysMsg.session_id);
        emit("init", { sessionId: sysMsg.session_id });
        await safeAppendTranscriptEntry(conversationId, {
          timestamp,
          type: "system",
          raw: { subtype: "init", session_id: sysMsg.session_id },
        });
      }
      // Other system subtypes (status, compact_boundary, task_*) — log to transcript only
      else {
        await safeAppendTranscriptEntry(conversationId, {
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

      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "assistant",
        role: "assistant",
        content: blocks,
      });

      // Track context window usage from assistant message
      const contextTokens = extractContextTokens(asstMsg.message.usage);
      if (contextTokens > 0) {
        setContextTokens(contextTokens);
      }
      break;
    }

    case "user": {
      // Internal tool_result messages — log to transcript for debugging only.
      // No role field so readConversationMessages filters these out.
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "tool_result",
        raw: message,
      });
      break;
    }

    case "result": {
      const resultMsg = message as SDKResultSuccess | SDKResultError;
      setSessionId(resultMsg.session_id);

      if (resultMsg.subtype === "success") {
        const success = resultMsg as SDKResultSuccess;
        setResultData(
          success.total_cost_usd,
          success.duration_ms,
          success.num_turns,
        );

        // When the SDK returns result text but no assistant messages were
        // produced (e.g. "Unknown skill: X"), emit the result text as content
        // so the client actually displays it.
        if (success.result && contentBlocks.length === 0) {
          const textBlock: MessageContentBlock = {
            type: "text",
            text: success.result,
          };
          contentBlocks.push(textBlock);
          emit("content", textBlock);
        }

        emit("result", {
          sessionId: success.session_id,
          costUsd: success.total_cost_usd,
          numTurns: success.num_turns,
        });
      } else {
        const error = resultMsg as SDKResultError;
        setResultData(error.total_cost_usd, error.duration_ms, error.num_turns);
        const errorMessage = mapErrorSubtype(error);
        emit("error", { message: errorMessage });
      }

      // Extract context window max from model usage
      const contextWindow = extractContextWindow(resultMsg.modelUsage);
      if (contextWindow != null) {
        setContextWindow(contextWindow);
      }

      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "result",
        raw: resultMsg,
      });
      break;
    }

    default: {
      // stream_event, tool_progress, hook_*, auth_status, etc.
      // Append to transcript for debugging; no SSE emission
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: message.type,
        raw: message,
      });
      break;
    }
  }
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
