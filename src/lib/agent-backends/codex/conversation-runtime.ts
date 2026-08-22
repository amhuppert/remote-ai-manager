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
  FileChangeItem,
} from "@openai/codex-sdk";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  MessageContentBlock,
  ToolResultMetrics,
} from "@/lib/conversations/schemas";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import type { PortableMcpToCodexResult } from "../mcp-translation";
import {
  codexReasoningEffortSchema,
  getCodexReasoningLevelsForModel,
  getDefaultCodexModel,
  type CodexPricingTable,
} from "@/lib/agent-backends/schemas";
import {
  estimateCodexCostUsd,
  resolveConfiguredCodexPricingOverrides,
} from "./pricing";
import type { AgentFailureClassification } from "../errors";
import type { FsWritePolicy } from "../task";
import {
  buildCodexConversationFsWriteEnvelope,
  type CodexFsWriteEnvelope,
} from "./fs-write-envelope";
import { createCodexFailureClassifier } from "./failure-classifier";
import { createLogger } from "@/lib/logging";
import {
  translateCodexRuntimeCapabilities,
  type CodexCapabilityApplyResult,
  type CodexCapabilityApplyTarget,
  type CodexRuntimeCapabilityConfig,
} from "./runtime-config";

// Default dep implementations (used at runtime, injected in tests)
import { Codex } from "@openai/codex-sdk";
import { buildChildEnv } from "@/lib/shared/child-env";
import { buildSessionEnvContract } from "@/lib/agent-gateway/session-env";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { getConfigDirPath, readConfig } from "@/lib/config/loader";
import { toStringEnv } from "./shared";
import {
  projectSchemaForCodex,
  restoreCodexOptionalOmissions,
} from "./output-schema";
import { translatePortableMcpToCodex } from "./mcp-translation";
import {
  buildCodexMcpServersConfig,
  listNativeCodexMcpServers,
  type NativeCodexMcpServer,
} from "./native-mcp-suppression";
import { withCodexFastMode } from "./fast-mode-config";
import {
  ensureCodexManagedSkillsBridgeForLaunch,
  type CodexManagedSkillsBridgeResult,
} from "./managed-skills-bridge";
import {
  readCodexPersistedCostBaseline,
  type CodexPersistedCostBaseline,
} from "./cost-baseline";

const logger = createLogger("codex:conversation-runtime");

const codexFailureClassifier = createCodexFailureClassifier();

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
  /** Per-model rate overrides from the Codex backend profile; null when unset. */
  getCodexPricingOverrides(): Promise<CodexPricingTable | null>;
  /**
   * Latest persisted cumulative cost for the resumed thread, recovered from
   * the conversation's own transcript. Seeds per-turn cost attribution after
   * a server restart loses the in-memory baseline.
   */
  readPersistedCostBaseline(
    conversationId: string,
    threadRef: string,
  ): Promise<CodexPersistedCostBaseline | null>;
  /** Reconciles the managed skill bundle link in the launch checkout. */
  ensureManagedSkillsBridge(
    checkoutPath: string,
  ): Promise<CodexManagedSkillsBridgeResult>;
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
    resolveConfiguredCodexPricingOverrides(await readConfig()),
  readPersistedCostBaseline: readCodexPersistedCostBaseline,
  ensureManagedSkillsBridge: ensureCodexManagedSkillsBridgeForLaunch,
  now: () => Date.now(),
};

// ============================================================
// Codex Conversation Runtime
// ============================================================

