import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type {
  AgentBackendId,
  AgentSessionRef,
  ConversationBackendCapabilities,
  ConversationToolingOverrides,
} from "./types";
import type { PortableMcpConfig, McpApplyResult } from "./portable-mcp";
import type { McpDiscoveredTool } from "@/lib/mcp/schemas";
import type { ClaudeRuntimeCapabilityConfig } from "@/lib/agent-capabilities/claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "@/lib/agent-capabilities/codex-runtime-translator";

/**
 * Result of a live capability-config apply attempt against a Claude
 * conversation runtime. Mirrors `ClaudeApplyPortResult` from the
 * capability apply service so the port can pass-through directly.
 */
export type ClaudeCapabilityApplyResult =
  | { status: "applied" }
  | { status: "rejected"; error: string }
  | { status: "skipped-turn-active" };

/**
 * Result of pushing a refreshed capability-config payload into a live Codex
 * runtime between turns. Codex always rebuilds its `CodexOptions` per turn,
 * so the runtime only needs to store the new config; the next turn picks it
 * up automatically. Mirrors `CodexApplyPortResult` from the capability apply
 * service so the port can pass-through directly.
 */
export type CodexCapabilityApplyResult =
  | { status: "applied" }
  | { status: "rejected"; error: string };

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

export type ConversationBackendEvent =
  | { type: "backend_init"; backendRef: AgentSessionRef }
  | { type: "content"; block: MessageContentBlock }
  | { type: "provider_event"; payload: unknown }
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
  structuredOutput?: unknown;
  aborted: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
  error: string | null;
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
  readonly capabilities: ConversationBackendCapabilities;
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
  /**
   * Live-apply a Claude capability configuration (skills/plugins/agents
   * deltas) to the active runtime. Implemented by the Claude runtime to
   * support idle-drain and after-mutation fanout from the capability apply
   * service. Returns `skipped-turn-active` when a turn is in flight so the
   * caller stages the change for idle-drain rather than interrupting.
   */
  applyClaudeCapabilityConfig?(
    config: ClaudeRuntimeCapabilityConfig,
  ): Promise<ClaudeCapabilityApplyResult>;
  /**
   * Replace the live Codex capability configuration the runtime will merge
   * into the next turn's `CodexOptions.config`. Implemented by the Codex
   * runtime so the capability apply service can promote `staged-next-turn`
   * cascades into the running runtime before the upcoming turn ingests
   * options. Returns `rejected` when the runtime is closed.
   */
  applyCodexCapabilityConfig?(
    config: CodexRuntimeCapabilityConfig,
  ): Promise<CodexCapabilityApplyResult>;
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
   * Conversation ID used to scope the session MCP server (and any
   * conversation-bound MCP tools registered on it). Defaults to
   * `conversationId` when omitted. Collaboration lanes set this to the
   * originating conversation so the synthetic per-lane SDK session ID
   * doesn't have to exist in CC session state.
   */
  mcpScopeConversationId?: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
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
   * Optional callback invoked by the backend runtime when SDK messages arrive
   * between caller-initiated turns — e.g. Claude Code's background-task
   * auto-continuation. Emits `external_turn_started`, `provider_event`s, and
   * `external_turn_completed` for each virtual turn.
   */
  onExternalTurnEvent?: (event: ConversationBackendEvent) => void;
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
