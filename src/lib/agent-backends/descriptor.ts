import type {
  AgentCapabilityControlSupport,
  BackendCapabilityCatalogFacet,
} from "./capability-catalog";
import { z } from "zod";
import type {
  ConversationExecutionPolicy,
  TaskExecutionPolicy,
} from "./execution-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationBackendFactory } from "./conversation";
import type { BackendContinuityAdapter } from "./continuity";
import type {
  BackendRuntimeConfigAdapter,
  ResolvedCapabilityCascade,
} from "./runtime-config";
import type { CommandItem } from "@/lib/commands/schemas";
import type { AgentTaskRunner } from "./task";
import type { AgentFailureClassifier } from "./errors";
import type { McpBackendCapabilities } from "@/lib/agent-backends/mcp-capabilities";
import type {
  CaptureAvailability,
  BackendModelCatalog,
  BackendModelSelection,
  EffortLevel,
} from "./schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { BackendNativeMemory } from "./native-memory";

export const queueDeliveryTimingSchema = z.enum(["in_turn", "next_turn"]);
export type QueueDeliveryTiming = z.infer<typeof queueDeliveryTimingSchema>;

export interface QueueCapability {
  acceptsWhileRunning: boolean;
  deliveryTiming: QueueDeliveryTiming;
}

export const capabilityKindSchema = z.enum(["skills", "plugins", "agents"]);
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

/**
 * When a runtime-capability config change for a kind reaches the live agent:
 * "idle_live" is retained for historical timing records;
 * "next_turn" = staged until turn preparation or input acceptance;
 * "next_conversation" = binding fixed at conversation creation.
 * Timing is declared per capability kind because one runtime may accept
 * new MCP configuration while retaining its original skill selection.
 */
export const capabilityApplyTimingSchema = z.enum([
  "idle_live",
  "next_turn",
  "next_conversation",
]);
export type CapabilityApplyTiming = z.infer<typeof capabilityApplyTimingSchema>;

export interface BackendCapabilityKindSupport {
  kind: CapabilityKind;
  applyTiming: CapabilityApplyTiming;
  catalog?: {
    discoverySupport: "available" | "unavailable-pending-verification";
    runtimeVisibility: "sdk-runtime" | "source-only" | "unsupported";
    compositionSupport:
      | "native"
      | "translator"
      | "verification-gated"
      | "diagnostic-only";
    support?: AgentCapabilityControlSupport;
  };
}

export const managedSkillsDeliverySchema = z.enum(["bundled", "hermetic"]);
export type ManagedSkillsDelivery = z.infer<typeof managedSkillsDeliverySchema>;

/**
 * How the backend delivers Command Center's managed skill bundle (the CC
 * plugin's skills, published at startup — see `src/lib/managed-skills/`).
 * Required on every descriptor so a new backend cannot register without
 * deciding: "bundled" means the adapter attaches the published bundle to
 * every normal launch; "hermetic" is an explicit declaration that the
 * execution profile deliberately receives no managed skills. Managed skills
 * are host environment, independent of the user capability cascade.
 */
export interface AgentBackendManagedSkills {
  conversations: ManagedSkillsDelivery;
  /**
   * Standard task runs. Isolated one-shot task profiles are hermetic by
   * contract regardless of this value.
   */
  tasks: ManagedSkillsDelivery;
  /**
   * Materialize adapter-owned discovery state in a checkout before it is
   * exposed to agent launch and command discovery. Backends whose native
   * transport attaches managed skills do not need this hook.
   */
  prepareCheckout?(checkoutPath: string): Promise<void>;
}

export const continuationStrengthSchema = z.enum([
  "precise_session",
  "synthetic_thread",
  "none",
]);
export type ContinuationStrength = z.infer<typeof continuationStrengthSchema>;

export const forkSupportSchema = z.enum(["native", "synthetic", "unsupported"]);
export type ForkSupport = z.infer<typeof forkSupportSchema>;

export const structuredOutputSupportSchema = z.enum([
  "backend_native",
  "post_validation",
  "unsupported",
]);
export type StructuredOutputSupport = z.infer<
  typeof structuredOutputSupportSchema
>;

export interface BackendConversationCapabilities {
  queue: QueueCapability;
  continuationStrength: ContinuationStrength;
  fork: ForkSupport;
  structuredOutput: StructuredOutputSupport;
  contextWindowMetrics: boolean;
  nativeMidTurnAskUser: boolean;
  externalTurns: boolean;
  /**
   * Whether Command Center may retire this backend's runtime through a manual
   * CC checkpoint and continue the same CC conversation in a fresh provider
   * session seeded from the frozen checkpoint. A claim about the ADAPTER's
   * proven continuation behaviour, not the provider's: it stays `false` until
   * the backend-continuation probes hold real evidence for the adapter, and
   * consumers read it here rather than branching on backend identity.
   */
  checkpoint: boolean;
  checkpointFork: boolean;
  handoffCapture: CaptureAvailability;
  capabilityKinds: readonly BackendCapabilityKindSupport[];
}

export interface BackendTranscriptEntry {
  timestamp: string;
  type: string;
  raw?: unknown;
}

