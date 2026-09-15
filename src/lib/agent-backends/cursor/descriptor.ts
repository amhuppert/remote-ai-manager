import { CURSOR_BACKGROUND_WARNING } from "./background-tasks";
import type {
  ConversationExecutionPolicy,
  TaskExecutionPolicy,
} from "../execution-admission";
import type {
  AgentBackendDescriptor,
  AgentBackendMetadata,
  BackendModelCatalogFacet,
  BackendConversationCapabilities,
  BackendConversationTranscriptProjection,
} from "../descriptor";
import type { ConversationBackendFactory } from "../conversation";
import type { BackendContinuityAdapter } from "../continuity";
import type { BackendRuntimeConfigAdapter } from "../runtime-config";
import type { AgentFailureClassifier } from "../errors";
import type { AgentTaskRunner } from "../task";
import type { McpBackendCapabilities } from "@/lib/mcp/backend-capabilities";
import {
  listNativeMemoryExceptions,
  type BackendNativeMemory,
} from "../native-memory";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { CURSOR_DEFAULT_MODEL } from "./model-policy";
import { CURSOR_TURN_STALL_TIMEOUT_MS } from "./worker/bounds";

/**
 * The registered Cursor descriptor (spec D4, R2.2).
 *
 * Everything neutral Command Center knows about Cursor is here, and every
 * declaration is bounded by evidence the Phase 1 adapter actually produced.
 * The negative claims are the load-bearing ones: consumers gate on them
 * instead of branching on backend identity, so an over-claim would not fail
 * loudly — it would quietly let a surface act on a capability that does not
 * exist.
 */

export const cursorConversationExecution: ConversationExecutionPolicy = {
  classes: ["ordinary-conversation", "governed-execution"],
  instructionDelivery: "user-message",
};

export const cursorTaskExecution: TaskExecutionPolicy = {
  classes: ["nongoverned-task", "governed-execution"],
  profiles: ["standard", "isolated-one-shot"],
  instructionDelivery: "user-message",
};

/**
 * Cursor is the honest exception: nothing in the SDK turns its memories off.
 * `AgentOptions` carries no memory field, and the only memory switch reachable
 * anywhere in the package (`memoryDefaultEnabled`) is a field of the
 * server-delivered feature config the client receives — an embedder cannot set
 * it. `settingSources: []`, which the Phase 1 worker already passes, suppresses
 * the ambient RULES layers; it is not a memory lever and is not claimed as one.
 *
 * This is a `none` declaration rather than an omission precisely so the two
 * disclosure surfaces can say it out loud. Revisit when the SDK grows a lever.
 */
export const cursorNativeMemory: BackendNativeMemory = {
  mechanism: "none",
  reason:
    "Cursor native memory cannot be disabled or verified through the SDK. CC shared-memory policy is instruction-only; native memory may remain active.",
};

/**
 * Backend catalog metadata for Cursor.
 *
 * The tone token is Cursor's identity accent in the UI, distinct from Claude's
 * cyan and Codex's violet. `amber` is the remaining design-system accent the
 * existing chip/toggle tone maps already resolve; a genuinely new colour would
 * need its own token set, which is a design-system change rather than a
 * registration one.
 */
export const cursorBackendMetadata: AgentBackendMetadata = {
  label: "Cursor",
  executionWarnings: [
    ...listNativeMemoryExceptions([
      {
        id: CURSOR_BACKEND_ID,
        label: "Cursor",
        nativeMemory: cursorNativeMemory,
      },
    ]).map(({ reason }) => reason),
    CURSOR_BACKGROUND_WARNING,
    "Network and native tool-approval limits are not enforced.",
  ],
  toneToken: "amber",
  skillTriggerPrefix: "/",
  models: [
    {
      id: CURSOR_DEFAULT_MODEL,
      label: "Composer 2.5",
      description: "Cursor's agent model",
      // Composer takes no reasoning-effort parameter, and an empty list is the
      // catalog's way of saying effort does not apply (see BackendModelInfo).
      effortLevels: [],
    },
  ],
  defaultModelId: CURSOR_DEFAULT_MODEL,
  defaultTimeoutMs: null,
  defaultStallTimeoutMs: CURSOR_TURN_STALL_TIMEOUT_MS,
};

