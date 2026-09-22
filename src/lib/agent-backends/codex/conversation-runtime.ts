import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
/**
 * Codex conversations use one bounded app-server process per CC turn,
 * retaining only the opaque thread reference between turns.
 */

import type { ResolvedCapabilityCascade } from "../runtime-config";
import { CodexSkillCatalog, type CodexSkillInput } from "./skill-catalog";
import {
  discoverCodexSkillCommands,
  publishCodexSkillsChanged,
} from "./skill-discovery";
import {
  captureCodexNativeCursor,
  inspectCodexNativeWindow,
  type CodexNativeCursor,
  type CodexNativeWindow,
} from "./transcript-records";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import {
  createCodexAppServerClient,
  type AppServerClient,
  type AppServerClientOptions,
} from "./app-server-client";
import {
  AppServerRequestError,
  AppServerTransportError,
} from "./app-server-protocol";
import { CodexAppServerEvents, CodexAppServerUsage } from "./app-server-events";
import {
  CodexInstructionState,
  createCodexInstructionStore,
  composeCodexGoverningInstructions,
  type CodexInstructionStore,
} from "./instruction-state";
import { InputDeliveryUncertainError } from "../errors";
import { CODEX_IN_TURN_DELIVERY_ENABLED } from "./rollout-policy";
import { getErrorMessage } from "@/lib/shared/errors";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  CaptureHandoffInput,
  CaptureHandoffResult,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationQueuedUserInput,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import type { PortableMcpToCodexResult } from "../mcp-translation";
import type {
  BackendModelSelection,
  CodexPricingTable,
  CaptureOmissionReason,
} from "@/lib/agent-backends/schemas";
import {
  estimateCodexCostUsd,
  type CodexUsageTokens,
  resolveConfiguredCodexPricingOverrides,
} from "./pricing";
import type { FsWritePolicy } from "../task";
import {
  buildCodexConversationFsWriteEnvelope,
  type CodexFsWriteEnvelope,
} from "./fs-write-envelope";
import { createCodexFailureClassifier } from "./failure-classifier";
import { createLogger } from "@/lib/logging";
import {
  translateCodexRuntimeCapabilities,
  mergeCodexNativeSkillSelectors,
  type CodexCapabilityEmittedConfig,
  type CodexCapabilityApplyResult,
  type CodexCapabilityApplyTarget,
  type CodexRuntimeCapabilityConfig,
} from "./runtime-config";

// Default dep implementations (used at runtime, injected in tests)
import { buildChildEnv } from "@/lib/shared/child-env";
import { buildSessionEnvContract } from "@/lib/agent-gateway/session-env";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { getConfigDirPath, readConfig } from "@/lib/config/loader";
import { toSdkModelReasoningEffort, toStringEnv } from "./shared";
import { appendStructuredOutputInstruction } from "../structured-output-prompt";
import { translatePortableMcpToCodex } from "../mcp-translation";
import {
  buildCodexMcpServersConfig,
  listNativeCodexMcpServers,
  type NativeCodexMcpServer,
} from "./native-mcp-suppression";
import { withCodexFastMode } from "./fast-mode-config";
import { CODEX_NATIVE_MEMORY_CONFIG } from "./native-memory";
import {
  ensureCodexManagedSkillsBridgeForLaunch,
  type CodexManagedSkillsBridgeResult,
} from "./managed-skills-bridge";
import {
  readCodexPersistedCostBaseline,
  type CodexPersistedCostBaseline,
} from "./cost-baseline";
import {
  projectAdmittedCodexModelSelection,
  resolveCodexModelSelection,
  type ResolvedCodexModelSelection,
} from "./model-selection";
import {
  ModelSelectionPolicyError,
  modelSelectionKey,
} from "../model-selection";
import { providerRefDigest } from "../provider-ref-digest";

const logger = createLogger("codex:conversation-runtime");

const codexFailureClassifier = createCodexFailureClassifier();

type CodexUserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | CodexSkillInput;
const notificationScopeSchema = z.object({
  threadId: z.string(),
  turnId: z.string().optional(),
});
const turnSchema = z.object({
  id: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
  error: z.object({ message: z.string() }).nullish(),
});
const captureItemSchema = z.object({ item: z.object({ type: z.string() }) });
const contextCompactionSchema = z.object({
  item: z.object({ type: z.literal("contextCompaction") }),
});
const turnNotificationSchema = z.object({
  threadId: z.string(),
  turn: turnSchema,
});
const turnResponseSchema = z.object({ turn: turnSchema });
const steerResponseSchema = z.object({ turnId: z.string() });
const threadResponseSchema = z.object({
  thread: z.object({ id: z.string(), path: z.string().nullish() }),
  model: z.string(),
  cwd: z.string(),
  approvalPolicy: z.string(),
  sandbox: z.looseObject({ type: z.string() }),
});
const workspaceSandboxSchema = z.object({
  writableRoots: z.array(z.string()),
  excludeTmpdirEnvVar: z.boolean(),
  excludeSlashTmp: z.boolean(),
});
interface CodexCaptureAttempt {
  input: CaptureHandoffInput;
  submitted: boolean;
  modeEstablished: boolean;
  correlatedCompletion: boolean;
  executionCollected: boolean;
  observedActivity: boolean;
  transportIncomplete: boolean;
  omissionReason: CaptureOmissionReason | null;
  controller: AbortController;
  settle(): void;
  settlementDeadline: number | null;
  settlementStartedAt: number | null;
  tokens: CodexUsageTokens | null;
  costUsd: number | null;
  output: Map<
    string,
    { text: string; bytes: number; completed: boolean; commentary: boolean }
  >;
}
interface CodexTurnState {
  client: AppServerClient | null;
  skills?: CodexSkillCatalog;
  threadId: string | null;
  turnId: string | null;
  terminal: boolean;
  completion: PromiseWithResolvers<void>;
  released: PromiseWithResolvers<void>;
  acceptance: Promise<void> | null;
  startRequested: boolean;
  failure: Error | null;
  failureOverridesAbort: boolean;
  suppressOutput: boolean;
  aborted: boolean;
  stopped: Promise<void> | null;
  steer: Promise<void>;
}
async function withinDeadline(
  promise: Promise<void>,
  milliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function isDefiniteSteerRefusal(error: AppServerRequestError): boolean {
  return (
    error.rpcError?.code === -32600 &&
    /(?:no active turn|expected active turn id|turn.*mismatch|not steerable)/i.test(
      error.rpcError.message,
    )
  );
}

// ============================================================
// Injectable dependency surface
// ============================================================

export interface CodexConversationRuntimeDeps {
  inspectNativeWindow?(
    cursor: CodexNativeCursor | null,
    turnId: string,
    options: Parameters<typeof inspectCodexNativeWindow>[2],
  ): Promise<CodexNativeWindow>;
  inTurnDeliveryEnabled?: boolean;
  createAppServer(options: AppServerClientOptions): AppServerClient;
  createInstructionStore(conversationId: string): CodexInstructionStore;
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
  mergeNativeSkillSelectors(
    config: CodexCapabilityEmittedConfig,
    worktreePath: string,
  ): Promise<CodexCapabilityEmittedConfig>;
  skillsChanged?(): void;
  now(): number;
}

const defaultDeps: CodexConversationRuntimeDeps = {
  inTurnDeliveryEnabled: CODEX_IN_TURN_DELIVERY_ENABLED,
  createAppServer: createCodexAppServerClient,
  skillsChanged: publishCodexSkillsChanged,
  mergeNativeSkillSelectors: mergeCodexNativeSkillSelectors,
  createInstructionStore: createCodexInstructionStore,
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
  readonly mcpConfigDelivery = "input-accepted" as const;
  readonly capabilityConfigDelivery = "input-accepted" as const;
  get capabilityWorkingDirectory(): string {
    return this.worktreePath;
  }
  readonly queueUserInput?: (
    input: ConversationQueuedUserInput,
  ) => Promise<void>;
  readonly modelSelection: BackendModelSelection;

  /** The write envelope this runtime's turns execute under; undefined when unrestricted. */
  readonly fsWritePolicy: FsWritePolicy | undefined;

  private _status: "alive" | "dead" = "alive";
  private threadId: string | null;
  private stagedPortableMcp: PortableMcpConfig | null;
  private stagedCapabilityConfig: CodexRuntimeCapabilityConfig | null;
  private lastManagedSkillsFailure: string | null = null;
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
  private readonly workflowCallerConversationId: string | undefined;
  /**
   * Graph-workflow lane identity, present only for implementer-lane
   * conversations so the injected env carries CC_WORKFLOW_EXECUTION_ID /
   * CC_WORKFLOW_CONTEXT_ID for `cctl workflow …`. Undefined for every non-lane
   * conversation (both set together or not at all).
   */
  private readonly workflowExecutionId: string | undefined;
  private readonly workflowContextId: string | undefined;
  private readonly deps: CodexConversationRuntimeDeps;
  private readonly resolvedModelSelection: ResolvedCodexModelSelection;
  private active: CodexTurnState | null = null;
  private readonly initialPurpose: ConversationBackendCreateInput["initialPurpose"];
  private captureAttempt: CodexCaptureAttempt | null = null;
  private captureUsed = false;
  private nativeCaptureWindow: CodexNativeWindow = {
    coverage: "unavailable",
    observedToolActivity: false,
  };
  private cleanupError: Error | null = null;
  private costLedger: number | null = null;
  private costLedgerLoaded = false;
  private readonly instructions: CodexInstructionState;
  private readonly inputDirectories = new Set<string>();

  constructor(
    input: ConversationBackendCreateInput,
    deps: Partial<CodexConversationRuntimeDeps> = {},
  ) {
    this.initialPurpose = input.initialPurpose;
    this.threadId =
      input.persistedRef?.backend === "codex" ? input.persistedRef.ref : null;
    this.stagedPortableMcp = input.tooling.portableMcp ?? null;
    this.stagedCapabilityConfig = input.tooling.capabilities
      ? translateCodexRuntimeCapabilities(
          input.tooling.capabilities,
          input.worktreePath,
        )
      : null;
    this.sessionInstructions = input.sessionInstructions;
    this.worktreePath = input.worktreePath;
    this.conversationId = input.conversationId;
    this.conversationTarget = input.conversationTarget;
    this.ccScopeConversationId =
      input.ccScopeConversationId ?? input.conversationId;
    this.workflowCallerConversationId = input.workflowCallerConversationId;
    this.workflowExecutionId = input.workflowExecutionId;
    this.workflowContextId = input.workflowContextId;
    this.resolvedModelSelection = projectAdmittedCodexModelSelection(
      input.modelSelection,
    );
    this.modelSelection = this.resolvedModelSelection.modelSelection;

    this.fsWritePolicy = input.fsWritePolicy;
    this.deps = { ...defaultDeps, ...deps };
    if (this.deps.inTurnDeliveryEnabled)
      this.queueUserInput = this.steerInput.bind(this);
    this.instructions = new CodexInstructionState(
      this.deps.createInstructionStore(input.conversationId),
    );

    logger.info("codex-runtime.created", {
      conversationId: input.conversationId,
      modelId: this.modelSelection.modelId,
      hasPersistedRef: !!input.persistedRef,
      hasCodexCapabilityConfig: this.stagedCapabilityConfig !== null,
    });
  }

  get status(): "alive" | "dead" {
    return this._status;
  }

  private isClosed(): boolean {
    return this._status === "dead";
  }

  async captureHandoff(
    input: CaptureHandoffInput,
  ): Promise<CaptureHandoffResult> {
    const base: CaptureHandoffResult = {
      modeEstablished: false,
      submitted: false,
      correlatedCompletion: false,
      candidateText: null,
      omissionReason: "unavailable",
      executionSettled: true,
      cleanupFailure: null,
      continuation: this.threadId
        ? {
            disposition: "retain",
            backendRef: { backend: "codex", ref: this.threadId },
            nextRuntime:
              this.initialPurpose || this.isClosed()
                ? "recreate_from_ref"
                : "current",
          }
        : {
            disposition: "clear",
            backendRef: null,
            nextRuntime: "unavailable",
          },
      activity: {
        transport: "complete",
        native: "unavailable",
        prohibited: "not_observed",
        inspectedBytes: null,
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costUsd: null,
        costBasis: null,
        executionMs: null,
        settlementMs: null,
      },
    };
    if (this.cleanupError)
      return {
        ...base,
        executionSettled: false,
        omissionReason: "cleanup_unverified",
        cleanupFailure: {
          code: "cleanup_unverified",
          message: this.cleanupError.message,
        },
      };
    if (
      input.mode !== "instruction-only" ||
      (this.initialPurpose &&
        (this.initialPurpose.mode !== input.mode ||
          this.initialPurpose.captureId !== input.captureId))
    )
      return { ...base, omissionReason: "mode_changed" };
    if (!this.threadId)
      return { ...base, omissionReason: "continuity_unavailable" };
    if (this.captureUsed || this.active || this.isClosed())
      return { ...base, omissionReason: "unavailable" };
    this.captureUsed = true;
    const startedAt = this.deps.now();
    const controller = new AbortController();
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const unsettled = Promise.withResolvers<ConversationBackendTurnResult>();
    const attempt: CodexCaptureAttempt = {
      input,
      submitted: false,
      modeEstablished: false,
      correlatedCompletion: false,
      executionCollected: false,
      observedActivity: false,
      transportIncomplete: false,
      omissionReason: null,
      controller,
      settlementDeadline: null,
      settlementStartedAt: null,
      tokens: null,
      costUsd: null,
      output: new Map(),
      settle: () => {
        if (attempt.settlementDeadline !== null) return;
        clearTimeout(executionTimer);
        attempt.settlementStartedAt = this.deps.now();
        const budget = Math.min(5000, input.limits.settlementMs);
        attempt.settlementDeadline = Date.now() + budget;
        settlementTimer = setTimeout(() => {
          if (attempt.executionCollected && !this.cleanupError) {
            this.nativeCaptureWindow = {
              coverage: "incomplete",
              observedToolActivity:
                this.nativeCaptureWindow.observedToolActivity,
            };
            unsettled.resolve(
              this.refusedResult(
                startedAt,
                new Error("Codex native inspection deadline expired"),
              ),
            );
            return;
          }
          this.cleanupError = new AppServerTransportError(
            "cleanup_unverified",
            "Codex capture settlement deadline expired",
          );
          if (this.active) void this.stopTurn(this.active).catch(() => {});
          unsettled.resolve(this.refusedResult(startedAt, this.cleanupError));
        }, budget);
      },
    };
    this.captureAttempt = attempt;
    this.nativeCaptureWindow = {
      coverage: "unavailable",
      observedToolActivity: false,
    };
    const turnInput: ConversationBackendTurnInput = {
      promptText: input.promptText,
      imageRefs: [],
      sessionInstructions: [],
      modelSelection: this.modelSelection,
      autonomous: true,
      outputFormat: { type: "json_schema", schema: input.outputSchema },
      signal: controller.signal,
      onEvent: async (event) => {
        if (event.type === "transcript_entry") {
          try {
            await input.onTranscript(event.entry);
          } catch {
            this.cleanupError = new AppServerTransportError(
              "cleanup_unverified",
              "Codex capture required transcript write failed",
            );
            throw this.cleanupError;
          }
        }
      },
    };
    if (
      Buffer.byteLength(
        JSON.stringify(this.buildPromptInput(turnInput)),
        "utf8",
      ) > Math.min(8192, input.limits.inputBytes)
    ) {
      this.captureAttempt = null;
      return { ...base, omissionReason: "input_limit" };
    }
    const onAbort = () => {
      const reason: unknown = input.signal.reason;
      this.stopCapture(
        reason === "skip" || reason === "skipped"
          ? "skipped"
          : reason === "cancel" || reason === "cancelled"
            ? "cancelled"
            : "interrupted",
      );
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    const executionTimer = setTimeout(
      () => this.stopCapture("execution_limit"),
      Math.min(60000, input.limits.executionMs),
    );
    if (input.signal.aborted) onAbort();
    let result: ConversationBackendTurnResult;
    try {
      result = await Promise.race([this.runTurn(turnInput), unsettled.promise]);
    } finally {
      clearTimeout(executionTimer);
      clearTimeout(settlementTimer);
      input.signal.removeEventListener("abort", onAbort);
    }
    this._status = "dead";
    const observed =
      attempt.observedActivity || this.nativeCaptureWindow.observedToolActivity;
    const omissionReason = result.cleanupFailure
      ? "cleanup_unverified"
      : observed
        ? "prohibited_activity"
        : this.nativeCaptureWindow.coverage === "incomplete"
          ? "native_inspection_incomplete"
          : (attempt.omissionReason ??
            (result.aborted
              ? "interrupted"
              : !attempt.modeEstablished
                ? "mode_establishment_failed"
                : result.failure ||
                    attempt.transportIncomplete ||
                    !attempt.correlatedCompletion ||
                    !result.finalText
                  ? "capture_failed"
                  : null));
    return {
      ...base,
      modeEstablished: attempt.modeEstablished,
      submitted: attempt.submitted,
      correlatedCompletion: attempt.correlatedCompletion,
      candidateText:
        omissionReason === null ? (result.finalText ?? null) : null,
      omissionReason,
      executionSettled: !result.cleanupFailure,
      cleanupFailure: result.cleanupFailure
        ? { code: "cleanup_unverified", message: result.cleanupFailure.message }
        : null,
      continuation: result.backendRef
        ? {
            disposition: "retain",
            backendRef: result.backendRef,
            nextRuntime: "recreate_from_ref",
          }
        : {
            disposition: "clear",
            backendRef: null,
            nextRuntime: "unavailable",
          },
      usage: {
        inputTokens: attempt.tokens?.input_tokens ?? null,
        outputTokens: attempt.tokens?.output_tokens ?? null,
        cachedInputTokens: attempt.tokens?.cached_input_tokens ?? null,
        costUsd: attempt.costUsd,
        costBasis: attempt.costUsd === null ? null : "pricing_estimate",
        executionMs: Math.max(
          0,
          (attempt.settlementStartedAt ?? this.deps.now()) - startedAt,
        ),
        settlementMs:
          attempt.settlementStartedAt === null
            ? null
            : Math.max(0, this.deps.now() - attempt.settlementStartedAt),
      },
      activity: {
        transport: attempt.transportIncomplete ? "incomplete" : "complete",
        native: this.nativeCaptureWindow.coverage,
        prohibited: observed
          ? "observed"
          : attempt.transportIncomplete ||
              this.nativeCaptureWindow.coverage === "incomplete"
            ? "unknown"
            : "not_observed",
        inspectedBytes: null,
      },
    };
  }

  private stopCapture(reason: CaptureOmissionReason): void {
    const attempt = this.captureAttempt;
    if (!attempt) return;
    attempt.omissionReason ??= reason;
    attempt.settle();
    if (!attempt.controller.signal.aborted) attempt.controller.abort(reason);
  }

  private observeCaptureOutput(method: string, params: unknown): void {
    const attempt = this.captureAttempt;
    if (!attempt || attempt.omissionReason) return;
    const delta = z
      .object({ itemId: z.string(), delta: z.string() })
      .safeParse(params);
    const item = z
      .object({
        item: z.object({
          id: z.string(),
          type: z.literal("agentMessage"),
          text: z.string().optional(),
          phase: z.string().optional(),
        }),
      })
      .safeParse(params);
    const id =
      method === "item/agentMessage/delta" && delta.success
        ? delta.data.itemId
        : (method === "item/completed" || method === "item/started") &&
            item.success
          ? item.data.item.id
          : null;
    if (id === null) return;
    const output = attempt.output.get(id) ?? {
      text: "",
      bytes: 0,
      completed: false,
      commentary: false,
    };
    if (item.success && item.data.item.phase === "commentary") {
      output.commentary = true;
      output.text = "";
      output.bytes = 0;
    }
    attempt.output.set(id, output);
    if (output.commentary || method === "item/started") return;
    if (output.completed) return;
    if (method === "item/agentMessage/delta" && delta.success)
      output.text += delta.data.delta;
    else if (item.success) {
      output.bytes = Math.max(
        output.bytes,
        Buffer.byteLength(item.data.item.text ?? "", "utf8"),
      );
      output.completed = true;
    }
    output.bytes = Math.max(
      output.bytes,
      Buffer.byteLength(output.text, "utf8"),
    );
    attempt.output.set(id, output);
    const bytes = [...attempt.output.values()].reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    if (bytes > Math.min(6144, attempt.input.limits.outputBytes))
      this.stopCapture("output_limit");
  }

  async sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    if (this.initialPurpose || this.captureAttempt)
      return this.refusedResult(
        this.deps.now(),
        new Error("Codex capture binding cannot admit an ordinary turn"),
      );
    return this.runTurn(input);
  }

  private async runTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    const startedAt = this.deps.now();
    if (this._status === "dead" || this.cleanupError !== null) {
      return this.refusedResult(
        startedAt,
        this.cleanupError ?? new Error("Codex runtime is closed"),
      );
    }
    if (this.active !== null)
      return this.refusedResult(
        startedAt,
        new Error("Codex already has an active turn"),
      );
    const state: CodexTurnState = {
      client: null,
      threadId: this.threadId,
      turnId: null,
      terminal: false,
      completion: Promise.withResolvers<void>(),
      released: Promise.withResolvers<void>(),
      acceptance: null,
      startRequested: false,
      failure: null,
      failureOverridesAbort: false,
      suppressOutput: false,
      aborted: input.signal.aborted,
      stopped: null,
      steer: Promise.resolve(),
    };
    this.active = state;
    let nativeCursor: CodexNativeCursor | null = null;
    let nativeCursorFailed = false;
    const projector = new CodexAppServerEvents();
    const usage = new CodexAppServerUsage();
    const blocks: MessageContentBlock[] = [];
    let sequence = 0;
    const unsupportedRequests = new Set<string | number>();
    const wasFresh = this.threadId === null;
    const dispatchedMcp = this.stagedPortableMcp;
    const dispatchedCapabilities = this.stagedCapabilityConfig;
    const mcpConfigHash = dispatchedMcp
      ? computeEffectiveConfigHash(dispatchedMcp)
      : undefined;
    const accept = (): Promise<void> => {
      state.acceptance ??= Promise.resolve().then(() =>
        input.onEvent({
          type: "input_accepted",
          ...(mcpConfigHash ? { mcpConfigHash } : {}),
          ...(dispatchedCapabilities?.capabilities
            ? { capabilities: dispatchedCapabilities.capabilities }
            : {}),
        }),
      );
      return state.acceptance;
    };
    const emitBlocks = async (content: MessageContentBlock[]) => {
      for (const block of content) {
        blocks.push(block);
        await input.onEvent({ type: "content", block });
      }
    };
    const fail = (error: Error) => {
      if (
        error instanceof AppServerTransportError &&
        error.code === "cleanup_unverified"
      )
        this.cleanupError = error;
      if (error instanceof AppServerTransportError) {
        state.failureOverridesAbort = true;
        if (error.code === "consumer_failed") state.suppressOutput = true;
      }
      if (this.captureAttempt) this.captureAttempt.transportIncomplete = true;
      state.failure ??= error;
      state.completion.resolve();
    };
    const onAbort = () => {
      state.aborted = true;
      void this.stopTurn(state).catch(fail);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (state.aborted)
        throw new DOMException("Turn cancelled before dispatch", "AbortError");
      const selection = projectAdmittedCodexModelSelection(
        input.modelSelection,
      );
      if (
        modelSelectionKey(selection.modelSelection) !==
        modelSelectionKey(this.modelSelection)
      ) {
        throw new Error(
          "Codex model selection changed without recreating the conversation runtime.",
        );
      }
      const threadOptions = this.buildThreadOptions();
      const cwd = threadOptions.workingDirectory ?? this.worktreePath;
      const bridge = await this.deps.ensureManagedSkillsBridge(cwd);
      if (bridge.status === "conflict") {
        logger.warn("codex-runtime.managed_skills_degraded", {
          conversationId: this.conversationId,
          detail: bridge.detail,
        });
        if (this.lastManagedSkillsFailure !== bridge.detail) {
          this.lastManagedSkillsFailure = bridge.detail;
          await input.onEvent({
            type: "transcript_entry",
            entry: {
              backend: "codex",
              seq: 0,
              type: "notice",
              raw: {
                timestamp: new Date(this.deps.now()).toISOString(),
                type: "notice",
                role: "notice",
                content: [
                  {
                    type: "text",
                    text: "Command Center skills could not be attached because the reserved skills location is occupied. Move the conflicting entry from .agents/skills/command-center and retry.",
                  },
                ],
              },
            },
          });
        }
      } else {
        this.lastManagedSkillsFailure = null;
      }
      const options = await this.buildCodexOptions(
        undefined,
        dispatchedMcp,
        dispatchedCapabilities,
      );
      const governing = composeCodexGoverningInstructions(
        this.sessionInstructions,
      );
      if (state.aborted || this.isClosed())
        throw new DOMException("Turn cancelled before dispatch", "AbortError");
      const client = this.deps.createAppServer({
        ...(this.captureAttempt ? { captureCleanup: true } : {}),
        cwd: threadOptions.workingDirectory ?? this.worktreePath,
        env: options.env ?? {},
        config: options.config,
        onFailure: fail,
        onServerRequest: async (message) => {
          if (this.captureAttempt) {
            this.captureAttempt.observedActivity = true;
            this.stopCapture("prohibited_activity");
          }
          logger.warn("codex-runtime.server_request_refused", {
            conversationId: this.conversationId,
            method: message.method,
          });
          switch (message.method) {
            case "item/commandExecution/requestApproval":
            case "item/fileChange/requestApproval":
              return { result: { decision: "decline" } };
            case "item/permissions/requestApproval":
              return { result: { permissions: {}, scope: "turn" } };
            case "mcpServer/elicitation/request":
              return { result: { action: "decline" } };
            case "item/tool/call":
              return {
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "Command Center has not registered this dynamic tool",
                    },
                  ],
                },
              };
            default:
              state.failureOverridesAbort = true;
              state.suppressOutput = true;
              state.failure = new Error(
                `Unsupported Codex operation: ${message.method}`,
              );
              unsupportedRequests.add(message.id);
              return {
                error: { code: -32601, message: state.failure.message },
              };
          }
        },
        onNotification: (message) => {
          if (message.method === "skills/changed") {
            state.skills?.invalidate();
            this.deps.skillsChanged?.();
            return;
          }
          if (!state.startRequested) return;
          const lifecycle = turnNotificationSchema.safeParse(message.params);
          if (!lifecycle.success || lifecycle.data.threadId !== state.threadId)
            return;
          if (message.method === "turn/started" && state.turnId === null)
            state.turnId = lifecycle.data.turn.id;
          if (
            message.method === "turn/completed" &&
            lifecycle.data.turn.id === state.turnId
          ) {
            state.terminal = true;
            if (this.captureAttempt) {
              this.captureAttempt.settle();
            }
          }
        },
        onFrame: async (frame) => {
          await input.onEvent({
            type: "transcript_entry",
            entry: {
              seq: sequence++,
              backend: "codex",
              type: "codex_app_server",
              raw: {
                timestamp: new Date(this.deps.now()).toISOString(),
                type: "codex_app_server",
                raw: { record: frame.raw },
              },
            },
          });
          const message = frame.message;
          if (
            message.kind === "server_request" &&
            unsupportedRequests.delete(message.id)
          ) {
            state.completion.resolve();
          }
          if (message.kind !== "notification") return;
          const scope = notificationScopeSchema.safeParse(message.params);
          if (!scope.success || scope.data.threadId !== state.threadId) return;
          if (message.method === "thread/tokenUsage/updated") {
            if (!state.startRequested || scope.data.turnId === state.turnId)
              usage.observe(message.params, !state.startRequested);
            return;
          }
          const compaction =
            message.method === "thread/compacted" ||
            ((message.method === "item/started" ||
              message.method === "item/completed") &&
              contextCompactionSchema.safeParse(message.params).success);
          if (
            compaction &&
            (!state.startRequested ||
              scope.data.turnId === undefined ||
              scope.data.turnId === state.turnId)
          ) {
            projector.consume(message.method, message.params);
            await this.instructions.invalidate();
            return;
          }
          if (
            scope.data.turnId !== undefined &&
            scope.data.turnId !== state.turnId
          )
            return;
          if (
            message.method === "turn/started" ||
            message.method === "turn/completed"
          ) {
            const lifecycle = turnNotificationSchema.parse(message.params);
            if (lifecycle.turn.id !== state.turnId || !state.startRequested)
              return;
            await accept();
            if (message.method === "turn/completed") {
              if (lifecycle.turn.status === "failed")
                state.failure = new Error(
                  lifecycle.turn.error?.message ?? "Codex turn failed",
                );
              if (lifecycle.turn.status === "interrupted") state.aborted = true;
              if (this.captureAttempt)
                this.captureAttempt.correlatedCompletion =
                  lifecycle.turn.status === "completed";
              state.terminal = true;
              state.completion.resolve();
            }
            return;
          }
          if (!state.startRequested) return;
          if (
            this.captureAttempt &&
            (message.method === "turn/plan/updated" ||
              ((message.method === "item/started" ||
                message.method === "item/completed") &&
                captureItemSchema.safeParse(message.params).success &&
                ![
                  "agentMessage",
                  "userMessage",
                  "reasoning",
                  "contextCompaction",
                ].includes(captureItemSchema.parse(message.params).item.type)))
          ) {
            this.captureAttempt.observedActivity = true;
            this.stopCapture("prohibited_activity");
          }
          this.observeCaptureOutput(message.method, message.params);
          if (message.method === "error") {
            logger.warn("codex-runtime.provider_diagnostic", {
              conversationId: this.conversationId,
            });
            return;
          }
          if (state.acceptance === null) return;
          await state.acceptance;
          const wasCompacted = projector.compacted;
          await emitBlocks(projector.consume(message.method, message.params));
          if (!wasCompacted && projector.compacted)
            await this.instructions.invalidate();
        },
      });
      state.client = client;
      if (state.aborted || this.isClosed())
        throw new DOMException("Turn cancelled before dispatch", "AbortError");
      await client.request("initialize", {
        clientInfo: { name: "command-center", version: "1.0.0" },
        capabilities: { experimentalApi: false },
      });
      client.notify("initialized");
      if (!this.captureAttempt)
        state.skills = new CodexSkillCatalog(client, cwd);
      const request = {
        model: this.resolvedModelSelection.modelId,
        cwd: threadOptions.workingDirectory,
        approvalPolicy: "never",
        sandbox: threadOptions.sandboxMode,
        config: {
          ...options.config,
          web_search: "disabled",
          model_reasoning_effort: this.resolvedModelSelection.reasoningEffort,
        },
        ...(wasFresh
          ? { developerInstructions: governing }
          : { threadId: this.threadId, excludeTurns: true }),
      };
      const thread = threadResponseSchema.parse(
        await client.request(
          wasFresh ? "thread/start" : "thread/resume",
          request,
        ),
      );
      this.verifyEffectiveThread(thread, threadOptions);
      if (this.captureAttempt && thread.thread.id !== this.threadId) {
        this.captureAttempt.omissionReason = "continuity_unavailable";
        throw new Error("Codex capture resumed a different thread");
      }
      if (this.captureAttempt) this.captureAttempt.modeEstablished = true;
      state.threadId = thread.thread.id;
      this.threadId = thread.thread.id;
      await input.onEvent({
        type: "backend_init",
        backendRef: { backend: "codex", ref: thread.thread.id },
      });
      if (!this.captureAttempt)
        await this.loadCostLedger(thread.thread.id, wasFresh);
      if (!this.captureAttempt)
        await this.instructions.establish(
          thread.thread.id,
          governing,
          wasFresh,
          async (text) => {
            await client.request("thread/inject_items", {
              threadId: thread.thread.id,
              items: [
                {
                  type: "message",
                  role: "developer",
                  content: [{ type: "input_text", text }],
                },
              ],
            });
          },
        );
      await client.flush();
      if (state.aborted || this.isClosed())
        throw new DOMException("Turn cancelled before dispatch", "AbortError");
      const skillInputs = state.skills
        ? await state.skills.invocations(
            input.userPromptText ?? input.promptText,
          )
        : [];
      const promptInput = this.buildPromptInput(input, skillInputs);
      if (state.aborted || this.isClosed())
        throw new DOMException("Turn cancelled before dispatch", "AbortError");
      if (this.captureAttempt && thread.thread.path != null) {
        try {
          nativeCursor = await captureCodexNativeCursor(thread.thread.path);
        } catch {
          nativeCursorFailed = true;
        }
      }
      if (state.aborted || this.isClosed())
        throw new DOMException(
          "Capture stopped before submission",
          "AbortError",
        );
      state.startRequested = true;
      if (this.captureAttempt) this.captureAttempt.submitted = true;
      const started = turnResponseSchema.parse(
        await client.request("turn/start", {
          threadId: thread.thread.id,
          input: promptInput,
          model: this.resolvedModelSelection.modelId,
          effort: this.resolvedModelSelection.reasoningEffort,
          summary: "detailed",
        }),
      );
      if (state.turnId !== null && state.turnId !== started.turn.id)
        throw new Error("Codex start acknowledgement named a different turn");
      state.turnId = started.turn.id;
      await accept();
      await state.completion.promise;
      await state.steer;
      if (this.captureAttempt) {
        try {
          await client.close();
        } catch (error) {
          this.cleanupError =
            error instanceof Error
              ? error
              : new Error("Codex capture cleanup failed");
          throw this.cleanupError;
        }
      }
      await client.flush();
      if (!state.suppressOutput) await emitBlocks(projector.finish());
      if (state.failure !== null) throw state.failure;
    } catch (error) {
      if (
        input.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      )
        state.aborted = true;
      else
        state.failure ??=
          error instanceof Error ? error : new Error(getErrorMessage(error));
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      this.captureAttempt?.settle();
      try {
        if (!state.terminal && state.startRequested) await this.stopTurn(state);
        else await state.client?.close();
        if (this.captureAttempt) this.captureAttempt.executionCollected = true;
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(getErrorMessage(error));
        if (
          this.captureAttempt ||
          (error instanceof AppServerTransportError &&
            error.code === "cleanup_unverified")
        )
          this.cleanupError = failure;
        state.failure ??= failure;
      }
      if (this.captureAttempt) {
        this.nativeCaptureWindow =
          nativeCursorFailed ||
          (this.captureAttempt.submitted && state.turnId === null)
            ? { coverage: "incomplete", observedToolActivity: false }
            : await (this.deps.inspectNativeWindow ?? inspectCodexNativeWindow)(
                nativeCursor,
                state.turnId ?? "",
                {
                  maxBytes:
                    this.captureAttempt.input.limits.nativeInspectionBytes,
                  deadline: Math.min(
                    this.captureAttempt.settlementDeadline ?? Infinity,
                    Date.now() +
                      this.captureAttempt.input.limits.nativeInspectionMs,
                  ),
                },
              );
        if (this.nativeCaptureWindow.observedToolActivity)
          state.failure ??= new Error(
            "Codex capture observed prohibited native tool activity",
          );
        else if (this.nativeCaptureWindow.coverage === "incomplete")
          state.failure ??= new Error(
            "Codex capture native evidence is incomplete",
          );
      }
      await state.steer;
      const cleanup = await Promise.allSettled(
        [...this.inputDirectories].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      if (cleanup.some((entry) => entry.status === "rejected"))
        logger.warn("codex-runtime.input_files_cleanup_failed", {
          conversationId: this.conversationId,
        });
      this.inputDirectories.clear();
      this.active = null;
      if (state.skills) this.deps.skillsChanged?.();
      state.released.resolve();
    }
    const cleanupFailure =
      this.cleanupError === null
        ? undefined
        : {
            kind: "cleanup_unverified" as const,
            message: this.cleanupError.message,
          };
    const failure = cleanupFailure
      ? {
          kind: "backend_error" as const,
          message: cleanupFailure.message,
          retryable: false,
        }
      : state.aborted && !state.failureOverridesAbort
        ? null
        : state.failure === null
          ? null
          : codexFailureClassifier.classify(
              state.failure instanceof AppServerRequestError &&
                state.failure.rpcError
                ? new Error(state.failure.rpcError.message)
                : state.failure,
            );
    const clear = failure?.kind === "stale_resume_ref";
    if (clear) this.threadId = null;
    const measuredTokens =
      this.captureAttempt && !usage.hasBaseline ? null : usage.tokens;
    const costUsd = await this.estimateTurnCost(measuredTokens);
    if (this.captureAttempt) {
      this.captureAttempt.tokens = measuredTokens;
      this.captureAttempt.costUsd = costUsd;
    }
    if (state.startRequested && !this.captureAttempt)
      this.costLedger =
        this.costLedger !== null && costUsd !== null
          ? this.costLedger + costUsd
          : null;
    const result: ConversationBackendTurnResult = {
      backendRef:
        this.threadId === null
          ? null
          : { backend: "codex", ref: this.threadId },
      costUsd,
      cumulativeCostUsd: this.costLedger,
      durationMs: this.deps.now() - startedAt,
      numTurns: state.acceptance === null ? 0 : 1,
      contextTokens: null,
      contextWindowMax: null,
      contentBlocks: blocks,
      finalText: projector.finalText,
      aborted: state.aborted,
      tokenUsage: null,
      compacted: projector.compacted,
      failure,
      continuationDisposition: clear ? "clear" : "retain",
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
    logger.info(
      this.captureAttempt
        ? "codex-runtime.capture_end"
        : "codex-runtime.turn_end",
      {
        conversationId: this.conversationId,
        threadIdDigest: providerRefDigest(this.threadId),
        failureKind: failure?.kind ?? null,
        costUsd,
        cumulativeCostUsd: result.cumulativeCostUsd,
      },
    );
    return result;
  }

  private async steerInput(input: ConversationQueuedUserInput): Promise<void> {
    const state = this.active;
    const threadId = state?.threadId;
    const turnId = state?.turnId;
    if (
      !state ||
      !threadId ||
      !turnId ||
      state.terminal ||
      state.aborted ||
      this._status === "dead" ||
      !state.client
    ) {
      throw new Error("Codex has no active turn ready for steering");
    }
    const client = state.client;
    const delivery = state.steer.then(async () => {
      if (
        this.active !== state ||
        state.terminal ||
        state.aborted ||
        this._status === "dead" ||
        input.signal?.aborted
      )
        throw new Error("Codex turn ended before steering");
      const content = await this.prepareLiveInput(input);
      if (!state.skills) throw new Error("Codex skill catalog is not ready");
      content.push(
        ...(await state.skills.invocations(
          input.userPromptText ??
            input.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
        )),
      );
      if (state.terminal || state.aborted || input.signal?.aborted)
        throw new Error("Codex turn ended before steering");
      const barrier = client.barrier();
      let accepted = false;
      try {
        const reply = steerResponseSchema.parse(
          await client.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: content,
            clientUserMessageId: randomUUID(),
          }),
        );
        if (reply.turnId !== turnId)
          throw new InputDeliveryUncertainError(
            "Codex steering acknowledgement named a different turn",
          );
        accepted = true;
        await input.onAccepted?.();
        barrier.release();
      } catch (error) {
        if (accepted) {
          const failure = new InputDeliveryUncertainError(
            `Accepted input could not be archived: ${getErrorMessage(error)}`,
          );
          state.failure = failure;
          state.failureOverridesAbort = true;
          state.suppressOutput = true;
          barrier.fail(failure);
          await this.stopTurn(state);
          throw failure;
        }
        barrier.release();
        if (
          error instanceof AppServerRequestError &&
          (!error.requestMayHaveBeenWritten || isDefiniteSteerRefusal(error))
        )
          throw error;
        throw error instanceof InputDeliveryUncertainError
          ? error
          : new InputDeliveryUncertainError(
              `Codex input delivery could not be confirmed: ${getErrorMessage(error)}`,
            );
      }
    });
    state.steer = delivery.catch(() => {});
    return delivery;
  }

  private async prepareLiveInput(
    input: ConversationQueuedUserInput,
  ): Promise<CodexUserInput[]> {
    const content: CodexUserInput[] = [];
    if (input.promptContext)
      content.push({ type: "text", text: input.promptContext });
    let directory: string | undefined;
    for (const block of input.content) {
      if (block.type === "text")
        content.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        directory ??= await mkdtemp(
          path.join(
            this.buildWriteEnvelope()?.tmpDir ?? tmpdir(),
            "cc-codex-input-",
          ),
        );
        this.inputDirectories.add(directory);
        const file = path.join(
          directory,
          `${content.length}.${block.mediaType.split("/")[1]}`,
        );
        await writeFile(file, Buffer.from(block.base64Data, "base64"));
        content.push({ type: "localImage", path: file });
      } else throw new Error(`Codex live input does not support ${block.type}`);
    }
    return content;
  }

  private async stopTurn(state: CodexTurnState): Promise<void> {
    state.stopped ??= (async () => {
      const client = state.client;
      if (!client) return;
      if (this.captureAttempt) {
        this.captureAttempt.settle();
        if (!state.terminal && state.threadId && state.turnId)
          void client
            .request("turn/interrupt", {
              threadId: state.threadId,
              turnId: state.turnId,
            })
            .catch(() => {});
        try {
          await client.close();
        } catch (error) {
          this.cleanupError =
            error instanceof Error
              ? error
              : new Error("Codex capture cleanup failed");
          throw this.cleanupError;
        } finally {
          state.completion.resolve();
        }
        return;
      }
      if (!state.terminal && state.threadId && state.turnId) {
        await withinDeadline(
          (async () => {
            await client.request("turn/interrupt", {
              threadId: state.threadId,
              turnId: state.turnId,
            });
            await state.completion.promise;
          })().catch(() => {}),
          5_000,
        );
      }
      try {
        await client.close();
      } finally {
        state.completion.resolve();
      }
    })();
    return state.stopped;
  }

  private async loadCostLedger(
    threadId: string,
    fresh: boolean,
  ): Promise<void> {
    if (fresh) {
      this.costLedger = 0;
      this.costLedgerLoaded = true;
      return;
    }
    if (this.costLedgerLoaded) return;
    this.costLedgerLoaded = true;
    try {
      const prior = await this.deps.readPersistedCostBaseline(
        this.conversationId,
        threadId,
      );
      this.costLedger =
        prior?.threadRef === threadId ? prior.cumulativeCostUsd : null;
    } catch {
      this.costLedger = null;
    }
  }

  private verifyEffectiveThread(
    thread: z.infer<typeof threadResponseSchema>,
    requested: ThreadOptions,
  ): void {
    const sandbox =
      requested.sandboxMode === "workspace-write"
        ? "workspaceWrite"
        : "dangerFullAccess";
    if (
      thread.model !== requested.model ||
      thread.cwd !== requested.workingDirectory ||
      thread.approvalPolicy !== "never" ||
      thread.sandbox.type !== sandbox
    ) {
      throw new Error(
        "Codex app-server did not apply the requested model, working directory, approval, and sandbox policy",
      );
    }
    if (this.fsWritePolicy && sandbox === "workspaceWrite") {
      const effective = workspaceSandboxSchema.parse(thread.sandbox);
      const writableRoots = new Set([thread.cwd, ...effective.writableRoots]);
      const requestedRoots = new Set(this.fsWritePolicy.allowWrite);
      if (
        effective.excludeTmpdirEnvVar !== true ||
        effective.excludeSlashTmp !== true ||
        writableRoots.size !== requestedRoots.size ||
        [...requestedRoots].some((root) => !writableRoots.has(root))
      ) {
        throw new Error(
          "Codex app-server did not apply the requested writable roots",
        );
      }
    }
  }

  private refusedResult(
    startedAt: number,
    error: Error,
  ): ConversationBackendTurnResult {
    return {
      backendRef: this.threadId
        ? { backend: "codex", ref: this.threadId }
        : null,
      costUsd: null,
      cumulativeCostUsd: this.costLedger,
      durationMs: this.deps.now() - startedAt,
      numTurns: 0,
      contextTokens: null,
      contextWindowMax: null,
      contentBlocks: [],
      aborted: false,
      compacted: false,
      failure: {
        kind: "backend_error",
        message: error.message,
        retryable: false,
      },
      continuationDisposition: "retain",
      ...(this.cleanupError
        ? {
            cleanupFailure: {
              kind: "cleanup_unverified",
              message: this.cleanupError.message,
            } as const,
          }
        : {}),
    };
  }

  private async estimateTurnCost(
    usage: CodexUsageTokens | null,
  ): Promise<number | null> {
    if (usage === null) return null;
    let pricingOverrides: CodexPricingTable | null = null;
    try {
      pricingOverrides = await this.deps.getCodexPricingOverrides();
    } catch (error) {
      logger.warn("codex-runtime.pricing_overrides_unavailable", {
        conversationId: this.conversationId,
        error: getErrorMessage(error),
      });
    }
    return estimateCodexCostUsd(
      usage,
      this.modelSelection.modelId,
      pricingOverrides,
    );
  }

  /** Stage native selection; only the accepting turn acknowledges delivery. */
  async applyCapabilityConfig(
    config: CodexRuntimeCapabilityConfig,
  ): Promise<CodexCapabilityApplyResult> {
    if (this._status === "dead") {
      return { status: "rejected", error: "codex runtime is closed" };
    }
    this.stagedCapabilityConfig = config;
    logger.info("codex-runtime.capability_staged", {
      conversationId: this.conversationId,
      configKeys: Object.keys(config.config).length,
    });
    return { status: "deferred", reason: "next_turn" };
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
    this._status = "dead";
    const state = this.active;
    if (state) {
      await this.stopTurn(state);
      await state.released.promise;
    }
    if (this.cleanupError !== null) throw this.cleanupError;
  }

  async getSkillCommands(capabilities?: ResolvedCapabilityCascade) {
    if (this.active?.skills && !this.active.terminal)
      return this.active.skills.commands();
    const options = await this.buildCodexOptions(capabilities);
    const cwd = this.buildThreadOptions().workingDirectory ?? this.worktreePath;
    return discoverCodexSkillCommands(cwd, options.config ?? {}, {
      createAppServer: this.deps.createAppServer,
      ensureManagedSkillsBridge: this.deps.ensureManagedSkillsBridge,
      buildEnv: () => options.env ?? {},
    });
  }

  private buildPromptInput(
    input: ConversationBackendTurnInput,
    skills: readonly CodexSkillInput[] = [],
  ): CodexUserInput[] {
    const text = [
      input.syntheticForkSeed,
      input.promptContext,
      input.promptText,
    ]
      .filter(Boolean)
      .join("\n\n");
    const schema =
      this.captureAttempt?.input.outputSchema ?? input.outputFormat?.schema;
    const prompt = schema
      ? appendStructuredOutputInstruction(text, schema)
      : text;
    return [
      { type: "text", text: prompt },
      ...skills,
      ...input.imageRefs.map((ref) => ({
        type: "localImage" as const,
        path: ref.path,
      })),
    ];
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
    capabilities?: ResolvedCapabilityCascade,
    portableMcp: PortableMcpConfig | null = this.stagedPortableMcp,
    stagedCapabilityConfig: CodexRuntimeCapabilityConfig | null = this
      .stagedCapabilityConfig,
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
        ...(this.workflowCallerConversationId !== undefined
          ? { workflowCallerConversationId: this.workflowCallerConversationId }
          : {}),
        ...(this.workflowExecutionId !== undefined
          ? { workflowExecutionId: this.workflowExecutionId }
          : {}),
        ...(this.workflowContextId !== undefined
          ? { workflowContextId: this.workflowContextId }
          : {}),
      }),
    );

    const options: CodexOptions = { env };
    const configMerged: Record<string, unknown> = {
      model_reasoning_summary: "detailed",
      hide_agent_reasoning: false,
    };

    if (portableMcp !== null) {
      const { mcpServers } = this.deps.translatePortableMcpToCodex(portableMcp);
      const nativeServers = await this.listNativeMcpServers(env);
      configMerged.mcp_servers = buildCodexMcpServersConfig({
        managedMcpServers: mcpServers,
        nativeServers,
      });
    }

    const capabilityConfig = capabilities
      ? translateCodexRuntimeCapabilities(capabilities, this.worktreePath)
      : stagedCapabilityConfig;
    if (capabilityConfig)
      Object.assign(
        configMerged,
        await this.deps.mergeNativeSkillSelectors(
          capabilityConfig.config,
          this.worktreePath,
        ),
      );

    // Merged last so nothing above — a staged capability config, a portable-MCP
    // translation — can widen the sandbox it pins.
    if (writeEnvelope) {
      Object.assign(configMerged, writeEnvelope.config);
    }

    // After the envelope, and touching none of the keys it pins: Command
    // Center's memory library is a replacement for Codex's own store, so no
    // layer above may hand the turn a second memory system back.
    Object.assign(configMerged, CODEX_NATIVE_MEMORY_CONFIG);

    options.config = withCodexFastMode(
      configMerged as CodexOptions["config"],
      this.resolvedModelSelection.fastMode,
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

    options.model = this.resolvedModelSelection.modelId;
    options.modelReasoningEffort = toSdkModelReasoningEffort(
      this.resolvedModelSelection.reasoningEffort,
    );

    return options;
  }
}

