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
import type { McpBackendCapabilities } from "@/lib/mcp/backend-capabilities";
import type { BackendNativeMemory } from "../native-memory";
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

/**
 * Backend catalog metadata for Cursor.
 *
 * `skillTriggerPrefix` is required by the canonical catalog helpers (they throw
 * for an id absent from the catalog); it is metadata, not a claim of a skill
 * surface — the tested SDK exposes none, so command discovery returns a bounded
 * empty result and Cursor conversations run without CC's bundled skills (D14).
 *
 * The tone token is Cursor's identity accent in the UI, distinct from Claude's
 * cyan and Codex's violet. `amber` is the remaining design-system accent the
 * existing chip/toggle tone maps already resolve; a genuinely new colour would
 * need its own token set, which is a design-system change rather than a
 * registration one.
 */
export const cursorBackendMetadata: AgentBackendMetadata = {
  label: "Cursor",
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
 * The conservative Phase 1 conversation capabilities.
 *
 * - `queue`: the SDK accepts no mid-turn input, so a prompt submitted during a
 *   turn starts as the NEXT turn and is not accepted while running (D16).
 * - `continuationStrength: "precise_session"`: a Cursor agent id is a real,
 *   probeable handle the SDK issues at create — resume returns to that exact
 *   session rather than replaying a reconstructed thread.
 * - `fork: "unsupported"`: no native fork exists, and aliasing resume or ref
 *   copying as one would silently share a live session (D16).
 * - `structuredOutput: "post_validation"`: the shared contract is rendered into
 *   the prompt and validated afterwards; no native schema is forwarded.
 * - `contextWindowMetrics`, `nativeMidTurnAskUser`, `externalTurns`: the SDK
 *   surfaces no context-window figures, its interactive tools are denied by the
 *   Phase 1 policy, and it produces no turns Command Center did not start.
 * - `capabilityKinds: []`: the worker attaches under `settingSources: []`, so
 *   there is no skills/plugins/agents cascade to apply.
 */
export const cursorConversationCapabilities: BackendConversationCapabilities = {
  queue: { acceptsWhileRunning: false, deliveryTiming: "next_turn" },
  continuationStrength: "precise_session",
  fork: "unsupported",
  structuredOutput: "post_validation",
  contextWindowMetrics: false,
  nativeMidTurnAskUser: false,
  externalTurns: false,
  capabilityKinds: [],
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
 * Cursor cannot mechanically confine a turn's writes to a delivered policy:
 * Phase 1 runs with `sandboxOptions.enabled` false and registers no permission
 * handler, so an allowlist could only be ASKED for (D11). Exported as a literal
 * because the capability gates that read it are client-imported while the
 * descriptor carries the server-only factory.
 */
export const cursorConversationFsWriteRestriction = "unsupported" as const;

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
    "the Cursor SDK exposes no option that disables its memories; the only memory switch in the package is server-delivered feature config an embedder cannot set",
};

export interface CursorDescriptorDeps {
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
      factory: deps.conversationFactory,
      continuity: deps.continuity,
      capabilities: cursorConversationCapabilities,
      fsWriteRestriction: cursorConversationFsWriteRestriction,
      runtimeConfig: deps.runtimeConfig,
      transcript: cursorConversationTranscriptProjection,
    },
    // No task facet: Phase 1 delivers conversations only, and `hermetic` on
    // both is the explicit declaration that neither profile receives Command
    // Center's managed skill bundle — the worker attaches with empty setting
    // sources and nothing publishes a bundle into its checkout.
    managedSkills: { conversations: "hermetic", tasks: "hermetic" },
    nativeMemory: cursorNativeMemory,
    mcp: deps.mcp,
    errors: deps.failureClassifier,
  };
}
