/**
 * Codex ConversationBackendRuntime — wraps the Codex SDK behind the
 * backend-neutral conversation runtime interface using per-turn instance
 * creation with persistent threadId.
 */

import type {
  CodexOptions,
  ThreadOptions,
  Input,
  TurnOptions,
  ThreadEvent,
  Usage,
  McpToolCallItem,
} from "@openai/codex-sdk";
import type { MessageContentBlock } from "@/types";
import type { AgentBackendId, ConversationBackendCapabilities } from "../types";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import type { PortableMcpToCodexResult } from "../mcp-translation";
import { registerConversationBackendFactory } from "../registry-core";
import {
  codexReasoningEffortSchema,
  getCodexReasoningLevelsForModel,
} from "@/lib/schemas";
import { createLogger } from "@/lib/logging";
import path from "node:path";

// Default dep implementations (used at runtime, injected in tests)
import { Codex } from "@openai/codex-sdk";
import { buildChildEnv } from "@/lib/child-env";
import { toStringEnv } from "./shared";
import { translatePortableMcpToCodex } from "./mcp-translation";
import { mkdir, writeFile, rm } from "node:fs/promises";

const logger = createLogger("codex:conversation-runtime");

// ============================================================
// Injectable dependency surface
// ============================================================

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: Input,
    turnOptions?: TurnOptions,
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexConversationRuntimeDeps {
  createCodex(options: CodexOptions): CodexClientLike;
  buildChildEnv(): NodeJS.ProcessEnv;
  toStringEnv(env: NodeJS.ProcessEnv): Record<string, string>;
  translatePortableMcpToCodex(
    config: PortableMcpConfig,
  ): PortableMcpToCodexResult;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  now(): number;
}

const defaultDeps: CodexConversationRuntimeDeps = {
  createCodex: (options) => new Codex(options) as unknown as CodexClientLike,
  buildChildEnv,
  toStringEnv,
  translatePortableMcpToCodex,
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  writeFile: (path, data) => writeFile(path, data),
  rm: (path, options) => rm(path, options),
  now: () => Date.now(),
};

// ============================================================
// Codex Conversation Runtime
// ============================================================

export class CodexConversationRuntime implements ConversationBackendRuntime {
  readonly backend: AgentBackendId = "codex";
  readonly capabilities: ConversationBackendCapabilities = {
    queueWhileRunning: false,
    askUserQuestion: false,
    preciseFork: false,
    portableMcpAtStart: true,
    portableMcpBetweenTurns: true,
    contextWindowMetrics: false,
  };

  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  private _status: "alive" | "dead" = "alive";
  private threadId: string | null;
  private isFirstTurn: boolean;
  private stagedPortableMcp: PortableMcpConfig | null;
  private readonly sessionInstructions: string[];
  private readonly worktreePath: string;
  private readonly conversationId: string;
  private readonly deps: CodexConversationRuntimeDeps;

  constructor(
    input: ConversationBackendCreateInput,
    deps: CodexConversationRuntimeDeps = defaultDeps,
  ) {
    this.threadId =
      input.persistedRef?.backend === "codex"
        ? input.persistedRef.threadId
        : null;
    this.isFirstTurn = this.threadId == null;
    this.stagedPortableMcp = input.tooling.portableMcp ?? null;
    this.sessionInstructions = input.sessionInstructions;
    this.worktreePath = input.worktreePath;
    this.conversationId = input.conversationId;
    this.modelId = input.modelId;
    this.reasoningEffort = input.reasoningEffort;
    this.outputFormat = input.outputFormat;
    this.deps = deps;

    logger.info("codex-runtime.created", {
      conversationId: input.conversationId,
      modelId: input.modelId,
      hasPersistedRef: !!input.persistedRef,
    });
  }

  get status(): "alive" | "dead" {
    return this._status;
  }

  async sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    const startedAt = this.deps.now();
    let cleanupImageDir: (() => Promise<void>) | null = null;
    const wasFirstTurn = this.isFirstTurn;

    // Mutable accumulator — mutated from inside event callbacks, so must be
    // an object to avoid TypeScript's closure narrowing dropping assignments.
    const acc = {
      knownThreadId: null as string | null,
      lastAgentMessageText: null as string | null,
      usage: null as Usage | null,
      errorMessage: null as string | null,
      aborted: false,
      processCrashed: false,
    };
    const contentBlocks: MessageContentBlock[] = [];

