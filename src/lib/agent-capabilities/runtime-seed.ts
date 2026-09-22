import { computeCascadeRuntimeHash } from "./runtime-hashes";
import { encodeCascadeKind } from "./schemas";
import { applyTimingForCascade } from "./metadata";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentCapabilityViewResponse,
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "./schemas";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import type { ComposeConversationStartResult } from "./runtime-composer";
import type { ConversationStartCapabilityComposerInput } from "./default-deps";

/** @public Referenced via `import("...").ComposedCapabilitySeed` in actor-implementations. */
export interface ComposedCapabilitySeed {
  /**
   * Backend-neutral resolved cascade the actor seeds onto the backend factory
   * via `tooling.capabilities`; the factory translates it into its provider
   * payload internally at `createRuntime`.
   */
  capabilities: ResolvedCapabilityCascade;
  diagnostics?: readonly AgentCapabilityDiagnostic[];
  /**
   * Initial intent stays pending until the backend acknowledges delivery.
   * Persisting this baseline lets later saves and acceptance receipts retain
   * independent state for each capability kind.
   */
  runtimeState: AgentCapabilityRuntimeApplicationState;
}

export interface ComposedProjectConversationDiagnosticsSeed {
  kind: "diagnostics-only";
  backend: AgentBackendId;
  diagnostics: readonly AgentCapabilityDiagnostic[];
}

export type ComposedProjectConversationCapabilitySeed =
  | ({
      kind?: "runtime";
      backend: AgentBackendId;
    } & ComposedCapabilitySeed)
  | ComposedProjectConversationDiagnosticsSeed;

export function projectConversationDiagnosticsSeed(
  backend: AgentBackendId,
  result: ComposeConversationStartResult,
): ComposedProjectConversationDiagnosticsSeed | undefined {
  if (result.diagnostics.length === 0) return undefined;
  return {
    kind: "diagnostics-only",
    backend,
    diagnostics: result.diagnostics,
  };
}

/**
 * Compose the neutral capability cascade + initial apply state for a new
 * conversation. The actor seeds `tooling.capabilities` on the backend factory
 * with the returned cascade and writes `runtimeState` to
 * `conversation.agentCapabilitiesRuntime` so the apply service can promote /
 * compare against this baseline on subsequent mutations. The factory form
 * exists so tests can run the same seed projection over a composer built
 * with injected deps instead of the module-level store wiring.
 */
export function createCapabilityConfigComposer(
  composeForConversation: (
    input: ConversationStartCapabilityComposerInput,
  ) => Promise<ComposeConversationStartResult>,
): (
  input: ConversationStartCapabilityComposerInput,
) => Promise<ComposedCapabilitySeed | undefined> {
  return async function composeCapabilityConfig(input) {
    const result = await composeForConversation(input);
    if (result.capabilities.kinds.length === 0) return undefined;
    return {
      capabilities: result.capabilities,
      diagnostics: result.diagnostics,
      runtimeState: result.runtimeState,
    };
  };
}

export function reconcileDeliveredCapabilityState(
  seed: AgentCapabilityRuntimeApplicationState,
  delivered: ResolvedCapabilityCascade | undefined,
): AgentCapabilityRuntimeApplicationState {
  if (!delivered) return seed;
  const result = { cascades: { ...seed.cascades } };
  for (const kind of delivered.kinds) {
    const cascadeKind = encodeCascadeKind({
      backend: delivered.backend,
      kind: kind.kind,
    });
    const appliedHash = computeCascadeRuntimeHash({
      cascadeKind,
      rows: kind.items.filter((item) => item.originLayer !== "native"),
    });
    const desired = seed.cascades[cascadeKind];
    const pendingHash = desired?.pendingHash ?? desired?.appliedHash;
    result.cascades[cascadeKind] =
      pendingHash && pendingHash !== appliedHash
        ? {
            ...desired,
            appliedHash,
            pendingHash,
            lastApplyStatus:
              applyTimingForCascade(cascadeKind) === "next_conversation"
                ? "deferred-next-conversation"
                : "staged-next-turn",
          }
        : { appliedHash, lastApplyStatus: "applied" };
  }
  return result;
}

export function applyDeliveredCapabilityView(
  view: AgentCapabilityViewResponse,
  delivered: ResolvedCapabilityCascade | undefined,
): AgentCapabilityViewResponse {
  if (!delivered || delivered.backend !== view.backend) return view;
  const kind = delivered.kinds.find(
    (k) =>
      encodeCascadeKind({ backend: delivered.backend, kind: k.kind }) ===
      view.cascadeKind,
  );
  if (!kind) return view;
  const deliveredItems = new Map(
    kind.items.map((item) => [item.itemId, item.enabled]),
  );
  return {
    ...view,
    items: view.items.map((item) => ({
      ...item,
      appliedEnabled: deliveredItems.get(item.itemId),
    })),
  };
}
