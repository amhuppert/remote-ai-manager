import type { ResolvedCapabilityCascade } from "./runtime-config";
import type { ExecutionIntent } from "./execution-admission";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type {
  ConversationBackgroundActivity,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { BackendModelSelection, ConversationTokenUsage } from "./schemas";
import type { FsWritePolicy } from "./task";
import type { ConversationToolingOverrides } from "./types";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "./errors";
import type { PortableMcpConfig, McpApplyResult } from "./portable-mcp";
import type { McpDiscoveredTool } from "@/lib/mcp/schemas";
import type { AgentTranscriptEntry } from "./transcript";
import type { ProjectModelOptions } from "./project-model-options";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { InTurnQuestionReply } from "@/lib/conversations/in-turn-question-schemas";

/**
 * Payload for `onBackgroundTasksLost`: the waitable background tasks that were
 * still in flight when the backend session died. Their processes are children
 * of the backend subprocess — they die with it, and their completion can no
 * longer wake the agent.
 */
export interface BackgroundTasksLostInfo {
  tasks: Array<{ taskId: string; description: string | null }>;
  /** Why the session died — e.g. "closed", "pump_completed", "pump_error". */
  reason: string;
}

/**
 * The conversation-visible view of a backend's live background work. The Zod
 * schema in the conversations domain is the source of truth for this shape;
 * re-exported here so backend-neutral code has one vocabulary to import.
 */
export type {
  ConversationBackgroundActivity,
  ConversationBackgroundTaskView,
} from "@/lib/conversations/schemas";

/**
 * Server-side reference to an image already saved on disk under the
 * conversation's transcript images directory. Each ref carries the assigned
 * cumulative `index` (used in `[Image #N]` markers in the prompt text), the
 * media type, the absolute filesystem `path`, and the in-memory `base64Data`
 * the actor still holds from the inbound request. Backends consume whichever
 * fields their SDK requires — Claude uses `base64Data` for inline image
 * blocks plus `path` for the `[Image #N source: …]` annotation, while Codex
 * passes `path` directly through `local_image`.
 */
export interface ConversationImageRef {
  index: number;
  mediaType: string;
  path: string;
  base64Data: string;
}

/**
 * Neutral operational events a conversation runtime emits across the backend
 * seam. Adapters interpret their provider's native frames into these; nothing
 * above the seam sees a raw provider payload except the lossless
 * `transcript_entry` envelope, which the caller records without reading into
 * `entry.raw`.
 */
export type ConversationBackendEvent =
  | { type: "backend_init"; backendRef: AgentSessionRef }
  | { type: "content"; block: MessageContentBlock }
  | { type: "transcript_entry"; entry: AgentTranscriptEntry }
  | { type: "error"; message: string }
  | { type: "input_accepted"; mcpConfigHash?: string }
  | { type: "external_turn_started" }
  | {
      type: "external_turn_completed";
      result: ConversationBackendTurnResult;
    };

/**
 * Backend-agnostic summary of a bounded wait the turn-execution path performed
 * for in-flight background tasks before reporting the turn complete. Present on
 * a turn result only when a wait actually occurred. Structurally identical to
 * the claude-specific `BackgroundWaitOutcome`, kept independent here so this
 * shared file does not depend on a backend implementation.
 */
export interface BackgroundWaitSummary {
  /** Waitable in-flight task ids captured when the wait began. */
  waitedTaskIds: string[];
  /** The `waitedTaskIds` that had settled by the time the wait resolved. */
  settledTaskIds: string[];
  /** True when the hard maximum wait duration elapsed before settlement. */
  timedOut: boolean;
  /** Wall-clock duration of the wait. */
  durationMs: number;
}

export interface ConversationBackendTurnInput {
  onUserQuestion?(
    questions: AskQuestionItem[],
    signal: AbortSignal,
  ): Promise<InTurnQuestionReply>;
  promptText: string;
  imageRefs: readonly ConversationImageRef[];
  sessionInstructions: string[];
  modelSelection: BackendModelSelection;
  autonomous: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  signal: AbortSignal;
  onEvent(event: ConversationBackendEvent): Promise<void> | void;
  syntheticForkSeed?: string | null;
  /**
   * Opt-in: hold this turn open after the agent yields until its in-flight
   * waitable background tasks settle (or the wait times out). Set by the
   * graph-workflow implementer turn and by collaboration lane turns; every
   * other turn (including interactive) leaves it unset so behavior is
   * unchanged. Backends without background-task lifecycle signals ignore it.
   */
  waitForBackgroundTasks?: boolean;
  /**
   * Hard maximum wait duration in ms applied when `waitForBackgroundTasks` is
   * set. Falls back to the backend's default when omitted.
   */
  backgroundTaskWaitTimeoutMs?: number;
}

export interface ConversationBackendTurnResult {
  backendRef: AgentSessionRef | null;
  /**
   * Cost attributed to THIS turn. Consumers sum per-turn values, so a backend
   * whose provider reports lineage-cumulative counters must convert to a
   * delta before reporting here.
   */
  costUsd: number | null;
  /**
   * Lineage-cumulative cost as of this turn, for backends whose provider
   * reports cumulative counters (Codex threads). Feeds the transcript result
   * frame so persisted frames stay cumulative (lossless w.r.t. the provider
   * and consistent with pre-existing transcripts); never summed by consumers.
   * Omitted by backends without a cumulative counter.
   */
  cumulativeCostUsd?: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  contentBlocks: MessageContentBlock[];
  /** Canonical final-response text when the backend exposes it separately. */
  finalText?: string | null;
  structuredOutput?: unknown;
  aborted: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
  /**
   * Normalized classification of the turn's failure (via the backend's
   * `AgentFailureClassifier`); null for a clean turn. Aborted turns report
   * through `aborted`, not here.
   */
  failure: AgentFailureClassification | null;
  /**
   * Whether the persisted continuation ref for this conversation is still
   * usable after this turn. The adapter decides from its provider's
   * continuation semantics: "clear" forces the next turn to start fresh,
   * "retain" keeps the last-known ref resumable.
   */
  continuationDisposition: ContinuationDisposition;
  /**
   * Summary of the bounded background-task wait this turn performed. Present
   * only when a wait actually occurred (the turn opted in and waitable tasks
   * were in flight); absent for every other turn.
   */
  backgroundWait?: BackgroundWaitSummary;
  /**
   * Token accounting attributed to THIS turn — at most one record per turn,
   * reported at the terminal outcome. `null` means the backend could not
   * report usage for this turn (cancelled, failed, or a provider that does not
   * expose counts); counts are never fabricated or carried over from another
   * turn. Absent where a backend has not adopted the record at all.
   */
  tokenUsage?: ConversationTokenUsage | null;
  /** Workspace ownership remains live when process cleanup cannot be verified. */
  cleanupFailure?: { kind: "cleanup_unverified"; message: string };
}

export interface ConversationQueuedUserInput {
  content: MessageContentBlock[];
  /**
   * Invoke exactly once after provider acceptance, before releasing subsequent
   * output. Rejection means archival failed: stop the turn without retrying the
   * accepted input. Confirmed archival with failed queue settlement resolves;
   * the queue owns that review outcome and prohibits automatic redelivery.
   */
  onAccepted?(): Promise<void>;
  signal?: AbortSignal;
}

/** Why `prepareForTurnStart` is being invoked. */
export type EnsureReadyReason = "turn_start" | "stream_closed";

/**
 * Outcome of a runtime's pre-turn readiness check. `ready` means the runtime
 * may receive the prompt; `recreate-runtime` asks the caller (the actor) to
 * close and recreate the runtime (resume-preserving) before delivering — the
 * runtime never tears itself down for this, it only signals.
 */
export type ReadyResult =
  | { status: "ready" }
  | { status: "recreate-runtime"; reason: string };

export interface ConversationBackendRuntime {
  /** The selection actually attached when a backend restores a persisted snapshot. */
  readonly capabilitiesAtCreation?: ResolvedCapabilityCascade;
  readonly backend: AgentBackendId;
  readonly status: "alive" | "dead";
  /**
   * True while a caller-initiated turn is in flight. Backends whose runtime
   * has no live turn state (per-turn process re-materialization) omit it;
   * callers treat `undefined` as not-active.
   */
  readonly isTurnActive?: boolean;
  /** Configuration is prepared at dispatch and acknowledged with its exact hash. */
  readonly mcpConfigDelivery?: "input-accepted";
  readonly modelSelection: BackendModelSelection;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  /**
   * The write envelope baked into this runtime at creation, or undefined for an
   * unrestricted one. Read by the caller's recreation check: an envelope is
   * established when the backend session starts, so a turn whose policy differs
   * from the live runtime's needs a new runtime rather than a new prompt.
   */
  readonly fsWritePolicy?: FsWritePolicy;

  sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult>;
  /**
   * Signal that the caller has acquired this runtime and is about to begin a
   * new turn. Implementations should use this to cancel any inactivity timers
   * that could otherwise fire during the caller's pre-turn pipeline (state
   * reads, MCP discovery, capability cascades, etc.) and tear the runtime down
   * mid-prep. No-op if the runtime is dead.
   */
  notifyTurnStarting?(): void;
  /**
   * Pre-turn readiness contract, awaited by the caller AFTER the pre-turn
   * pipeline and BEFORE the prompt is delivered. A runtime that cannot be made
   * ready returns `recreate-runtime`, asking the caller to recreate it
   * (resume-preserving); otherwise `{ status: "ready" }`. Backends that need no
   * special pre-turn preparation do not implement it, so the caller treats an
   * absent method as `{ status: "ready" }`.
   */
  prepareForTurnStart?(): Promise<ReadyResult>;
  /** Resolves on acceptance; ambiguous delivery rejects with InputDeliveryUncertainError. */
  queueUserInput?(input: ConversationQueuedUserInput): Promise<void>;
  applyPortableMcpConfig?(config: PortableMcpConfig): Promise<McpApplyResult>;
  supportedCommands?(): Promise<readonly { name: string }[]>;
  supportedAgents?(): Promise<readonly { name: string }[]>;
  /**
   * Return the live MCP server's advertised tool list when the runtime can
   * report it authoritatively (e.g. Claude's `mcpServerStatus()`). Returns
   * `undefined` when the runtime has no status for `serverKey` or the backend
   * does not support runtime-side tool reporting.
   */
  listMcpServerTools?(
    serverKey: string,
  ): Promise<readonly McpDiscoveredTool[] | undefined>;
  /**
   * Tear the runtime down. Resolves only once teardown has been verified or a
   * bounded cleanup failure has been recorded, so lifecycle callers can order
   * destructive follow-up work — worktree removal, dev-server stop — after the
   * backend has actually released the workspace. Backends whose teardown is
   * synchronous resolve immediately.
   */
  close(): Promise<void>;
}

export interface ConversationBackendCreateInput extends ExecutionIntent {
  conversationId: string;
  /**
   * Conversation ID this runtime addresses on the CC side: the identity put
   * into the session env contract, so `cctl` inside the agent resolves a
   * conversation that exists in CC state. Defaults to `conversationId` when
   * omitted. Collaboration lanes set this to the originating conversation
   * because their own `conversationId` is a synthetic per-lane handle (or a
   * raw backend session id) that CC state cannot resolve.
   */
  ccScopeConversationId?: string;
  /**
   * The signed conversation capability workflow authority is derived from
   * (D7 D11/D12), minted by the conversation actor for a durable ordinary
   * conversation — one a human addresses directly.
   *
   * Minted upstream under the conversation's OWN id rather than derived here,
   * because `ccScopeConversationId` above is a redirect: a collaboration lane
   * points it at its originating conversation, so any authority derived from
   * the CC-side id would be that human's. Runtimes that are handed none carry
   * none, which is what keeps a lane, the planner, and a collaboration runtime
   * unable to claim a launch origin.
   */
  conversationCapability?: string;
  projectPath: string;
  projectName: string;
  /**
   * Declared conversation scope (D4). The caller knows authoritatively whether
   * this is a session or a project conversation, so it passes the discriminated
   * target forward; a runtime must never re-derive scope from a session name or
   * a worktree path. `projectName`/`conversationId` above restate the target's
   * scope-INVARIANT identity for the many call sites that need only those two —
   * `sessionName` was the one scope-varying field, and it lives here now so a
   * project conversation structurally has no session name to leak.
   */
  conversationTarget: ConversationTarget;
  worktreePath: string;
  persistedRef: AgentSessionRef | null;
  modelSelection: BackendModelSelection;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };

  sessionInstructions: string[];
  tooling: ConversationToolingOverrides;
  /**
   * Graph-workflow lane identity for implementer-lane conversations. Threaded
   * into the session env (CC_WORKFLOW_EXECUTION_ID / CC_WORKFLOW_CONTEXT_ID) so
   * `cctl workflow …` resolves its execution/context without flags. Omitted for
   * every non-lane conversation.
   */
  workflowExecutionId?: string;
  workflowContextId?: string;
  /**
   * The signed implementer-lane capability (D4 R7), minted at dispatch and
   * exported as CC_WORKFLOW_LANE_CAPABILITY. Present only for lanes whose
   * dispatch could mint one; a lane without it simply cannot expand the graph.
   */
  workflowLaneCapability?: string;
  /**
   * Server-derived filesystem-write envelope this runtime's turns execute under
   * (see `fsWritePolicySchema`). Composed by the graph-workflow implementer
   * dispatch path for a context that declares ownership, absent for every
   * unrestricted conversation. A runtime that cannot establish a policy it was
   * given REFUSES to be created: absent means unrestricted, so a factory that
   * degraded to "created it anyway" would silently un-confine the lane.
   */
  fsWritePolicy?: FsWritePolicy;
  /**
   * Optional callback invoked by the backend runtime when SDK messages arrive
   * between caller-initiated turns — e.g. Claude Code's background-task
   * auto-continuation. Emits `external_turn_started`, the interpreted
   * `content`/`transcript_entry` events, and `external_turn_completed` for
   * each virtual turn.
   */
  onExternalTurnEvent?: (event: ConversationBackendEvent) => void;
  /**
   * Optional callback invoked at most once, when the backend session dies with
   * waitable background tasks still in flight. The caller surfaces the loss to
   * the user (transcript notice) and to the conversation's next turn.
   */
  onBackgroundTasksLost?: (info: BackgroundTasksLostInfo) => void;
  /**
   * Optional callback invoked whenever the backend's live background-task set
   * changes — a task starting, settling, or reporting progress. `null` means
   * nothing is running. Backends without background-task lifecycle signals
   * never call it. The caller publishes the snapshot so a conversation running
   * background work between turns does not read as idle.
   */
  onBackgroundActivity?: (
    activity: ConversationBackgroundActivity | null,
  ) => void;
}