    try {
      // Build prompt payload
      const promptInput = await this.buildPromptInput(input);
      cleanupImageDir = promptInput.cleanup;

      // Build per-turn Codex client options
      const codexOptions = this.buildCodexOptions();

      // Create Codex client and thread
      const codex = this.deps.createCodex(codexOptions);
      const threadOptions = this.buildThreadOptions();

      const isResume = this.threadId != null;
      const thread = isResume
        ? codex.resumeThread(this.threadId!, threadOptions)
        : codex.startThread(threadOptions);

      logger.info("codex-runtime.turn_start", {
        conversationId: this.conversationId,
        isResume,
        threadId: this.threadId,
        threadOptions,
        modelId: this.modelId,
        reasoningEffort: this.reasoningEffort,
        hasOutputFormat: !!this.outputFormat,
        hasMcpServers: !!codexOptions.config,
        promptLength:
          typeof promptInput.input === "string"
            ? promptInput.input.length
            : Array.isArray(promptInput.input)
              ? promptInput.input.length
              : 0,
      });

      // Start streaming
      const streamed = await thread.runStreamed(promptInput.input, {
        signal: input.signal,
        ...(this.outputFormat
          ? { outputSchema: this.outputFormat.schema }
          : {}),
      });

      // Process events
      for await (const event of streamed.events) {
        this.processEvent(event, input, contentBlocks, {
          setThreadId: (id) => {
            acc.knownThreadId = id;
            this.threadId = id;
            this.isFirstTurn = false;
          },
          setLastAgentMessageText: (text) => {
            acc.lastAgentMessageText = text;
          },
          setUsage: (u) => {
            acc.usage = u;
          },
          setErrorMessage: (msg) => {
            acc.errorMessage = msg;
          },
        });
      }
    } catch (err) {
      const isResumeFailure =
        err instanceof Error &&
        err.message.includes("thread/resume: no rollout found");

      if (isResumeFailure) {
        acc.processCrashed = true;
        acc.errorMessage = `Failed to resume Codex thread ${this.threadId}: ${err instanceof Error ? err.message : String(err)}`;
        if (this.threadId && !acc.knownThreadId) {
          acc.knownThreadId = this.threadId;
        }
      } else if (isAbortError(err) || input.signal.aborted) {
        acc.aborted = true;
      } else {
        acc.processCrashed = true;
        // Preserve error from turn.failed event if already captured —
        // it contains more useful detail than the generic process exit error.
        if (!acc.errorMessage) {
          acc.errorMessage = err instanceof Error ? err.message : String(err);
        }
        logger.error("codex-runtime.turn_error", {
          conversationId: this.conversationId,
          error: acc.errorMessage,
          rawError: err instanceof Error ? err.message : String(err),
          threadId: acc.knownThreadId,
          modelId: this.modelId,
          reasoningEffort: this.reasoningEffort,
          wasFirstTurn,
        });
      }
    } finally {
      if (cleanupImageDir) {
        try {
          await cleanupImageDir();
        } catch {
          // Best-effort cleanup
        }
      }
    }

    // When the process crashes on a first turn, reset internal state so the
    // next turn starts a fresh thread instead of trying to resume the dead one.
    // Graceful turn.failed events (no process crash) preserve the threadId
    // because the server-side thread may still be alive.
    if (acc.processCrashed && wasFirstTurn) {
      this.threadId = null;
      this.isFirstTurn = true;
      acc.knownThreadId = null;

      logger.info("codex-runtime.reset_after_failed_first_turn", {
        conversationId: this.conversationId,
      });
    }

    // Build structured output from last agent_message text
    let structuredOutput: unknown;
    if (this.outputFormat && acc.lastAgentMessageText) {
      try {
        structuredOutput = JSON.parse(acc.lastAgentMessageText);
      } catch {
        // Not valid JSON despite outputFormat being set
      }
    }

    const backendRef = acc.knownThreadId
      ? { backend: "codex" as const, threadId: acc.knownThreadId }
      : null;

    const result: ConversationBackendTurnResult = {
      backendRef,
      costUsd: null,
      durationMs: this.deps.now() - startedAt,
      numTurns: 1,
      contextTokens: acc.usage?.input_tokens ?? null,
      contextWindowMax: null,
      contentBlocks,
      structuredOutput,
      aborted: acc.aborted,
      error: acc.errorMessage,
    };

    logger.info("codex-runtime.turn_end", {
      conversationId: this.conversationId,
      threadId: acc.knownThreadId,
      aborted: acc.aborted,
      hasError: !!acc.errorMessage,
      contentBlockCount: contentBlocks.length,
    });

