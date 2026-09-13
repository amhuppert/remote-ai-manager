import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type {
  ConversationBackendRuntime,
  ConversationBackendFactory,
  ProjectModelSelectionValidation,
} from "@/lib/agent-backends/conversation";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";

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
import type { ConversationApplyResult } from "@/lib/mcp/runtime-apply";

import { type Logger } from "@/lib/logging";

import type { BackendConversationCapabilities } from "@/lib/agent-backends/descriptor";

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

import type { ActorConfig } from "./pre-turn/resolve-model-effort";

import { type NotepadInjectionSource } from "@/lib/notepads/injection";
import type { PreparedNotepadChangeNotice } from "@/lib/notepads/change-notices";
import type {
  CapabilitySeed,
  ProjectCapabilitySeed,
} from "./pre-turn/capability-cascade";

import type { ConversationDurableEffects } from "./effects";
import type { ConversationRuntimeState } from "./runtime-state";
import type { CheckpointDeliveryDependencies } from "./pre-turn/checkpoint-seed";

export interface TurnExecutionDependencies {
  // Resource acquisition
  acquireConversationLock(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): () => void;

  acquireQuerySlot(
    label: string,
    options?: { signal?: AbortSignal },
  ): Promise<() => void>;

  // Config & project
  readConfig(): Promise<ActorConfig>;

  getProjectDisplayName(projectPath: string): string;

  // Backend runtime lifecycle
  backendSupportsCheckpointFork(backend: AgentBackendId): boolean;
  getConversationBackendFactory(
    backend: AgentBackendId,
  ): ConversationBackendFactory;

  admitConfiguredModelSelection(input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection: BackendModelSelection;
    config?: ActorConfig;
  }): Promise<ProjectModelSelectionValidation>;

  /**
   * Declared conversation capabilities from the backend's registered
   * descriptor. Undefined when the backend has no conversation facet. The
   * actor branches on declared capabilities (e.g. `externalTurns`), never on
   * backend identity.
   */
  getConversationCapabilities(
    backend: AgentBackendId,
  ): BackendConversationCapabilities | undefined;

  registerBackendRuntime(
    conversationId: string,
    runtime: ConversationBackendRuntime,
  ): void;

  unregisterBackendRuntime(
    conversationId: string,
    expected: ConversationBackendRuntime,
  ): void;

  /**
   * Mint the signed conversation capability for a launch-eligible runtime
   * (D7 D11/D12). Null when the server provisioned no signing key, which leaves
   * the conversation unable to claim a launch origin — the correct fail-closed
   * outcome rather than a reason to block the turn.
   */
  mintConversationCapability(scope: {
    sessionName: string;
    conversationId: string;
  }): string | null;

  // Child environment and plugins (passed to backend factory)
  buildChildEnv(): NodeJS.ProcessEnv;

  resolvePluginPaths(): Promise<Array<{ name: string; path: string }>>;

  getCodexToolPromptHint(): string;

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
   * actor never bypasses the primitive layer (cf. `executePromptForMachine`).
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
  getRuntime(key: string): ConversationRuntimeState | undefined;
}

export interface TranscriptDependencies {
  getTranscriptPath(conversationId: string): Promise<string>;

  /** Durable queue handoff: deduplicate by message id and propagate disk errors. */
  appendTranscriptEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
    meta?: TranscriptBroadcastMeta,
  ): Promise<void>;

  // `meta` is forwarded to `appendTranscriptEntry` so callers that know the
  // project + session identity (the conversation turn actor and external-turn
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
  // Active-charter governing injection for the per-turn prompt seam (R7).
  // Returns null when the session has no active charter. Gated by the actor to
  // attended normal sessions only (R12.1) before being called.
  getActiveAlignmentInjection(
    projectPath: string,
    sessionName: string,
  ): Promise<AlignmentInjection | null>;

  // Cheap active-version-number accessor for the per-turn recreate gate (R7.3).
  // Read only when reusing a live runtime; null when the session has no active
  // charter. Gated by the actor to attended normal sessions before being called.
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

  // Builds the transient change notice for this turn (R21). A read: the
  // watermarks it names advance only through `settleNotepadChangeNotice`,
  // after the backend accepts the message that carried it.
  prepareNotepadChangeNotice(
    conversationId: string,
    references?: readonly import("@/lib/notepads/change-notices").NotepadDeliveryRecord[],
  ): Promise<PreparedNotepadChangeNotice>;

  getReferenceDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<Array<{ filePath: string; description: string }>>;
}

export interface ConversationPolicyDependencies {
  state: import("./policy-state").ConversationPolicyState;

  /**
   * Compose the effective portable MCP config for the next turn, honoring the
   * four-level override cascade (global → project → session → conversation),
   * gateway protection, and orphan omission. Transient caller-supplied tooling
   * (e.g., graph workflow execution tools) is merged last.
   */
  composePortableMcpForConversation(args: {
    backend: AgentBackendId;
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    transientPortableMcp?: PortableMcpConfig;
  }): Promise<PortableMcpConfig>;

  applyMcpAtTurnStart(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    backend: AgentBackendId;
  }): Promise<ConversationApplyResult>;

  /**
   * Promote any seeded `staged-next-turn` capability cascades for the
   * conversation at the start of a new turn. Live for both backends — Codex
   * rebuilds its options each turn, and Claude's seeded state from
   * conversation start needs promotion on the first turn boundary.
   */
  applyCapabilityAtTurnStart(
    input: ApplyConversationIdentity,
  ): Promise<unknown>;

  /**
   * Drain any `staged-idle` Claude capability cascades after a turn completes
   * and the conversation transitions running → idle. No-op for Codex (no
   * idle-live-apply semantics). Failures are recorded as `rejected` per
   * cascade and surfaced via diagnostics; the previously applied hash is
   * preserved so retries can proceed.
   */
  applyCapabilityWhenIdle(input: ApplyConversationIdentity): Promise<unknown>;

  /**
   * Compose the neutral capability cascade + initial apply state for a new
   * conversation runtime. The actor passes `capabilities` to the backend
   * factory's `tooling.capabilities` (the factory translates it internally)
   * and persists `runtimeState` to `conversation.agentCapabilitiesRuntime` so
   * the apply service can compare subsequent mutations against the baseline
   * the runtime was seeded with. Returns `undefined` when there are no
   * resolved cascades to seed.
   */
  composeCapabilityConfigForConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<CapabilitySeed | undefined>;

  /**
   * Compose capability runtime config for a project conversation. Uses the
   * fixed backend persisted on the project-conversation record and omits any
   * session layer from the cascade.
   */
  composeCapabilityConfigForProjectConversation(input: {
    backend: AgentBackendId;
    worktreePath: string;
    projectPath: string;
    projectName: string;
    conversationId: string;
  }): Promise<ProjectCapabilitySeed | undefined>;
}

export interface DebugDependencies {
  getDebugLogUrl(conversationId: string): string;
}

export interface ConversationActorDependencies {
  execution: TurnExecutionDependencies;
  transcript: TranscriptDependencies;
  effects: ConversationDurableEffects;
  context: TurnContextDependencies;
  policy: ConversationPolicyDependencies;
  debug: DebugDependencies;
  /**
   * The checkpoint repository, for the one turn that delivers a ready
   * checkpoint: it binds the attempt, reads the frozen payload and records
   * acceptance. Every other turn never touches it.
   */
  checkpoint: CheckpointDeliveryDependencies;
  log: Logger;
}
