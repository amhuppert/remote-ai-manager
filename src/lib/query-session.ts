/**
 * QuerySession — owns a single long-lived SDK subprocess and its message pump.
 *
 * Manages creation, background message routing, per-turn prompt delivery, and teardown.
 * Each conversation gets at most one QuerySession at a time.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  CanUseTool,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { MessageContentBlock } from "@/types";
import type { EffortLevel } from "./schemas";
import { createLogger } from "./logging";
import { registerSession, unregisterSession } from "./query-session-registry";
import { extractContextTokens, extractContextWindow } from "./context-fill";

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

const logger = createLogger("query-session");

// ============================================================
// Types
// ============================================================

export interface TurnOptions {
  /** When true, AskUserQuestion tool is denied (used by optimistic/Ralph Loop callers) */
  autonomous?: boolean;
}

export interface TurnResult {
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contentBlocks: MessageContentBlock[];
  structuredOutput?: unknown;
  aborted: boolean;
  error: string | null;
}

export type TurnEmit = (event: string, data: unknown) => void;

export interface QuerySession {
  /** Current health status */
  readonly status: "alive" | "dead";

  /** The conversation ID this session belongs to */
  readonly conversationId: string;

  /** The SDK Query object (for streamInput from queueMessage) */
  readonly query: Query;

  /** The current turn options (read by canUseTool) */
  readonly currentTurnOptions: TurnOptions | null;

  /** Model this session was created with */
  readonly model: string | undefined;

  /** Effort level this session was created with */
  readonly effort: string | undefined;

  /** Output format this session was created with (for structured output) */
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  /** Send a prompt and wait for the turn to complete */
  sendPrompt(
    prompt: string | MessageContentBlock[],
    emit: TurnEmit,
    options?: TurnOptions,
  ): Promise<TurnResult>;

  /** Terminate the subprocess and clean up all resources */
  close(): void;
}

export interface QuerySessionOptions {
  conversationId: string;
  cwd: string;
  model: string | undefined;
  effort: EffortLevel | undefined;
  systemPrompt: {
    type: "preset";
    preset: "claude_code";
    append: string | undefined;
  };
  resume: string | undefined;
  forkSession: boolean | undefined;
  resumeSessionAt?: string | undefined;
  mcpServers: Record<string, unknown>;
  canUseTool: CanUseTool;
  env: Record<string, string | undefined>;
  maxTurns: number | undefined;
  plugins: Array<{ type: "local"; path: string }>;
  settingSources: Array<"user" | "project" | "local">;
  disallowedTools: string[];
  /** Idle TTL in ms — session is closed after this much inactivity (default: 5 min) */
  idleTtlMs?: number;
  /** Structured output format — enforced by the SDK at generation time */
  outputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
}

// ============================================================
// Internal state for a pending turn
// ============================================================

