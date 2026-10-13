import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type {
  ConversationBackendFactory,
  ProjectModelSelectionValidation,
} from "@/lib/agent-backends/conversation";
import type { ApplyServiceDeps } from "@/lib/agent-capabilities/apply";
import type { ConversationStartCapabilityComposerInput } from "@/lib/agent-capabilities/default-deps";
import type { ComposeConversationStartResult } from "@/lib/agent-capabilities/runtime-composer";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AlignmentInjection } from "@/lib/session-alignment/render";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { Logger } from "@/lib/logging";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type {
  MemoryIndexContextRequest,
  PreparedMemoryIndexDelivery,
} from "@/lib/memory/index-live-context";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { AgentCallFacadeDeps } from "@/lib/workflows/primitives/agent-call-facade";
import type { NotepadInjectionSource } from "@/lib/notepads/injection";
import type { ActorConfig } from "@/lib/conversation-core/contributions/resolve-model-effort";
import type { ProjectCapabilitySeed } from "@/lib/conversation-core/contributions/capability-cascade";
import type { ConversationDurableEffects } from "./effects";

export interface TurnExecutionDependencies {
  // Config & project
  readConfig(): Promise<ActorConfig>;

  getProjectDisplayName(projectPath: string): string;

  getConversationBackendFactory(
    backend: AgentBackendId,
  ): ConversationBackendFactory;

  admitConfiguredModelSelection(input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection: BackendModelSelection;
    config?: ActorConfig;
  }): Promise<ProjectModelSelectionValidation>;

  /** The one-shot `cctl agent run` hint, for a conversation that cannot own a run. */
  getCodexToolPromptHint(): string;

  /** The `cctl run launch` hint, for a conversation that may own a run. */
  getRunToolPromptHint(): string;

  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;

  getSessionState(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;

  fileExists(filePath: string): boolean;

  // Lifecycle registries

  /**
   * Execute a single conversation/task turn through the shared AgentCall
   * primitive. Production wires this to the real `executeAgentCall` facade;
   * tests inject a spy. Routing through this dep guarantees the conversation
   * turn never bypasses the primitive layer.
   */
  executeAgentCall(
    request: AgentCallRequest,
    facadeDeps: AgentCallFacadeDeps,
  ): Promise<AgentCallResult>;

  /**
   * Resolve the registered `AgentTaskRunner` for a backend. Wired to the
   * agent-backends registry in production; tests inject a stub runner.
   */
  getTaskRunner(backend: AgentBackendId): AgentTaskRunner;
}

export interface TranscriptDependencies {
  getTranscriptPath(conversationId: string): Promise<string>;

  /** The latest total the transcript records for a cost lineage, or null (a task that resumed a session is charged against it). */
  readLineageCumulativeCost?(
    conversationId: string,
    lineageId: string,
  ): Promise<number | null>;

  /** Durable queue handoff: deduplicate by message id and propagate disk errors. */
  appendTranscriptEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
    meta?: TranscriptBroadcastMeta,
  ): Promise<void>;

  // `meta` is forwarded to `appendTranscriptEntry` so callers that know the
  // project + session identity (the turn engines and the external-turn
  // handler) can trigger the `message-appended` SSE broadcast.
  safeAppendTranscriptEntry(
    conversationId: string,
    entry: TranscriptEntry,
    meta?: TranscriptBroadcastMeta,
  ): Promise<void>;

  /**
   * Append an entry whose producer stamped a stable id, at most once. Backend
   * streams can re-deliver an event (a resumed stream, a retried forward), and
   * this seam makes persistence and the SSE broadcast agree on exactly-once
   * without the caller comparing content.
   */
  safeAppendTranscriptEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
    meta?: TranscriptBroadcastMeta,
  ): Promise<void>;

  saveTranscriptImage(
    conversationId: string,
    index: number,
    mediaType: string,
    base64Data: string,
  ): Promise<string>;

  getNextImageIndex(conversationId: string): Promise<number>;

  // Transcript reading (for synthetic fork seed and last-used model/effort
  // resolution). Returns the full TranscriptMessage so per-turn model/effort
  // metadata is available, not just role/content.
  readConversationMessages(
    transcriptPath: string | null,
  ): Promise<TranscriptMessage[]>;
}