export interface BackendTurnResultProjectionInput {
  timestamp: string;
  backendRef: AgentSessionRef | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  /** Per-turn attributed cost (consumers sum these). */
  costUsd: number | null;
  /**
   * Lineage-cumulative cost as of this turn, for backends whose provider
   * counters are cumulative; null for the rest. Persisted frames prefer this
   * so transcripts stay lossless w.r.t. the provider's own accounting.
   */
  cumulativeCostUsd: number | null;
  aborted: boolean;
  error: string | null;
}

/**
 * Projects normalized conversation events into Command Center's transcript
 * compatibility records. Provider-native transcript interpretation remains
 * in runtime adapters; this seam owns only the legacy records CC adds around
 * a turn.
 */
export interface BackendConversationTranscriptProjection {
  persistContentEvents: boolean;
  projectBackendInit(input: {
    timestamp: string;
    backendRef: AgentSessionRef;
  }): BackendTranscriptEntry | null;
  projectTurnResult(
    input: BackendTurnResultProjectionInput,
  ): BackendTranscriptEntry | null;
}

/** Projects a task continuation ref into optional assistant-row metadata. */
export interface BackendTaskTranscriptProjection {
  projectAssistantMetadata(backendRef: AgentSessionRef | null): unknown;
}

export interface BackendModelInfo {
  id: string;
  label: string;
  description: string;
  /** Empty = effort not applicable to this model. */
  effortLevels: readonly EffortLevel[];
}

/**
 * Supplies the complete valid model variants available at the current project
 * boundary. Static and discovered providers share this one neutral contract.
 */
export interface BackendModelCatalogFacet {
  getCatalog(input: {
    projectPath?: string;
    configuredSelection?: BackendModelSelection;
  }): Promise<BackendModelCatalog>;
}

/** Supplies commands from the provider's authoritative skill catalog. */
export interface BackendSkillCatalogFacet {
  getCommands(input: {
    worktreePath: string;
    capabilities?: ResolvedCapabilityCascade;
  }): Promise<CommandItem[]>;
}

export const skillTriggerPrefixSchema = z.enum(["/", "$"]);
export type SkillTriggerPrefix = z.infer<typeof skillTriggerPrefixSchema>;

export interface AgentBackendMetadata {
  label: string;
  executionWarnings?: readonly string[];
  /** Design-system tone name driving UI chip/accent color (e.g. "cyan"). */
  toneToken: string;
  skillTriggerPrefix: SkillTriggerPrefix;
  models: readonly BackendModelInfo[];
  defaultModelId: string;
  defaultTimeoutMs: number | null;
  /**
   * Default per-turn inactivity bound: a turn producing no backend events for
   * this long is presumed hung and aborted (see stall-watchdog.ts). Null or
   * absent disables the bound for backends whose turns have legitimate long
   * silences (e.g. Claude background-task waits) or another safety net.
   */
  defaultStallTimeoutMs?: number | null;
}

export interface AgentBackendConversationFacet {
  execution: ConversationExecutionPolicy;
  factory: ConversationBackendFactory;
  /** Session/thread lifecycle (start/validate/resumeOrRecover/fork). */
  continuity: BackendContinuityAdapter;
  capabilities: BackendConversationCapabilities;
  /**
   * How this backend's conversation runtime applies a delivered `fsWritePolicy`.
   * Declared separately from the task facet because graph-workflow
   * implementers dispatch conversation turns.
   */
  fsWriteRestriction: FsWriteRestrictionSupport;
  /** Neutral capability-cascade apply seam; translation happens inside. */
  runtimeConfig: BackendRuntimeConfigAdapter;
  transcript: BackendConversationTranscriptProjection;
}

/**
 * How the backend applies the request's filesystem write policy.
 *
 * "enforced" is a claim about the ADAPTER, not the provider: it means this
 * backend's task runner translates the policy onto a native mechanism the agent
 * cannot talk its way out of. "instruction-only" delivers the policy as agent
 * instructions without enforcement. "unsupported" cannot deliver the policy.
 */
export const fsWriteRestrictionSupportSchema = z.enum([
  "enforced",
  "instruction-only",
  "unsupported",
]);
export type FsWriteRestrictionSupport = z.infer<
  typeof fsWriteRestrictionSupportSchema
>;

export interface AgentBackendTaskFacet {
  execution: TaskExecutionPolicy;
  runner: AgentTaskRunner;
  structuredOutput: StructuredOutputSupport;
  transcript: BackendTaskTranscriptProjection;
  fsWriteRestriction: FsWriteRestrictionSupport;
}

export interface AgentBackendDescriptor {
  id: AgentBackendId;
  metadata: AgentBackendMetadata;
  modelCatalog: BackendModelCatalogFacet;
  skillCatalog?: BackendSkillCatalogFacet;
  capabilityCatalog?: BackendCapabilityCatalogFacet;
  conversation?: AgentBackendConversationFacet;
  tasks?: AgentBackendTaskFacet;
  managedSkills: AgentBackendManagedSkills;
  /**
   * What Command Center does about the provider's own memory system. Required
   * so a backend cannot register while quietly running a second memory beside
   * the Command Center library; see `./native-memory.ts`.
   */
  nativeMemory: BackendNativeMemory;
  mcp: McpBackendCapabilities;
  errors: AgentFailureClassifier;
}