interface PendingTurn {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  emit: TurnEmit;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contentBlocks: MessageContentBlock[];
  structuredOutput?: unknown;
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a new QuerySession that owns a long-lived SDK subprocess.
 *
 * The first prompt is delivered via an async generator (hanging generator pattern).
 * Subsequent prompts are delivered via streamInput().
 */
export function createQuerySession(options: QuerySessionOptions): QuerySession {
  const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

  let status: "alive" | "dead" = "alive";
  let pendingTurn: PendingTurn | null = null;
  let currentTurnOptions: TurnOptions | null = null;
  let isFirstPrompt = true;
  let firstPromptResolve: ((msg: SDKUserMessage) => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const stderrChunks: string[] = [];

  // The hanging generator: yields the first user message, then hangs forever.
  // This keeps the SDK subprocess alive indefinitely.
  async function* hangingGenerator(): AsyncGenerator<SDKUserMessage> {
    const firstMessage = await new Promise<SDKUserMessage>((resolve) => {
      firstPromptResolve = resolve;
    });
    yield firstMessage;
    // Hang forever — subsequent messages come via streamInput()
    await new Promise<void>(() => {});
  }

  // Create the SDK query with the hanging generator
  const sdkOptions: Options = {
    cwd: options.cwd,
    model: options.model ?? undefined,
    ...(options.effort ? { effort: options.effort } : {}),
    systemPrompt: options.systemPrompt,
    settingSources: options.settingSources,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: options.disallowedTools,
    ...(options.plugins.length > 0 ? { plugins: options.plugins } : {}),
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    maxTurns: options.maxTurns,
    resume: options.resume,
    forkSession: options.forkSession,
    resumeSessionAt: options.resumeSessionAt,
    persistSession: true,
    env: options.env as Record<string, string>,
    mcpServers: options.mcpServers as Record<string, never>,
    canUseTool: options.canUseTool,
    stderr: (data: string) => {
      stderrChunks.push(data);
    },
  };

  const q: Query = sdkQuery({
    prompt: hangingGenerator(),
    options: sdkOptions,
  });

  // Register in the session registry
  const session: QuerySession = {
    get status() {
      return status;
    },
    get conversationId() {
      return options.conversationId;
    },
    get query() {
      return q;
    },
    get currentTurnOptions() {
      return currentTurnOptions;
    },
    get model() {
      return options.model;
    },
    get effort() {
      return options.effort;
    },
    get outputFormat() {
      return options.outputFormat;
    },
    sendPrompt,
    close,
  };

  registerSession(options.conversationId, session);

  logger.info("query-session.created", {
    conversationId: options.conversationId,
    cwd: options.cwd,
    resume: !!options.resume,
  });

  // Start the background message pump
  void runPump();

  return session;

  // ------------------------------------------------------------------
  // sendPrompt
  // ------------------------------------------------------------------

  async function sendPrompt(
    prompt: string | MessageContentBlock[],
    emit: TurnEmit,
    turnOptions?: TurnOptions,
  ): Promise<TurnResult> {
    if (status === "dead") {
      throw new Error("QuerySession is dead — cannot send prompt");
    }

    // Clear idle timer — a new prompt has arrived
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    currentTurnOptions = turnOptions ?? null;

    logger.debug("query-session.turn_start", {
      conversationId: options.conversationId,
      isFirstPrompt,
    });

    return new Promise<TurnResult>((resolve, reject) => {
      pendingTurn = {
        resolve,
        reject,
        emit,
        sessionId: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindow: null,
        contentBlocks: [],
      };

      if (isFirstPrompt) {
        // Deliver via the hanging generator
        isFirstPrompt = false;
        const userMessage = buildUserMessage(prompt);
        if (firstPromptResolve) {
          firstPromptResolve(userMessage);
          firstPromptResolve = null;
        }
      } else {
        // Reconnect any failed MCP servers before sending the prompt
        void reconnectFailedMcpServers().then(() => {
          const userMessage = buildUserMessage(prompt);
          void q.streamInput(wrapAsIterable(userMessage));
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // close
  // ------------------------------------------------------------------

  function close(): void {
    if (status === "dead") return; // idempotent

    status = "dead";

    // Clear idle timer
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    logger.info("query-session.closed", {
      conversationId: options.conversationId,
    });

    // Reject any pending turn
    if (pendingTurn) {
      const turn = pendingTurn;
      pendingTurn = null;
      turn.reject(new Error("QuerySession closed while turn was in progress"));
    }

    unregisterSession(options.conversationId);

    // Close the SDK subprocess
    try {
      q.close();
    } catch {
      // best-effort
    }
  }

  // ------------------------------------------------------------------
  // Background message pump
  // ------------------------------------------------------------------

  async function runPump(): Promise<void> {
    try {
      for await (const message of q) {
        processMessage(message);
      }
      // Generator completed normally (subprocess exited cleanly)
      if (status === "alive") {
        markDead("pump_completed");
      }
    } catch (err) {
      if (status === "alive") {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const stderr =
          stderrChunks.length > 0 ? stderrChunks.join("") : undefined;
        logger.error("query-session.pump_error", {
          conversationId: options.conversationId,
          error: errorMsg,
          ...(stderr ? { stderr } : {}),
        });
        markDead("pump_error");

        // Reject pending turn with stderr attached
        if (pendingTurn) {
          const turn = pendingTurn;
          pendingTurn = null;
          const rejectError =
            err instanceof Error ? err : new Error(String(err));
          if (stderr) {
            (rejectError as Error & { stderr: string }).stderr = stderr;
          }
          turn.reject(rejectError);
        }
      }
    }
  }

  function markDead(reason: string): void {
    if (status === "dead") return;
    status = "dead";
    unregisterSession(options.conversationId);
    logger.info("query-session.dead", {
      conversationId: options.conversationId,
      reason,
    });
  }

  // ------------------------------------------------------------------
  // MCP server health check
  // ------------------------------------------------------------------

  async function reconnectFailedMcpServers(): Promise<void> {
    try {
      const statuses = await q.mcpServerStatus();
      const failed = statuses.filter((s) => s.status === "failed");
      if (failed.length === 0) return;

      logger.info("query-session.mcp_reconnect", {
        conversationId: options.conversationId,
        servers: failed.map((s) => s.name),
      });

      await Promise.all(
        failed.map(async (server) => {
          try {
            await q.reconnectMcpServer(server.name);
            logger.info("query-session.mcp_reconnected", {
              conversationId: options.conversationId,
              server: server.name,
            });
          } catch (err) {
            logger.warn("query-session.mcp_reconnect_failed", {
              conversationId: options.conversationId,
              server: server.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    } catch (err) {
      logger.warn("query-session.mcp_status_check_failed", {
        conversationId: options.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ------------------------------------------------------------------
  // Message processing
  // ------------------------------------------------------------------

  function processMessage(message: SDKMessage): void {
    if (!pendingTurn) {
      // Between turns — log and discard
      logger.debug("query-session.idle_message", {
        conversationId: options.conversationId,
        type: message.type,
      });
      return;
    }

    const turn = pendingTurn;

    // Forward to turn's emit callback
    turn.emit("__raw_message", message);

    switch (message.type) {
      case "system": {
        const sysMsg = message as SDKSystemMessage;
        if (sysMsg.subtype === "init") {
          turn.sessionId = sysMsg.session_id;
        }
        break;
      }

      case "assistant": {
        const asstMsg = message as SDKAssistantMessage;
        turn.sessionId = asstMsg.session_id;

        for (const block of asstMsg.message.content) {
          if (block.type === "text" && "text" in block) {
            const textBlock: MessageContentBlock = {
              type: "text",
              text: block.text,
            };
            turn.contentBlocks.push(textBlock);
          } else if (block.type === "tool_use" && "name" in block) {
            const toolBlock: MessageContentBlock = {
              type: "tool_use",
              name: block.name,
              input: block.input as Record<string, unknown> | undefined,
            };
            turn.contentBlocks.push(toolBlock);
          }
        }

        // Track context window usage
        const contextTokens = extractContextTokens(asstMsg.message.usage);
        if (contextTokens > 0) {
          turn.contextTokens = contextTokens;
        }
        break;
      }

      case "result": {
        const resultMsg = message as SDKResultSuccess | SDKResultError;
        turn.sessionId = resultMsg.session_id;
        turn.costUsd = resultMsg.total_cost_usd;
        turn.durationMs = resultMsg.duration_ms;
        turn.numTurns = resultMsg.num_turns;

        const contextWindow = extractContextWindow(resultMsg.modelUsage);
        if (contextWindow != null) {
          turn.contextWindow = contextWindow;
        }

        let error: string | null = null;
        if (resultMsg.subtype === "success") {
          const success = resultMsg as SDKResultSuccess;
          turn.structuredOutput = success.structured_output;
        } else {
          const errMsg = resultMsg as SDKResultError;
          error =
            errMsg.errors?.length > 0
              ? errMsg.errors.join("; ")
              : "Error during execution";
        }

        // Resolve the turn promise
        const result: TurnResult = {
          sessionId: turn.sessionId,
          costUsd: turn.costUsd,
          durationMs: turn.durationMs,
          numTurns: turn.numTurns,
          contextTokens: turn.contextTokens,
          contextWindow: turn.contextWindow,
          contentBlocks: turn.contentBlocks,
          structuredOutput: turn.structuredOutput,
          aborted: false,
          error,
        };

        const resolve = turn.resolve;
        pendingTurn = null;
        currentTurnOptions = null;

        logger.debug("query-session.turn_complete", {
          conversationId: options.conversationId,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
        });

        resolve(result);

        // Start idle TTL timer — close session if no new prompt arrives
        if (idleTtlMs > 0 && status === "alive") {
          idleTimer = setTimeout(() => {
            if (status === "alive" && !pendingTurn) {
              logger.info("query-session.idle_timeout", {
                conversationId: options.conversationId,
                idleTtlMs,
              });
              close();
            }
          }, idleTtlMs);
        }

        break;
      }

      default:
        // Other message types (user/tool_result, stream_event, etc.)
        // Already forwarded via emit above
        break;
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function buildUserMessage(
  prompt: string | MessageContentBlock[],
): SDKUserMessage {
  if (typeof prompt === "string") {
    return {
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  // Convert CC's MessageContentBlock[] to Anthropic API content format
  const apiContent = prompt.map((block) => {
    if (block.type === "image") {
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: block.mediaType,
          data: block.base64Data,
        },
      };
    }
    return block;
  });

  return {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: apiContent,
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

async function* wrapAsIterable(
  msg: SDKUserMessage,
): AsyncGenerator<SDKUserMessage> {
  yield msg;
}