export class CodexConversationRuntime
  implements ConversationBackendRuntime, CodexCapabilityApplyTarget
{
  readonly backend: AgentBackendId = "codex";
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;
  readonly alignmentVersion: number | null;
  /** The write envelope this runtime's turns execute under; undefined when unrestricted. */
  readonly fsWritePolicy: FsWritePolicy | undefined;

  private _status: "alive" | "dead" = "alive";
  private threadId: string | null;
  private isFirstTurn: boolean;
  private stagedPortableMcp: PortableMcpConfig | null;
  private stagedCapabilityConfig: CodexRuntimeCapabilityConfig | null;
  private readonly sessionInstructions: string[];
  private readonly worktreePath: string;
  private readonly conversationId: string;
  private readonly conversationTarget: ConversationTarget;
  /**
   * Conversation identity written into the session env contract. Equals
   * `conversationId` for every ordinary conversation; a caller whose own
   * `conversationId` is a synthetic handle (collaboration lanes) overrides it
   * so `cctl` inside the agent addresses a conversation CC state can resolve.
   */
  private readonly ccScopeConversationId: string;
  /**
   * The signed conversation capability minted for this runtime at spawn
   * (D11/D12). Carried verbatim rather than re-derived: a runtime cannot tell
   * its own kind from the fields above, and the id right above this one is a
   * redirect, so anything derived here would name the wrong conversation.
   */
  private readonly conversationCapability: string | undefined;
  /**
   * Graph-workflow lane identity, present only for implementer-lane
   * conversations so the injected env carries CC_WORKFLOW_EXECUTION_ID /
   * CC_WORKFLOW_CONTEXT_ID for `cctl workflow …`. Undefined for every non-lane
   * conversation (both set together or not at all).
   */
  private readonly workflowExecutionId: string | undefined;
  private readonly workflowContextId: string | undefined;
  private readonly workflowLaneCapability: string | undefined;
  private readonly deps: CodexConversationRuntimeDeps;
  /**
   * Codex `turn.completed` usage is CUMULATIVE for the thread (across exec
   * process invocations), so each turn's attributable cost is the delta
   * against the last cumulative estimate. Summing raw snapshots instead
   * inflated recorded conversation costs by up to ~4x (audit 1beec403).
   */
  private attributedCostBaseline: {
    threadId: string;
    cumulativeCostUsd: number;
  } | null = null;
  /** Thread ref this runtime resumed from, if any — the only case where a
   * persisted baseline can exist in the transcript. */
  private readonly persistedBaselineRef: string | null;
  private persistedBaselineChecked = false;

  constructor(
    input: ConversationBackendCreateInput,
    deps: CodexConversationRuntimeDeps = defaultDeps,
  ) {
    this.threadId =
      input.persistedRef?.backend === "codex" ? input.persistedRef.ref : null;
    this.isFirstTurn = this.threadId == null;
    this.persistedBaselineRef = this.threadId;
    this.stagedPortableMcp = input.tooling.portableMcp ?? null;
    this.stagedCapabilityConfig = input.tooling.capabilities
      ? translateCodexRuntimeCapabilities(input.tooling.capabilities)
      : null;
    this.sessionInstructions = input.sessionInstructions;
    this.worktreePath = input.worktreePath;
    this.conversationId = input.conversationId;
    this.conversationTarget = input.conversationTarget;
    this.ccScopeConversationId =
      input.ccScopeConversationId ?? input.conversationId;
    this.conversationCapability = input.conversationCapability;
    this.workflowExecutionId = input.workflowExecutionId;
    this.workflowContextId = input.workflowContextId;
    this.workflowLaneCapability = input.workflowLaneCapability;
    this.modelId = input.modelId;
    this.reasoningEffort = input.reasoningEffort;
    this.outputFormat = input.outputFormat;
    this.alignmentVersion = input.alignmentVersion ?? null;
    this.fsWritePolicy = input.fsWritePolicy;
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
      failure: null as AgentFailureClassification | null,
      processFailed: false,
      aborted: false,
    };
    const contentBlocks: MessageContentBlock[] = [];

    try {
      const promptInput = this.buildPromptInput(input);

      // Reconcile the managed skill bundle link before every turn so resumed
      // sessions, lane worktrees, and project-scoped conversations self-heal.
      // A conflict degrades to skill-less and never blocks the turn.
      const bridgeResult = await this.deps.ensureManagedSkillsBridge(
        this.worktreePath,
      );
      if (bridgeResult.status === "conflict") {
        logger.warn("codex-runtime.managed_skills_degraded", {
          conversationId: this.conversationId,
          detail: bridgeResult.detail,
        });
      }

      // Build per-turn Codex client options
      const codexFastMode = input.codexFastMode ?? false;
      const codexOptions = await this.buildCodexOptions(codexFastMode);

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
        codexFastMode,
        hasMcpServers: codexOptions.config?.mcp_servers !== undefined,
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
          ? { outputSchema: projectSchemaForCodex(this.outputFormat.schema) }
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
          await input.onEvent({ type: "input_accepted" });
          logger.debug("codex-runtime.input_accepted", {
            conversationId: this.conversationId,
            isResume,
            threadId: this.threadId,
          });
        }
        await this.processEvent(event, input, contentBlocks, {
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
      if (isAbortError(err) || input.signal.aborted) {
        acc.aborted = true;
      } else {
        acc.processFailed = true;
        // Single capture point for thrown provider failures: the classifier
        // decides the failure kind from the raw error, and both the reported
        // `failure` and the continuation disposition below consume that one
        // typed classification — no message re-grepping here.
        const classification = codexFailureClassifier.classify(err);
        if (classification.kind === "stale_resume_ref") {
          acc.failure = {
            ...classification,
            message:
              this.threadId != null
                ? `Failed to resume Codex thread ${this.threadId}: ${classification.message}`
                : classification.message,
          };
          logger.warn("codex-runtime.stale_resume_ref", {
            conversationId: this.conversationId,
            threadId: this.threadId,
            error: acc.failure.message,
          });
        } else {
          // Preserve error from turn.failed event if already captured —
          // it contains more useful detail than the generic process exit
          // error.
          if (acc.errorMessage == null) {
            acc.failure = classification;
          }
          logger.error("codex-runtime.turn_error", {
            conversationId: this.conversationId,
            error: acc.errorMessage ?? classification.message,
            rawError: classification.message,
            threadId: acc.knownThreadId,
            modelId: this.modelId,
            reasoningEffort: this.reasoningEffort,
            wasFirstTurn,
          });
        }
      }
    }

    // Abort honesty: a cancelled turn is aborted even when the codex process
    // answers the interrupt "gracefully" — a turn.failed event (e.g.
    // "Aborted: user") followed by a clean stream end, with no throw. Without
    // this, an external cancellation (pause, safety-net, stall watchdog)
    // misclassifies as a provider sdk_error.
    if (input.signal.aborted) {
      acc.aborted = true;
    }

    const failure = acc.aborted
      ? null
      : (acc.failure ??
        (acc.errorMessage != null
          ? codexFailureClassifier.classify(acc.errorMessage)
          : null));

    // A missing rollout proves the ref unusable. A local process crash only
    // invalidates a first-turn rollout; graceful provider failures and crashes
    // while resuming can leave the server-side thread viable.
    const continuationDisposition =
      failure?.kind === "stale_resume_ref" ||
      (failure != null && acc.processFailed && wasFirstTurn)
        ? "clear"
        : "retain";

    if (continuationDisposition === "clear") {
      this.threadId = null;
      this.isFirstTurn = true;
      acc.knownThreadId = null;
      logger.info("codex-runtime.continuation_cleared_after_failure", {
        conversationId: this.conversationId,
        failureKind: failure?.kind ?? null,
        wasFirstTurn,
      });
    }

    // Build structured output from last agent_message text
    let structuredOutput: unknown;
    if (this.outputFormat && acc.lastAgentMessageText) {
      try {
        structuredOutput = restoreCodexOptionalOmissions(
          this.outputFormat.schema,
          JSON.parse(acc.lastAgentMessageText),
        );
      } catch {
        // Not valid JSON despite outputFormat being set
      }
    }

    const backendRef = acc.knownThreadId
      ? { backend: "codex" as const, ref: acc.knownThreadId }
      : null;

    const cumulativeCostUsd = await this.estimateTurnCost(acc.usage);
    const costUsd = await this.attributeTurnCost(
      acc.knownThreadId ?? this.threadId,
      cumulativeCostUsd,
    );

    const result: ConversationBackendTurnResult = {
      backendRef,
      costUsd,
      cumulativeCostUsd,
      durationMs: this.deps.now() - startedAt,
      numTurns: 1,
      contextTokens: acc.usage?.input_tokens ?? null,
      contextWindowMax: null,
      contentBlocks,
      structuredOutput,
      aborted: acc.aborted,
      // Codex reports cumulative thread counters rather than per-turn ones, so
      // it does not populate the neutral per-turn token record.
      tokenUsage: null,
      // Codex never surfaces an SDK compaction under CC's view.
      compacted: false,
      failure,
      continuationDisposition,
    };

    logger.info("codex-runtime.turn_end", {
      conversationId: this.conversationId,
      threadId: acc.knownThreadId,
      aborted: acc.aborted,
      hasError: failure != null,
      failureKind: result.failure?.kind ?? null,
      continuationDisposition: result.continuationDisposition,
      contentBlockCount: contentBlocks.length,
      costUsd: result.costUsd,
      cumulativeCostUsd,
      // Codex reports CUMULATIVE processed input tokens for the thread, not
      // window occupancy — that is why contextWindowMax stays null.
      cumulativeInputTokens: acc.usage?.input_tokens ?? null,
    });

    return result;
  }

  /**
   * Convert the thread-cumulative cost estimate into this turn's attributable
   * delta. The baseline advances only when a turn actually reports a cost, so
   * an unpriced turn's spend rides into the next attributed one. A cumulative
   * below the baseline means the thread's counters reset (server-side thread
   * restart) — the new cumulative is attributed in full. After a CC restart
   * the in-memory baseline is recovered from the conversation transcript's
   * last codex result frame for the resumed thread.
   */
  private async attributeTurnCost(
    threadId: string | null,
    cumulativeCostUsd: number | null,
  ): Promise<number | null> {
    if (cumulativeCostUsd === null) return null;
    if (threadId === null) return cumulativeCostUsd;

    if (
      this.attributedCostBaseline === null &&
      !this.persistedBaselineChecked &&
      this.persistedBaselineRef !== null
    ) {
      this.persistedBaselineChecked = true;
      try {
        const persisted = await this.deps.readPersistedCostBaseline(
          this.conversationId,
          this.persistedBaselineRef,
        );
        if (persisted !== null && persisted.threadRef === threadId) {
          this.attributedCostBaseline = {
            threadId: persisted.threadRef,
            cumulativeCostUsd: persisted.cumulativeCostUsd,
          };
        }
      } catch (err) {
        logger.warn("codex-runtime.cost_baseline_unavailable", {
          conversationId: this.conversationId,
          threadId,
          error: getErrorMessage(err),
        });
      }
    }

    const baseline = this.attributedCostBaseline;
    const delta =
      baseline !== null &&
      baseline.threadId === threadId &&
      cumulativeCostUsd >= baseline.cumulativeCostUsd
        ? cumulativeCostUsd - baseline.cumulativeCostUsd
        : cumulativeCostUsd;
    this.attributedCostBaseline = { threadId, cumulativeCostUsd };
    return delta;
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
        error: getErrorMessage(err),
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
  async applyCapabilityConfig(
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

  async close(): Promise<void> {
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

  /**
   * Translate this runtime's write policy onto the Codex sandbox, or undefined
   * when the runtime is unrestricted.
   *
   * Throws rather than degrading: the caller is on the turn path, and a policy
   * Codex cannot enforce as written must fail the turn — `danger-full-access`
   * is the alternative, and handing a confined context that would be worse than
   * not confining it at all.
   */
  private buildWriteEnvelope(): CodexFsWriteEnvelope | undefined {
    if (this.fsWritePolicy === undefined) return undefined;
    const result = buildCodexConversationFsWriteEnvelope(this.fsWritePolicy);
    if (result.kind === "unestablishable") {
      throw new Error(
        `Cannot establish the Codex write envelope for conversation ${this.conversationId}: ${result.reason}`,
      );
    }
    return result.envelope;
  }

  private async buildCodexOptions(
    codexFastMode: boolean,
  ): Promise<CodexOptions> {
    // Thread the same cctl env contract every spawned session gets (doc 01 §2):
    // identity + server coordinates + PATH prepend, plus the graph-workflow lane
    // identity when this is an implementer lane, so `cctl workflow …` resolves
    // its execution/context from env without flags. Rebuilt per turn because the
    // runtime reconstructs its Codex client each turn.
    // The sandbox excludes the ambient temp roots, so a confined run's TMPDIR is
    // repointed into its own allowlisted temp — otherwise every temp-writing
    // tool in the turn fails on a directory the envelope does not cover.
    const writeEnvelope = this.buildWriteEnvelope();
    const env = this.deps.toStringEnv(
      buildSessionEnvContract({
        baseEnv: {
          ...this.deps.buildChildEnv(),
          CLAUDECODE: "",
          ...(writeEnvelope ? { TMPDIR: writeEnvelope.tmpDir } : {}),
        },
        serverUrl: this.deps.getServerUrl(),
        apiToken: this.deps.getApiToken(),
        // Scope and session identity come from the DECLARED target, so a project
        // conversation still exports a neutralized CC_SESSION. Only the
        // conversation id is redirected: a collaboration lane's own
        // conversationId is a synthetic handle CC state cannot resolve, so cctl
        // inside the agent is pointed at the originating conversation instead.
        target: {
          ...this.conversationTarget,
          conversationId: this.ccScopeConversationId,
        },
        configDir: this.deps.getConfigDir(),
        ...(this.conversationCapability !== undefined
          ? { conversationCapability: this.conversationCapability }
          : {}),
        ...(this.workflowExecutionId !== undefined
          ? { workflowExecutionId: this.workflowExecutionId }
          : {}),
        ...(this.workflowContextId !== undefined
          ? { workflowContextId: this.workflowContextId }
          : {}),
        ...(this.workflowLaneCapability !== undefined
          ? { workflowLaneCapability: this.workflowLaneCapability }
          : {}),
      }),
    );

    const options: CodexOptions = { env };
    const configMerged: Record<string, unknown> = {
      model_reasoning_summary: "detailed",
      hide_agent_reasoning: false,
    };

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

    // Merged last so nothing above — a staged capability config, a portable-MCP
    // translation — can widen the sandbox it pins.
    if (writeEnvelope) {
      Object.assign(configMerged, writeEnvelope.config);
    }

    options.config = withCodexFastMode(
      configMerged as CodexOptions["config"],
      codexFastMode,
    );

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
        error: getErrorMessage(err),
      });
      return [];
    }
  }

  private buildThreadOptions(): ThreadOptions {
    // A confined context drops `danger-full-access` entirely: `workspace-write`
    // makes the run's WORKING DIRECTORY writable by construction, so the cwd
    // moves to the context's own scratch root and the repository is reached by
    // absolute path (the prompt carries it). A policy that cannot be translated
    // throws, which fails the turn rather than running it unconfined.
    const envelope = this.buildWriteEnvelope();
    const options: ThreadOptions = envelope
      ? {
          workingDirectory: envelope.workingDirectory,
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          webSearchMode: "disabled",
          skipGitRepoCheck: true,
        }
      : {
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
      // Validated upstream by validateModelAndEffort. Cast past the SDK type,
      // which omits the GPT-5.6 "max"/"ultra" levels the Codex CLI accepts (the
      // SDK serializes this field verbatim into --config model_reasoning_effort).
      options.modelReasoningEffort = this
        .reasoningEffort as ThreadOptions["modelReasoningEffort"];
    }

    return options;
  }

  private async processEvent(
    event: ThreadEvent,
    input: ConversationBackendTurnInput,
    contentBlocks: MessageContentBlock[],
    acc: {
      setThreadId(id: string): void;
      setLastAgentMessageText(text: string): void;
      setUsage(u: Usage): void;
      setErrorMessage(msg: string): void;
    },
  ): Promise<void> {
    switch (event.type) {
      case "thread.started":
        acc.setThreadId(event.thread_id);
        await input.onEvent({
          type: "backend_init",
          backendRef: { backend: "codex", ref: event.thread_id },
        });
        break;

      case "item.started":
        await this.processItemStarted(event, input, contentBlocks);
        break;

      case "item.completed":
        await this.processItemCompleted(event, input, contentBlocks, acc);
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

      case "turn.started":
        break;

      case "item.updated":
        logger.debug("codex-runtime.item_updated", {
          conversationId: this.conversationId,
          itemId: event.item.id,
          itemType: event.item.type,
        });
        break;

      default:
        logger.warn("codex-runtime.event_unhandled", {
          conversationId: this.conversationId,
          eventType: (event as { type?: unknown }).type,
        });
    }
  }

  private async processItemStarted(
    event: ItemStartedEvent,
    input: ConversationBackendTurnInput,
    contentBlocks: MessageContentBlock[],
  ): Promise<void> {
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
        await input.onEvent({ type: "content", block });
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
        await input.onEvent({ type: "content", block });
        break;
      }
      case "web_search": {
        const block: MessageContentBlock = {
          type: "tool_use",
          id: item.id,
          name: "WebSearch",
          input: { query: item.query },
        };
        contentBlocks.push(block);
        await input.onEvent({ type: "content", block });
        break;
      }
      case "agent_message":
      case "reasoning":
      case "file_change":
      case "todo_list":
      case "error":
        logger.debug("codex-runtime.item_started_deferred", {
          conversationId: this.conversationId,
          itemId: item.id,
          itemType: item.type,
        });
        break;
      default:
        logger.warn("codex-runtime.item_unhandled", {
          conversationId: this.conversationId,
          lifecycle: "started",
          itemId: (item as { id?: unknown }).id,
          itemType: (item as { type?: unknown }).type,
        });
        break;
    }
  }

  private async processItemCompleted(
    event: ItemCompletedEvent,
    input: ConversationBackendTurnInput,
    contentBlocks: MessageContentBlock[],
    acc: {
      setLastAgentMessageText(text: string): void;
      setErrorMessage(msg: string): void;
    },
  ): Promise<void> {
    const { item } = event;
    switch (item.type) {
      case "agent_message": {
        const block: MessageContentBlock = { type: "text", text: item.text };
        contentBlocks.push(block);
        acc.setLastAgentMessageText(item.text);
        await input.onEvent({ type: "content", block });
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
          await input.onEvent({ type: "content", block });
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
        await input.onEvent({ type: "content", block });
        break;
      }
      case "file_change": {
        const blocks = fileChangeContentBlocks(item);
        logger.debug("codex-runtime.file_change_completed", {
          conversationId: this.conversationId,
          itemId: item.id,
          status: item.status,
          changeCount: item.changes.length,
          changeKinds: item.changes.map((change) => change.kind),
        });
        for (const block of blocks) {
          contentBlocks.push(block);
          await input.onEvent({ type: "content", block });
        }
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
        await input.onEvent({ type: "content", block });
        break;
      }
      case "todo_list": {
        const block: MessageContentBlock = {
          type: "tool_use",
          id: item.id,
          name: "TodoWrite",
          input: { todos: item.items },
        };
        contentBlocks.push(block);
        await input.onEvent({ type: "content", block });
        break;
      }
      case "web_search":
        logger.debug("codex-runtime.web_search_completed", {
          conversationId: this.conversationId,
          itemId: item.id,
          query: item.query,
        });
        break;
      default:
        logger.warn("codex-runtime.item_unhandled", {
          conversationId: this.conversationId,
          lifecycle: "completed",
          itemId: (item as { id?: unknown }).id,
          itemType: (item as { type?: unknown }).type,
        });
        break;
    }
  }
}

