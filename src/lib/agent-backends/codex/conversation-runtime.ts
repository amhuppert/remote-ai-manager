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
import type {
  MessageContentBlock,
  ToolResultMetrics,
} from "@/lib/conversations/schemas";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import type { AgentBackendId, ConversationBackendCapabilities } from "../types";
import type {
  CodexCapabilityApplyResult,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import type { PortableMcpToCodexResult } from "../mcp-translation";
import { registerConversationBackendFactory } from "../registry-core";
import { backendCapabilities } from "@/lib/agent-backends/capabilities-descriptor";
import {
  codexReasoningEffortSchema,
  getCodexReasoningLevelsForModel,
  getDefaultCodexModel,
  type CodexPricingTable,
} from "@/lib/agent-backends/schemas";
import { estimateCodexCostUsd } from "./pricing";
import { createLogger } from "@/lib/logging";
import type { CodexRuntimeCapabilityConfig } from "@/lib/agent-capabilities/codex-runtime-translator";

// Default dep implementations (used at runtime, injected in tests)
import { Codex } from "@openai/codex-sdk";
import { buildChildEnv } from "@/lib/shared/child-env";
import { buildSessionEnvContract } from "@/lib/agent-gateway/session-env";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { getConfigDirPath, readConfig } from "@/lib/config/loader";
import { toStringEnv } from "./shared";
import { translatePortableMcpToCodex } from "./mcp-translation";
import {
  buildCodexMcpServersConfig,
  listNativeCodexMcpServers,
  type NativeCodexMcpServer,
} from "./native-mcp-suppression";

const logger = createLogger("codex:conversation-runtime");

// ============================================================
// Injectable dependency surface
// ============================================================

interface CodexClientLike {
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
  toStringEnv(env: Record<string, string | undefined>): Record<string, string>;
  /** Server base URL recorded at boot; null when startup has not resolved one. */
  getServerUrl(): string | null;
  /** Instance token; null when startup failed to provision one. */
  getApiToken(): string | null;
  /** Config dir whose `bin/` is prepended to PATH so `cctl` resolves. */
  getConfigDir(): string;
  translatePortableMcpToCodex(
    config: PortableMcpConfig,
  ): PortableMcpToCodexResult;
  listNativeCodexMcpServers(input: {
    cwd: string;
    env: Record<string, string>;
  }): Promise<NativeCodexMcpServer[]>;
  /** Per-model rate overrides from `codex.pricing` in config.json; null when unset. */
  getCodexPricingOverrides(): Promise<CodexPricingTable | null>;
  now(): number;
}

const defaultDeps: CodexConversationRuntimeDeps = {
  createCodex: (options) => new Codex(options) as unknown as CodexClientLike,
  buildChildEnv,
  toStringEnv,
  getServerUrl: getServerBaseUrl,
  getApiToken: getCachedInstanceToken,
  getConfigDir: getConfigDirPath,
  translatePortableMcpToCodex,
  listNativeCodexMcpServers,
  getCodexPricingOverrides: async () =>
    (await readConfig()).codex?.pricing ?? null,
  now: () => Date.now(),
};

// ============================================================
// Codex Conversation Runtime
// ============================================================

export class CodexConversationRuntime implements ConversationBackendRuntime {
  readonly backend: AgentBackendId = "codex";
  readonly capabilities: ConversationBackendCapabilities =
    backendCapabilities("codex");

  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;
  readonly alignmentVersion: number | null;

  private _status: "alive" | "dead" = "alive";
  private threadId: string | null;
  private isFirstTurn: boolean;
  private stagedPortableMcp: PortableMcpConfig | null;
  private stagedCapabilityConfig: CodexRuntimeCapabilityConfig | null;
  private readonly sessionInstructions: string[];
  private readonly worktreePath: string;
  private readonly conversationId: string;
  private readonly projectName: string;
  private readonly sessionName: string;
  /**
   * Graph-workflow lane identity, present only for implementer-lane
   * conversations so the injected env carries CC_WORKFLOW_EXECUTION_ID /
   * CC_WORKFLOW_CONTEXT_ID for `cctl workflow …`. Undefined for every non-lane
   * conversation (both set together or not at all).
   */
  private readonly workflowExecutionId: string | undefined;
  private readonly workflowContextId: string | undefined;
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
    this.stagedCapabilityConfig = input.tooling.codexCapabilityConfig ?? null;
    this.sessionInstructions = input.sessionInstructions;
    this.worktreePath = input.worktreePath;
    this.conversationId = input.conversationId;
    this.projectName = input.projectName;
    this.sessionName = input.sessionName;
    this.workflowExecutionId = input.workflowExecutionId;
    this.workflowContextId = input.workflowContextId;
    this.modelId = input.modelId;
    this.reasoningEffort = input.reasoningEffort;
    this.outputFormat = input.outputFormat;
    this.alignmentVersion = input.alignmentVersion ?? null;
    this.deps = deps;

    logger.info("codex-runtime.created", {
      conversationId: input.conversationId,
      modelId: input.modelId,
      hasPersistedRef: !!input.persistedRef,
      hasCodexCapabilityConfig: this.stagedCapabilityConfig !== null,
    });
  }

  get status(): "alive" | "dead" {
    return this._status;
  }

  async sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    const startedAt = this.deps.now();
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
      const promptInput = this.buildPromptInput(input);

      // Build per-turn Codex client options
      const codexOptions = await this.buildCodexOptions();

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
          typeof promptInput === "string"
            ? promptInput.length
            : Array.isArray(promptInput)
              ? promptInput.length
              : 0,
      });

      // Start streaming. `runStreamed` returns a LAZY generator — the codex
      // process only spawns on the first iteration — so its resolution says
      // nothing about the prompt reaching the agent.
      const streamed = await thread.runStreamed(promptInput, {
        signal: input.signal,
        ...(this.outputFormat
          ? { outputSchema: this.outputFormat.schema }
          : {}),
      });

      // Acceptance is the FIRST ThreadEvent (mirrors Claude's first-raw-
      // provider-message gate): the process is running with the prompt. A
      // spawn/resume failure yields no event, so acceptance never fires and
      // the actor returns queued rows to `pending` for retry instead of
      // falsely marking them delivered (req 4.2).
      let inputAccepted = false;

      // Process events
      for await (const event of streamed.events) {
        if (!inputAccepted) {
          inputAccepted = true;
          input.onEvent({ type: "input_accepted" });
          logger.debug("codex-runtime.input_accepted", {
            conversationId: this.conversationId,
            isResume,
            threadId: this.threadId,
          });
        }
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
      costUsd: await this.estimateTurnCost(acc.usage),
      durationMs: this.deps.now() - startedAt,
      numTurns: 1,
      contextTokens: acc.usage?.input_tokens ?? null,
      contextWindowMax: null,
      contentBlocks,
      structuredOutput,
      aborted: acc.aborted,
      // Codex never surfaces an SDK compaction under CC's view.
      compacted: false,
      error: acc.errorMessage,
    };

    logger.info("codex-runtime.turn_end", {
      conversationId: this.conversationId,
      threadId: acc.knownThreadId,
      aborted: acc.aborted,
      hasError: !!acc.errorMessage,
      contentBlockCount: contentBlocks.length,
      costUsd: result.costUsd,
    });

    return result;
  }

  /**
   * Estimated USD for the turn's token usage (Codex reports tokens, never
   * USD). Best-effort: an unreadable config falls back to default rates
   * rather than dropping the estimate.
   */
  private async estimateTurnCost(usage: Usage | null): Promise<number | null> {
    if (usage === null) return null;

    let pricingOverrides: CodexPricingTable | null = null;
    try {
      pricingOverrides = await this.deps.getCodexPricingOverrides();
    } catch (err) {
      logger.warn("codex-runtime.pricing_overrides_unavailable", {
        conversationId: this.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return estimateCodexCostUsd(
      usage,
      this.modelId ?? getDefaultCodexModel(),
      pricingOverrides,
    );
  }

  /**
   * Replace the staged Codex capability config used to build the next turn's
   * `CodexOptions.config`. The runtime rebuilds options per turn, so simply
   * swapping the field is enough — the change takes effect on the very next
   * `sendTurn` call. Returns `rejected` when the runtime is closed so the
   * apply service can record the failure instead of falsely reporting
   * `applied`.
   */
  async applyCodexCapabilityConfig(
    config: CodexRuntimeCapabilityConfig,
  ): Promise<CodexCapabilityApplyResult> {
    if (this._status === "dead") {
      return { status: "rejected", error: "codex runtime is closed" };
    }
    this.stagedCapabilityConfig = config;
    logger.info("codex-runtime.capability_applied", {
      conversationId: this.conversationId,
      configKeys: Object.keys(config.config).length,
    });
    return { status: "applied" };
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

  private buildPromptInput(input: ConversationBackendTurnInput): Input {
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

    if (input.imageRefs.length === 0) {
      return finalPrompt;
    }

    const imageInputs: Array<{ type: "local_image"; path: string }> =
      input.imageRefs.map((ref) => ({
        type: "local_image",
        path: ref.path,
      }));

    return [{ type: "text", text: finalPrompt }, ...imageInputs];
  }

  private async buildCodexOptions(): Promise<CodexOptions> {
    // Thread the same cctl env contract every spawned session gets (doc 01 §2):
    // identity + server coordinates + PATH prepend, plus the graph-workflow lane
    // identity when this is an implementer lane, so `cctl workflow …` resolves
    // its execution/context from env without flags. Rebuilt per turn because the
    // runtime reconstructs its Codex client each turn.
    const env = this.deps.toStringEnv(
      buildSessionEnvContract({
        baseEnv: { ...this.deps.buildChildEnv(), CLAUDECODE: "" },
        serverUrl: this.deps.getServerUrl(),
        apiToken: this.deps.getApiToken(),
        project: this.projectName,
        session: this.sessionName,
        conversationId: this.conversationId,
        configDir: this.deps.getConfigDir(),
        ...(this.workflowExecutionId !== undefined
          ? { workflowExecutionId: this.workflowExecutionId }
          : {}),
        ...(this.workflowContextId !== undefined
          ? { workflowContextId: this.workflowContextId }
          : {}),
      }),
    );

    const options: CodexOptions = { env };
    const configMerged: Record<string, unknown> = {};

    if (this.stagedPortableMcp !== null) {
      const { mcpServers } = this.deps.translatePortableMcpToCodex(
        this.stagedPortableMcp,
      );
      const nativeServers = await this.listNativeMcpServers(env);
      configMerged.mcp_servers = buildCodexMcpServersConfig({
        managedMcpServers: mcpServers,
        nativeServers,
      });
    }

    if (this.stagedCapabilityConfig !== null) {
      Object.assign(configMerged, this.stagedCapabilityConfig.config);
    }

    if (Object.keys(configMerged).length > 0) {
      options.config = configMerged as CodexOptions["config"];
    }

    return options;
  }

  private async listNativeMcpServers(
    env: Record<string, string>,
  ): Promise<NativeCodexMcpServer[]> {
    try {
      const servers = await this.deps.listNativeCodexMcpServers({
        cwd: this.worktreePath,
        env,
      });
      logger.info("codex-runtime.mcp_native_servers_listed", {
        conversationId: this.conversationId,
        nativeServerCount: servers.length,
      });
      return servers;
    } catch (err) {
      logger.warn("codex-runtime.mcp_native_server_list_failed", {
        conversationId: this.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private buildThreadOptions(): ThreadOptions {
    const options: ThreadOptions = {
      workingDirectory: this.worktreePath,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
    };

    // Always pin a model. With no model the Codex SDK falls back to its own
    // built-in default, which is rejected for ChatGPT-account auth.
    options.model = this.modelId ?? getDefaultCodexModel();
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
          type: "tool_use",
          id: item.id,
          name: "Bash",
          input: { command: unwrapBashCommand(item.command) },
        };
        contentBlocks.push(block);
        input.onEvent({ type: "content", block });
        break;
      }
      case "mcp_tool_call": {
        const block: MessageContentBlock = {
          type: "tool_use",
          id: item.id,
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
        const exitCode = item.exit_code;
        const isError =
          item.status === "failed" ||
          (typeof exitCode === "number" && exitCode !== 0);
        if (item.aggregated_output || isError) {
          const metrics: ToolResultMetrics = {};
          if (typeof exitCode === "number") metrics.exitCode = exitCode;
          const block: MessageContentBlock = {
            type: "tool_result",
            tool_use_id: item.id,
            content: item.aggregated_output || undefined,
            ...(isError ? { isError: true } : {}),
            ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
          };
          contentBlocks.push(block);
          input.onEvent({ type: "content", block });
        }
        break;
      }
      case "mcp_tool_call": {
        const mcpItem = item as McpToolCallItem;
        const content = extractMcpToolResultContent(mcpItem);
        const isError = mcpItem.status === "failed" || mcpItem.error != null;
        const metrics = parseToolResultMetrics(mcpItem.tool, content);
        const block: MessageContentBlock = {
          type: "tool_result",
          tool_use_id: item.id,
          content,
          ...(isError ? { isError: true } : {}),
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
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
      case "reasoning": {
        const block: MessageContentBlock = {
          type: "thinking",
          text: item.text,
        };
        contentBlocks.push(block);
        input.onEvent({ type: "content", block });
        break;
      }
      // todo_list, web_search — ignored
    }
  }
}

// ============================================================
// Helpers
// ============================================================

type ItemStartedEvent = Extract<ThreadEvent, { type: "item.started" }>;
type ItemCompletedEvent = Extract<ThreadEvent, { type: "item.completed" }>;

/** Strip the `/bin/bash -lc '...'` wrapper Codex adds around commands. */
const BASH_WRAPPER_RE = /^\/bin\/bash\s+-lc\s+(['"])(.*)\1$/s;
function unwrapBashCommand(raw: string): string {
  const m = BASH_WRAPPER_RE.exec(raw);
  return m ? m[2]! : raw;
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