    return result;
  }

  async applyPortableMcpConfig(
    config: PortableMcpConfig,
  ): Promise<McpApplyResult> {
    const { droppedFields } = this.deps.translatePortableMcpToCodex(config);
    this.stagedPortableMcp = config;

    logger.info("codex-runtime.mcp_staged", {
      conversationId: this.conversationId,
      serverCount: config.servers.length,
      droppedFields,
    });

    return {
      disposition: "deferred_to_next_turn",
      droppedServerIds: [],
      droppedFields,
      errors: {},
    };
  }

  close(): void {
    if (this._status === "dead") return;
    this._status = "dead";
    this.threadId = null;
    this.stagedPortableMcp = null;

    logger.info("codex-runtime.close", {
      conversationId: this.conversationId,
    });
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private async buildPromptInput(
    input: ConversationBackendTurnInput,
  ): Promise<{ input: Input; cleanup: (() => Promise<void>) | null }> {
    // Assemble text sections
    const textParts: string[] = [];

    if (this.isFirstTurn && this.sessionInstructions.length > 0) {
      textParts.push(
        "```\n## System Instructions\n" +
          this.sessionInstructions.join("\n\n") +
          "\n```",
      );
    }

    if (this.isFirstTurn && input.syntheticForkSeed) {
      textParts.push(input.syntheticForkSeed);
    }

    textParts.push(input.promptText);
    const finalPrompt = textParts.join("\n\n");

    // If no images, pass as plain string
    if (input.images.length === 0) {
      return { input: finalPrompt, cleanup: null };
    }

    // Materialize images to temp files
    const turnDir = path.join(
      this.worktreePath,
      ".cc-tmp",
      "codex-images",
      this.conversationId,
      `turn-${this.deps.now()}`,
    );
    await this.deps.mkdir(turnDir, { recursive: true });

    const imageInputs: Array<{ type: "local_image"; path: string }> = [];
    for (let i = 0; i < input.images.length; i++) {
      const img = input.images[i]!;
      const ext = mimeToExt(img.mediaType);
      const filePath = path.join(turnDir, `${i}.${ext}`);
      await this.deps.writeFile(
        filePath,
        Buffer.from(img.base64Data, "base64"),
      );
      imageInputs.push({ type: "local_image", path: filePath });
    }

    const userInput: Input = [
      { type: "text", text: finalPrompt },
      ...imageInputs,
    ];

    const cleanup = async () => {
      await this.deps.rm(turnDir, { recursive: true, force: true });
    };

    return { input: userInput, cleanup };
  }

  private buildCodexOptions(): CodexOptions {
    const env = this.deps.toStringEnv({
      ...this.deps.buildChildEnv(),
      CLAUDECODE: "",
    });

    const options: CodexOptions = { env };

    if (this.stagedPortableMcp) {
      const { mcpServers } = this.deps.translatePortableMcpToCodex(
        this.stagedPortableMcp,
      );
      if (Object.keys(mcpServers).length > 0) {
        options.config = {
          mcp_servers: mcpServers,
        } as CodexOptions["config"];
      }
    }

    return options;
  }

  private buildThreadOptions(): ThreadOptions {
    const options: ThreadOptions = {
      workingDirectory: this.worktreePath,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
    };

    if (this.modelId) {
      options.model = this.modelId;
    }
    if (this.reasoningEffort) {
      options.modelReasoningEffort = this
        .reasoningEffort as ThreadOptions["modelReasoningEffort"];
    }

    return options;
  }

  private processEvent(
    event: ThreadEvent,
    input: ConversationBackendTurnInput,
    contentBlocks: MessageContentBlock[],
    acc: {
      setThreadId(id: string): void;
      setLastAgentMessageText(text: string): void;
      setUsage(u: Usage): void;
      setErrorMessage(msg: string): void;
    },
  ): void {
    switch (event.type) {
      case "thread.started":
        acc.setThreadId(event.thread_id);
        input.onEvent({
          type: "backend_init",
          backendRef: { backend: "codex", threadId: event.thread_id },
        });
        break;

      case "item.started":
        this.processItemStarted(event, input, contentBlocks);
        break;

      case "item.completed":
        this.processItemCompleted(event, input, contentBlocks, acc);
        break;

      case "turn.completed":
        acc.setUsage(event.usage);
        break;

      case "turn.failed":
        acc.setErrorMessage(event.error.message);
        break;

      case "error":
        acc.setErrorMessage(event.message);
        break;

      // turn.started, item.updated — ignored
    }
  }

  private processItemStarted(
    event: ItemStartedEvent,
    input: ConversationBackendTurnInput,
    contentBlocks: MessageContentBlock[],
  ): void {
    const { item } = event;
    switch (item.type) {
      case "command_execution": {
        const block: MessageContentBlock = {
          type: "text",
          text: `$ ${item.command}`,
        };
        contentBlocks.push(block);
        input.onEvent({ type: "content", block });
        break;
      }
      case "mcp_tool_call": {
        const block: MessageContentBlock = {
          type: "tool_use",
          name: item.tool,
          input: {
            server: item.server,
            arguments: item.arguments,
          } as Record<string, unknown>,
        };
        contentBlocks.push(block);
        input.onEvent({ type: "content", block });
        break;
      }
    }
  }

  private processItemCompleted(
    event: ItemCompletedEvent,
    input: ConversationBackendTurnInput,
    contentBlocks: MessageContentBlock[],
    acc: {
      setLastAgentMessageText(text: string): void;
      setErrorMessage(msg: string): void;
    },
  ): void {
    const { item } = event;
    switch (item.type) {
      case "agent_message": {
        const block: MessageContentBlock = { type: "text", text: item.text };
        contentBlocks.push(block);
        acc.setLastAgentMessageText(item.text);
        input.onEvent({ type: "content", block });
        break;
      }
      case "command_execution": {
        if (item.aggregated_output) {
          const block: MessageContentBlock = {
            type: "text",
            text: item.aggregated_output,
          };
          contentBlocks.push(block);
          input.onEvent({ type: "content", block });
        }
        break;
      }
      case "mcp_tool_call": {
        const content = extractMcpToolResultContent(item as McpToolCallItem);
        const block: MessageContentBlock = {
          type: "tool_result",
          tool_use_id: item.id,
          content,
        };
        contentBlocks.push(block);
        input.onEvent({ type: "content", block });
        break;
      }
      case "file_change": {
        const summary = item.changes
          .map((c: { path: string; kind: string }) => `${c.path} (${c.kind})`)
          .join(", ");
        const block: MessageContentBlock = {
          type: "text",
          text: `File changes: ${summary}`,
        };
        contentBlocks.push(block);
        input.onEvent({ type: "content", block });
        break;
      }
      case "error": {
        acc.setErrorMessage(item.message);
        break;
      }
      // reasoning, todo_list, web_search — ignored
    }
  }
}

