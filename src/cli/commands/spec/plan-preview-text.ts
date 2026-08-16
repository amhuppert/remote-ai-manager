import type { DeliveryPlanPreviewView } from "@/lib/specs/delivery-plan-views";
import { graphWorkflowLaunchLabel } from "@/lib/workflow-graph/launch-presentation";

/**
 * The delivery-plan attempt's rendering. It leads with the candidate hash and
 * the approvability sentence, because those are the two facts a reader is here
 * for: which bytes these are, and whether approving binds to them.
 */
export function deliveryPlanPreviewText(
  preview: DeliveryPlanPreviewView,
): string {
  const launchLabel = graphWorkflowLaunchLabel(preview.launch);
  return [
    `plan preview ${preview.specSlug} — ${preview.stage} (attempt ${preview.attemptId}, draft revision ${preview.draftRevision})`,
    `  pinned revision ${preview.pinnedRevisionId}`,
    `  candidate hash         ${preview.candidateHash ?? "not frozen"}`,
    ...(preview.snapshotId === null
      ? []
      : [`  frozen snapshot        ${preview.snapshotId}`]),
    ...(preview.candidateId === null
      ? []
      : [`  stored candidate       ${preview.candidateId}`]),
    `  approvable: ${preview.approvable ? "yes" : "no"} — ${preview.approvability}`,
    "",
    `graph launch: ${launchLabel}`,
    "",
  ].join("\n");
}
