import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  ResolvedCollaborationConfig,
  WorkflowConfigOverride,
} from "@/lib/workflows/schemas";
import {
  coerceGlobalDefaults,
  resolveCollaborationConfigWithProvenance,
} from "./resolve-config";

/**
 * Raw inputs the legacy provenance cascade needs when a running execution has
 * no resolved collaboration snapshotted on its working copy: the global
 * defaults plus the saved definition's workflow-level and per-context overrides.
 */
export interface LaneCollaborationFallbackInputs {
  globalDefaults: WorkflowDefaults;
  workflowConfig: WorkflowConfigOverride;
  contextDefinition: GraphWorkflowExecutionContextDefinition;
}

export interface LaneCollaborationResolverDeps {
  /**
   * Reload the saved workflow definition's raw config to feed the provenance
   * cascade. Invoked ONLY when the working copy carries no resolved
   * collaboration — i.e. legacy executions seeded before the resolved field
   * existed (doc 06, D11). Skipping this reload for post-field executions is the
   * whole point: it keeps a later saved-definition edit from leaking into a
   * running execution.
   */
  loadFallbackInputs(): Promise<LaneCollaborationFallbackInputs>;
}

/**
 * Resolve the collaboration config the lane tool context hands to the
 * implementer, preferring the execution's frozen working copy over a
 * saved-definition reload (doc 06, D11). The working copy is authoritative for
 * every execution seeded once resolved collaboration exists; the reload is a
 * shared-DB safety fallback for pre-field executions still in flight.
 */
export async function resolveLaneToolCollaborationConfig(
  resolvedContext: GraphWorkflowResolvedContext,
  deps: LaneCollaborationResolverDeps,
): Promise<ResolvedCollaborationConfig> {
  if (resolvedContext.collaboration) {
    return resolvedContext.collaboration;
  }
  const fallback = await deps.loadFallbackInputs();
  return resolveCollaborationConfigWithProvenance(
    coerceGlobalDefaults(fallback.globalDefaults),
    fallback.workflowConfig,
    fallback.contextDefinition,
  );
}
