import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { BackendConversationCapabilities } from "@/lib/agent-backends/descriptor";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { InTurnQuestionScope } from "@/lib/conversations/in-turn-questions";
import type { InTurnQuestionReply } from "@/lib/conversations/in-turn-question-schemas";
import type { ConversationApplyResult } from "@/lib/mcp/runtime-apply";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { CheckpointDeliveryDependencies } from "@/lib/conversation-checkpoints/checkpoint-seed";
import type {
  CapabilitySeed,
  ProjectCapabilitySeed,
} from "@/lib/conversation-core/contributions/capability-cascade";
import type {
  ConversationTurnDependencies,
  TurnExecutionDependencies,
} from "@/lib/conversation-core/turn/dependencies";
import type { ConversationPolicyState } from "./policy-state";
import type { ConversationRuntimeState } from "./runtime-state";

/** What the actor's turns need beyond a core turn: its runtime hosting, locks and backend wiring. */
export interface ActorExecutionDependencies {
  requestUserQuestion(
    scope: InTurnQuestionScope,
    questions: AskQuestionItem[],
    signal: AbortSignal,
  ): Promise<InTurnQuestionReply>;

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

  backendSupportsCheckpointFork(backend: AgentBackendId): boolean;

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
    ownInputReceipt?: (finish: () => Promise<void>) => boolean,
  ): void;

  unregisterBackendRuntime(
    conversationId: string,
    expected: ConversationBackendRuntime,
  ): void;

  // Child environment and plugins (passed to backend factory)
  buildChildEnv(): NodeJS.ProcessEnv;

  resolvePluginPaths(): Promise<Array<{ name: string; path: string }>>;

  getRuntime(key: string): ConversationRuntimeState | undefined;
  /**
   * Fold a provider cost settlement that arrived outside a turn into the
   * hosted actor's totals (see the machine's `COST_SETTLED`). Absent, or
   * `applied: false`, means no actor holds the conversation in memory and the
   * settlement is written to the row directly.
   */
  applyCostSettlementToHostedActor?(
    key: string,
    costUsdDelta: number,
  ): { applied: true; totalCostUsd: number | null } | { applied: false };
}

export interface ConversationPolicyDependencies {
  state: ConversationPolicyState;

  /**
   * Compose the effective portable MCP config for the next turn, honoring the
   * four-level override cascade (global → project → session → conversation),
   * gateway protection, and orphan omission. Transient caller-supplied tooling
   * (e.g., graph workflow execution tools) is merged last.
   */
  composePortableMcpForConversation(args: {
    backend: AgentBackendId;
    projectPath: string;
    target: ConversationTarget;
    worktreePath: string;
    transientPortableMcp?: PortableMcpConfig;
  }): Promise<PortableMcpConfig>;

  applyMcpAtTurnStart(input: {
    projectPath: string;
    target: ConversationTarget;
    backend: AgentBackendId;
  }): Promise<ConversationApplyResult>;

  /**
   * Attempt pending capability delivery at the start of a turn; the runtime
   * reports when its backend has accepted the submitted configuration.
   */
  applyCapabilityAtTurnStart(
    input: ApplyConversationIdentity,
  ): Promise<unknown>;

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

/** The turn dependencies plus what only the actor uses: its execution extras, MCP/capability policy and checkpoint delivery. */
export interface ConversationActorDependencies extends Omit<
  ConversationTurnDependencies,
  "execution" | "policy"
> {
  execution: TurnExecutionDependencies & ActorExecutionDependencies;
  policy: ConversationPolicyDependencies;
  /**
   * The checkpoint repository, for the one turn that delivers a ready
   * checkpoint: it binds the attempt, reads the frozen payload and records
   * acceptance. Every other turn never touches it.
   */
  checkpoint: CheckpointDeliveryDependencies;
}