// ============================================================
// Helpers
// ============================================================

type ItemStartedEvent = Extract<ThreadEvent, { type: "item.started" }>;
type ItemCompletedEvent = Extract<ThreadEvent, { type: "item.completed" }>;

function fileChangeToolName(
  kind: FileChangeItem["changes"][number]["kind"],
): "Write" | "Edit" | "Delete" {
  switch (kind) {
    case "add":
      return "Write";
    case "update":
      return "Edit";
    case "delete":
      return "Delete";
  }
}

function fileChangeContentBlocks(item: FileChangeItem): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];
  for (const [index, change] of item.changes.entries()) {
    const id = `${item.id}:${index}`;
    blocks.push({
      type: "tool_use",
      id,
      name: fileChangeToolName(change.kind),
      input: { file_path: change.path },
    });
    if (item.status === "failed") {
      blocks.push({ type: "tool_result", tool_use_id: id, isError: true });
    }
  }
  return blocks;
}

/** Strip the shell `-lc '...'` wrapper Codex adds around commands. */
const SHELL_WRAPPER_RE = /^\/bin\/(?:ba|z)?sh\s+-lc\s+(['"])(.*)\1$/s;
function unwrapBashCommand(raw: string): string {
  const m = SHELL_WRAPPER_RE.exec(raw);
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
  backend: "codex",

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