// ============================================================
// Helpers
// ============================================================

type ItemStartedEvent = Extract<ThreadEvent, { type: "item.started" }>;
type ItemCompletedEvent = Extract<ThreadEvent, { type: "item.completed" }>;

function mimeToExt(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[mediaType] ?? "bin";
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError";
}

function extractMcpToolResultContent(
  item: McpToolCallItem,
): string | undefined {
  // Prefer text content blocks from result
  if (item.result?.content) {
    const textParts = item.result.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          (block as { type: string }).type === "text",
      )
      .map((block) => block.text);
    if (textParts.length > 0) return textParts.join("\n");
  }

  // Fall back to structured content as JSON
  if (item.result?.structured_content != null) {
    return JSON.stringify(item.result.structured_content);
  }

  // Fall back to error message
  if (item.error?.message) {
    return item.error.message;
  }

  return undefined;
}

// ============================================================
// Codex Conversation Backend Factory
// ============================================================

export const codexConversationBackendFactory: ConversationBackendFactory = {
  backend: "codex" as AgentBackendId,

  async createRuntime(
    input: ConversationBackendCreateInput,
  ): Promise<ConversationBackendRuntime> {
    if (input.tooling.claudeSdkServers) {
      const droppedServerIds = Object.keys(input.tooling.claudeSdkServers);
      logger.warn("codex-factory.dropped_claude_sdk_servers", {
        droppedServerIds,
      });
    }

    logger.info("codex-factory.create_runtime", {
      conversationId: input.conversationId,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
    });

    return new CodexConversationRuntime(input);
  },

  validateModelAndEffort(input: {
    modelId?: string;
    reasoningEffort?: string;
  }): void {
    if (input.reasoningEffort) {
      const result = codexReasoningEffortSchema.safeParse(
        input.reasoningEffort,
      );
      if (!result.success) {
        throw new Error(
          `Invalid Codex reasoning effort: "${input.reasoningEffort}". Must be one of: ${codexReasoningEffortSchema.options.join(", ")}.`,
        );
      }

      if (input.modelId) {
        const allowed = getCodexReasoningLevelsForModel(input.modelId);
        if (allowed && !allowed.includes(result.data)) {
          throw new Error(
            `Reasoning effort "${input.reasoningEffort}" is not supported by model "${input.modelId}". Supported: ${allowed.join(", ")}.`,
          );
        }
      }
    }
  },
};

// ============================================================
// Register factory
// ============================================================

registerConversationBackendFactory(codexConversationBackendFactory);
