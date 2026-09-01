import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import {
  workflowDefinitionMutationSchema,
  type WorkflowDefinitionMutation,
} from "@/lib/workflow-graph/definition-schemas";

import {
  NATIVE_SDD_CLAIMS_SOURCE_ID,
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  pinnedSpecDocumentPath,
} from "./delivery-plan";

export interface DeliveryPlanLaunchFinalizationInput {
  readonly specId: string;
  readonly specSlug: string;
  readonly pinnedRevisionId: string;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly launch: WorkflowDefinitionMutation;
}

export type FinalizeAndAdmitDeliveryPlanLaunchInput = Omit<
  DeliveryPlanLaunchFinalizationInput,
  "candidateId"
>;

export interface FinalizeAndAdmitDeliveryPlanLaunchDeps {
  allocateCandidateId(): string;
  admitLaunch(
    launch: WorkflowDefinitionMutation,
  ): Promise<AuthoredWorkflowLaunchAdmissionResult>;
}

export function candidateClaimsDocumentPath(candidateId: string): string {
  return `.cc/graph-workflow-docs/spec-bindings/${candidateId}/claims.md`;
}

export function deliveryPlanCandidateSourceUri(input: {
  readonly specId: string;
  readonly pinnedRevisionId: string;
  readonly attemptId: string;
  readonly candidateId: string;
}): string {
  return `spec-plan://${input.specId}/revisions/${input.pinnedRevisionId}/attempts/${input.attemptId}/candidates/${input.candidateId}`;
}

export function finalizeDeliveryPlanLaunch(
  input: DeliveryPlanLaunchFinalizationInput,
): WorkflowDefinitionMutation {
  const sourceUri = deliveryPlanCandidateSourceUri(input);
  const authoredSources = input.launch.definition.charter.sourcesOfTruth.map(
    (source) => ({ ...source, rank: source.rank + 2 }),
  );

  return workflowDefinitionMutationSchema.parse({
    ...input.launch,
    definition: {
      ...input.launch.definition,
      charter: {
        ...input.launch.definition.charter,
        sourcesOfTruth: [
          {
            rank: 1,
            id: NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
            label: "Pinned native SDD specification",
            type: "spec",
            locator: pinnedSpecDocumentPath(input.specSlug),
            description:
              "The immutable specification revision this delivery candidate implements.",
            accessPolicy: "worktree-relative",
          },
          {
            rank: 2,
            id: NATIVE_SDD_CLAIMS_SOURCE_ID,
            label: "Native SDD candidate claims",
            type: "document",
            locator: candidateClaimsDocumentPath(input.candidateId),
            description:
              "The candidate-specific criterion dispositions and authored-context claims.",
            accessPolicy: "worktree-relative",
          },
          ...authoredSources,
        ],
      },
      origin: { sourceUri },
      lockedRegions: [
        {
          paths: ["/charter"],
          sourceUri,
          reason: "The signed native SDD candidate owns workflow governance.",
          instruction:
            "Before launch, reopen and re-propose the plan; during a run, use the audited charter-amendment act.",
        },
        {
          paths: ["/origin", "/approvalRequired"],
          sourceUri,
          reason:
            "The signed native SDD candidate owns provenance and approval policy.",
          instruction:
            "Before launch, reopen and re-propose the plan; after launch, replace the execution.",
        },
      ],
      approvalRequired: false,
    },
  });
}

export async function finalizeAndAdmitDeliveryPlanLaunch(
  input: FinalizeAndAdmitDeliveryPlanLaunchInput,
  deps: FinalizeAndAdmitDeliveryPlanLaunchDeps,
): Promise<{
  candidateId: string;
  admission: AuthoredWorkflowLaunchAdmissionResult;
}> {
  const candidateId = deps.allocateCandidateId();
  const finalized = finalizeDeliveryPlanLaunch({ ...input, candidateId });
  const admission = await deps.admitLaunch(finalized);
  return { candidateId, admission };
}