/**
 * Cursor conversation capabilities.
 *
 * - `queue`: Command Center durably accepts follow-ups while running and
 *   dispatches them on the next turn; interrupted deliveries require review.
 * - `continuationStrength: "precise_session"`: a Cursor agent id is a real,
 *   probeable handle the SDK issues at create — resume returns to that exact
 *   session rather than replaying a reconstructed thread.
 * - `fork: "synthetic"`: bounded transcript text seeds an independent agent
 *   and store; provider checkpoints and hidden state are not inherited.
 * - `structuredOutput: "post_validation"`: the shared contract is rendered into
 *   the prompt and validated afterwards; no native schema is forwarded.
 * - `contextWindowMetrics`, `nativeMidTurnAskUser`, `externalTurns`: the SDK
 *   surfaces no context-window figures, its interactive tools are denied by the
 *   Phase 1 policy, and it produces no turns Command Center did not start.
 * - Capability selection is fixed at conversation creation. CC supplies skill
 *   metadata and explicit agent definitions while ambient settings stay off.
 */
export const cursorConversationCapabilities: BackendConversationCapabilities = {
  queue: { acceptsWhileRunning: true, deliveryTiming: "next_turn" },
  continuationStrength: "precise_session",
  fork: "synthetic",
  structuredOutput: "post_validation",
  contextWindowMetrics: false,
  nativeMidTurnAskUser: false,
  externalTurns: false,
  // Disabled until backend-continuation-probes holds real continuation evidence.
  checkpoint: false,
  checkpointFork: false,
  capabilityKinds: [
    { kind: "skills", applyTiming: "next_conversation" },
    { kind: "plugins", applyTiming: "next_conversation" },
    { kind: "agents", applyTiming: "next_conversation" },
  ],
};

/**
 * Cursor adds no Command Center-authored frames around a turn.
 *
 * Its runtime persists every complete native SDK object as a lossless envelope
 * (D7), and those envelopes are already full transcript frames: content-worthy
 * events carry their visible blocks, and the usage event carries the turn's
 * token counts. Persisting the projected `content` events again would duplicate
 * every assistant block, and a CC-authored result frame would be a second,
 * competing usage record for a turn that already has exactly one (D17).
 */
export const cursorConversationTranscriptProjection: BackendConversationTranscriptProjection =
  {
    persistContentEvents: false,
    projectBackendInit: () => null,
    projectTurnResult: () => null,
  };

/**
 * Cursor delivers filesystem limits as instructions. Its worker runs without
 * mechanical filesystem confinement. Literals keep capability disclosure
 * available to client consumers without importing the server-only factory.
 */
export const cursorConversationFsWriteRestriction = "instruction-only" as const;
export const cursorTaskFsWriteRestriction = "instruction-only" as const;

export interface CursorDescriptorDeps {
  taskRunner: AgentTaskRunner;
  conversationFactory: ConversationBackendFactory;
  modelCatalog: BackendModelCatalogFacet;
  /** `createCursorContinuityAdapter(...)` in production; injected so the
   *  conformance suite can drive it against a scripted worker transport. */
  continuity: BackendContinuityAdapter;
  runtimeConfig: BackendRuntimeConfigAdapter;
  /** `cursorMcpCapabilities` in production; injected because the MCP registry
   *  module is server-only while this module's literals are client-imported. */
  mcp: McpBackendCapabilities;
  failureClassifier: AgentFailureClassifier;
}

export function createCursorBackendDescriptor(
  deps: CursorDescriptorDeps,
): AgentBackendDescriptor {
  return {
    id: CURSOR_BACKEND_ID,
    metadata: cursorBackendMetadata,
    modelCatalog: deps.modelCatalog,
    conversation: {
      execution: cursorConversationExecution,
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: cursorConversationCapabilities,
      fsWriteRestriction: cursorConversationFsWriteRestriction,
      runtimeConfig: deps.runtimeConfig,
      transcript: cursorConversationTranscriptProjection,
    },
    tasks: {
      runner: deps.taskRunner,
      execution: cursorTaskExecution,
      structuredOutput: "post_validation",
      fsWriteRestriction: cursorTaskFsWriteRestriction,
      transcript: {
        projectAssistantMetadata: (backendRef) =>
          backendRef ? { backendRef } : undefined,
      },
    },
    managedSkills: { conversations: "bundled", tasks: "bundled" },
    nativeMemory: cursorNativeMemory,
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