/**
 * Outcome of a backend's project-scoped model resolution. Acceptance carries
 * the canonical complete selection; refusal carries the operator-facing reason
 * the caller turns into a bounded client error.
 */
export type ProjectModelSelectionValidation =
  | { ok: true; modelSelection: BackendModelSelection }
  | {
      ok: false;
      code: string;
      message: string;
      modelId: string;
      parameterId?: string;
    };

export interface ConversationBackendFactory {
  readonly backend: AgentBackendId;
  createRuntime(
    input: ConversationBackendCreateInput,
  ): Promise<ConversationBackendRuntime>;
  validateModelSelection?(selection: BackendModelSelection): void;
  /**
   * Optional project-scoped model resolution, for a backend whose selectable
   * models are a property of the project rather than of Command Center.
   * Declared separately from `validateModelSelection` because that hook is
   * synchronous and project-blind: it cannot read a project's configuration,
   * so it cannot answer membership in a per-project list.
   *
   * Called before a turn is accepted so an unsupported selection costs neither
   * a process nor a billable turn. An accepted result carries the canonical
   * complete selection the caller must persist and dispatch.
   */
  validateProjectModelSelection?(input: {
    projectPath: string;
    modelSelection: BackendModelSelection;
  }): Promise<ProjectModelSelectionValidation>;
  /**
   * The project's permitted models, for creation surfaces that must offer only
   * what this project allows. Declared by the same backends that declare
   * `validateProjectModelSelection`, and answering the same authority — a
   * surface that offered anything else would be offering a selection the
   * validation hook is about to refuse.
   */
  resolveProjectModelOptions?(input: {
    projectPath: string;
  }): Promise<ProjectModelOptions>;
}

/**
 * The graph-workflow lane identity a conversation runs under: which execution
 * and context it implements, plus the signed capability that proves it is THAT
 * context's bound implementer (D4 R7). Carried as one value from the implementer
 * runner through the conversation actor to the session-env builder, so the three
 * fields cannot drift apart on the way.
 */
export interface WorkflowLaneIdentity {
  executionId: string;
  contextId: string;
  /** Absent when the server has no capability signing key. */
  laneCapability?: string;
}