// ============================================================
// Codex Conversation Backend Factory
// ============================================================

export type ReadConfiguredCodexModelSelection =
  () => Promise<BackendModelSelection>;

const readConfiguredCodexModelSelection: ReadConfiguredCodexModelSelection =
  async () => (await readConfig()).agentBackends.codex.modelSelection;

export function createCodexConversationBackendFactory(
  readConfiguredSelection: ReadConfiguredCodexModelSelection = readConfiguredCodexModelSelection,
): ConversationBackendFactory {
  return {
    backend: "codex",

    async createRuntime(
      input: ConversationBackendCreateInput,
    ): Promise<ConversationBackendRuntime> {
      logger.info("codex-factory.create_runtime", {
        conversationId: input.conversationId,
        modelId: input.modelSelection.modelId,
      });

      return new CodexConversationRuntime(input);
    },

    validateModelSelection(selection: BackendModelSelection): void {
      projectAdmittedCodexModelSelection(selection);
    },

    async validateProjectModelSelection({ projectPath, modelSelection }) {
      let configuredSelection: BackendModelSelection;
      try {
        configuredSelection = await readConfiguredSelection();
      } catch (error) {
        const message = getErrorMessage(error);
        logger.warn("codex-factory.model_selection_config_unavailable", {
          projectPath,
          modelId: modelSelection.modelId,
          error: message,
        });
        return {
          ok: false,
          code: "model_catalog_unavailable",
          message,
          modelId: modelSelection.modelId,
        };
      }

      try {
        const resolved = resolveCodexModelSelection(
          modelSelection,
          configuredSelection,
        );
        return { ok: true, modelSelection: resolved.modelSelection };
      } catch (error) {
        if (error instanceof ModelSelectionPolicyError) {
          const issue = error.issues[0];
          logger.warn("codex-factory.model_selection_refused", {
            projectPath,
            modelId: issue?.modelId ?? modelSelection.modelId,
            code: issue?.code ?? "model_selection_invalid",
            ...(issue?.parameterId === undefined
              ? {}
              : { parameterId: issue.parameterId }),
          });
          return {
            ok: false,
            code: issue?.code ?? "model_selection_invalid",
            message: error.message,
            modelId: issue?.modelId ?? modelSelection.modelId,
            ...(issue?.parameterId === undefined
              ? {}
              : { parameterId: issue.parameterId }),
          };
        }

        const message = getErrorMessage(error);
        logger.warn("codex-factory.model_selection_refused", {
          projectPath,
          modelId: modelSelection.modelId,
          code: "model_selection_invalid",
        });
        return {
          ok: false,
          code: "model_selection_invalid",
          message,
          modelId: modelSelection.modelId,
        };
      }
    },
  };
}

export const codexConversationBackendFactory =
  createCodexConversationBackendFactory();
