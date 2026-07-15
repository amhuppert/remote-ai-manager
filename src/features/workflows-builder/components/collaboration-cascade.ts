import { mergeCollaborationOverWithDefaults } from "@/lib/workflow-graph/resolve-config";
import type {
  WorkflowCollaborationConfig,
  WorkflowCollaborationConfigOverride,
} from "@/lib/workflow-graph/collaboration-schemas";
import type { InspectorConfigBlockSource } from "./InspectorConfigBlock";

// Whole-block collaboration cascade resolution for the workflow-builder
// inspector. Unlike the per-field provenance resolver used at execution time
// (`resolveCollaborationConfigWithProvenance`), the inspector overrides a
// whole block at a time, so the block-level `source` is decided by which layer
// supplied an override object — while the displayed `value` still field-merges
// any (possibly partial, hand-authored) override over the lower layers.

export function resolveContextCollaboration(
  contextCollaboration: WorkflowCollaborationConfigOverride | undefined,
  workflowCollaboration: WorkflowCollaborationConfigOverride | undefined,
  globalCollaboration: WorkflowCollaborationConfig,
): { value: WorkflowCollaborationConfig; source: InspectorConfigBlockSource } {
  const afterWorkflow = mergeCollaborationOverWithDefaults(
    workflowCollaboration,
    globalCollaboration,
  );
  const value = mergeCollaborationOverWithDefaults(
    contextCollaboration,
    afterWorkflow,
  );

  if (contextCollaboration !== undefined) {
    return { value, source: "context-override" };
  }
  if (workflowCollaboration !== undefined) {
    return { value, source: "workflow" };
  }
  return { value, source: "global" };
}

export function resolveWorkflowCollaboration(
  workflowCollaboration: WorkflowCollaborationConfigOverride | undefined,
  globalCollaboration: WorkflowCollaborationConfig,
): {
  value: WorkflowCollaborationConfig;
  source: "global" | "context-override";
} {
  const value = mergeCollaborationOverWithDefaults(
    workflowCollaboration,
    globalCollaboration,
  );
  return {
    value,
    source: workflowCollaboration !== undefined ? "context-override" : "global",
  };
}