export interface TurnContextDependencies {
  /** Governing role instructions resolved from the durable graph lane, if any. */
  getWorkflowLaneInstructions(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<string | null>;

  // Active-charter governing injection for the per-turn prompt seam (R7).
  // Returns null when the session has no active charter. Gated by the turn to
  // attended normal sessions only (R12.1) before being called.
  getActiveAlignmentInjection(
    projectPath: string,
    sessionName: string,
  ): Promise<AlignmentInjection | null>;

  // Cheap active-version-number accessor for the per-turn recreate gate (R7.3).
  // Read only when reusing a live runtime; null when the session has no active
  // charter. Gated by the turn to attended normal sessions before being called.
  getActiveAlignmentVersion(
    projectPath: string,
    sessionName: string,
  ): Promise<number | null>;

  // Current <active-ticket> block for the session's linked ticket, rebuilt on
  // every turn (ticket-system 5.4/5.5); null when the session is unlinked.
  // Prepended to the transient effective prompt only — never baked into
  // session instructions, which persistent runtimes freeze at creation.
  getLiveTicketBlock(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;

  // Current <memory-index> block for the conversation (spec `memory` R5/R6),
  // rebuilt from live rows on every turn for session AND project conversations;
  // null when the conversation's read policy is off or there is nothing to
  // deliver. Transient like the ticket block: never baked into session
  // instructions, so a note captured anywhere is in the next turn everywhere.
  getMemoryIndexBlock(
    request: MemoryIndexContextRequest,
  ): Promise<PreparedMemoryIndexDelivery | null>;

  // Reads one notepad for the agent-facing expansion pass (D5). Null means the
  // notepad is gone, so the pass reports a dangling reference instead of
  // failing delivery. Ids are global, so no project scope is threaded.
  readLiveReference(
    target: import("@/lib/live-references/schemas").LiveReferenceTarget,
  ): Promise<
    import("@/lib/live-references/schemas").LiveReferenceSummary | null
  >;

  readNotepadForInjection(
    notepadId: string,
  ): Promise<NotepadInjectionSource | null>;

  getReferenceDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<Array<{ filePath: string; description: string }>>;
}

/**
 * The raw composers a conversation's MCP and capability configuration is built
 * from; each engine builds its own policy from them.
 */
export interface ConversationPolicyInfrastructure {
  /**
   * Compose the effective portable MCP config for the next turn, honoring the
   * four-level override cascade (global → project → session → conversation),
   * gateway protection, and orphan omission. Transient caller-supplied tooling
   * (e.g., graph workflow execution tools) is merged last.
   */
  composePortableMcp(args: {
    backend: AgentBackendId;
    projectPath: string;
    target: ConversationTarget;
    worktreePath: string;
    transientPortableMcp?: PortableMcpConfig;
  }): Promise<PortableMcpConfig>;
  composeCapabilities(
    input: ConversationStartCapabilityComposerInput,
  ): Promise<ComposeConversationStartResult>;
  /**
   * Compose capability runtime config for a project conversation. Uses the
   * fixed backend persisted on the project-conversation record and omits any
   * session layer from the cascade.
   */
  composeDurableProject(input: {
    backend: AgentBackendId;
    worktreePath: string;
    projectPath: string;
    projectName: string;
    conversationId: string;
  }): Promise<ProjectCapabilitySeed | undefined>;
  applyRuntimeConfig: NonNullable<ApplyServiceDeps["applyRuntimeConfig"]>;
}

export interface DebugDependencies {
  getDebugLogUrl(conversationId: string): string;
}

/** What one conversation turn reads and writes outside itself, whichever engine runs it. */
export interface ConversationTurnDependencies {
  subscriptions?: import("@/lib/conversation-core/contributions/passive-subscription-context").PassiveSubscriptionContextDependencies;
  execution: TurnExecutionDependencies;
  transcript: TranscriptDependencies;
  effects: ConversationDurableEffects;
  context: TurnContextDependencies;
  policy: ConversationPolicyInfrastructure;
  debug: DebugDependencies;
  log: Logger;
}
