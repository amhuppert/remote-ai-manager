import type {
  NativeSddWorkflowManagementCompact,
  NativeSddWorkflowManagementDetail,
} from "@/lib/workflows/managed-definition-contract";

export {
  nativeSddWorkflowManagementCompactSchema,
  nativeSddWorkflowManagementDetailSchema,
  type NativeSddWorkflowManagementCompact,
  type NativeSddWorkflowManagementDetail,
} from "@/lib/workflows/managed-definition-contract";

export interface ManagedWorkflowDefinitionPolicy {
  list(
    projectPath: string,
    workflowIds: readonly string[],
  ): Promise<ReadonlyMap<string, NativeSddWorkflowManagementCompact>>;
  get(
    projectPath: string,
    workflowId: string,
  ): Promise<NativeSddWorkflowManagementDetail | null>;
  /**
   * How many findings refuse propose for the live draft this definition is the
   * working copy of, read through the one draft-health projection `spec plan
   * status` prints. Null when the definition is not a current draft or the
   * projection cannot be read; a receipt then reports no gate rather than a
   * count it did not measure.
   */
  proposeBlockingCount(
    projectPath: string,
    workflowId: string,
  ): Promise<number | null>;
}

export function managedWorkflowReadOnlyInstruction(
  management: NativeSddWorkflowManagementCompact,
): string {
  if (management.lifecycle === "launched" && management.executionHref) {
    return "Open the execution to inspect the launched candidate.";
  }
  if (
    management.lifecycle === "in_review" ||
    management.lifecycle === "approved"
  ) {
    return "Reopen the delivery plan before editing its workflow definition.";
  }
  return "Open the spec to inspect this delivery candidate.";
}

/**
 * The reason the read-only refusal states. A proposed, signed or launched
 * candidate is the exact bytes a sign-off approved (or will approve), so the
 * guard is the design's freeze rather than a missing capability; a superseded
 * or abandoned definition is retained history and its instruction already says
 * where to look, so it carries no rationale.
 */
export function managedWorkflowReadOnlyRationale(
  management: NativeSddWorkflowManagementCompact,
): string | null {
  switch (management.lifecycle) {
    case "in_review":
    case "approved":
    case "launched":
      return "the signed candidate is immutable so sign-off approves exact bytes";
    case "draft":
    case "superseded":
    case "abandoned":
      return null;
  }
}
