import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type {
  ConversationBackgroundActivity,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationToolingOverrides } from "./types";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "./errors";
import type { PortableMcpConfig, McpApplyResult } from "./portable-mcp";
import type { McpDiscoveredTool } from "@/lib/mcp/schemas";
import type { AgentTranscriptEntry } from "./transcript";

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
  | { type: "input_accepted" }
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
  promptText: string;
  imageRefs: readonly ConversationImageRef[];
  sessionInstructions: string[];
  modelId?: string;
  reasoningEffort?: string;
  codexFastMode?: boolean;
  autonomous: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  signal: AbortSignal;
  onEvent(event: ConversationBackendEvent): Promise<void> | void;
  syntheticForkSeed?: string | null;
  /**
   * Opt-in: hold this turn open after the agent yields until its in-flight
   * waitable background tasks settle (or the wait times out). Set only by the
   * graph-workflow implementer turn; every other turn (including interactive)
   * leaves it unset so behavior is unchanged. Backends without background-task
   * lifecycle signals ignore it.
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
  costUsd: number | null;
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
}

export interface ConversationQueuedUserInput {
  content: MessageContentBlock[];
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
  readonly backend: AgentBackendId;
  readonly status: "alive" | "dead";
  /**
   * True while a caller-initiated turn is in flight. Backends whose runtime
   * has no live turn state (per-turn process re-materialization) omit it;
   * callers treat `undefined` as not-active.
   */
  readonly isTurnActive?: boolean;
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;
  /**
   * Active alignment charter version baked into this runtime's instructions at
   * creation (null when no active charter). Compared against the live active
   * version to decide whether the runtime must be recreated.
   */
  readonly alignmentVersion: number | null;

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
  close(): void;
}

export interface ConversationBackendCreateInput {
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
  modelId?: string;
  reasoningEffort?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /**
   * Active alignment charter version baked into `sessionInstructions`. Stamped
   * onto the runtime for version-gated recreation; omitted/null when none.
   */
  alignmentVersion?: number | null;
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

export interface ConversationBackendFactory {
  readonly backend: AgentBackendId;
  createRuntime(
    input: ConversationBackendCreateInput,
  ): Promise<ConversationBackendRuntime>;
  validateModelAndEffort?(input: {
    modelId?: string;
    reasoningEffort?: string;
  }): void;
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
  /** Absent when the server had no instance token to sign with. */
  laneCapability?: string;
}
