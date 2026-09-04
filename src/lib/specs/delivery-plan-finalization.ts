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

/**
 * Which locks a managed definition carries. A draft is the authoring surface
 * for the launch, so only the provenance the server minted is locked and the
 * charter stays open to `update-charter` and the builder; a candidate is the
 * envelope a sign-off binds, so its charter is locked as well.
 */
export type DeliveryPlanLaunchStage = "draft" | "candidate";

export interface DeliveryPlanLaunchFinalizationInput {
  readonly specId: string;
  readonly specSlug: string;
  readonly pinnedRevisionId: string;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly launch: WorkflowDefinitionMutation;
  readonly stage?: DeliveryPlanLaunchStage;
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

const SERVER_OWNED_SOURCE_IDS: ReadonlySet<string> = new Set([
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  NATIVE_SDD_CLAIMS_SOURCE_ID,
]);
const SERVER_OWNED_SOURCE_LOCATOR_PREFIXES = [
  ".cc/graph-workflow-docs/spec/",
  ".cc/graph-workflow-docs/spec-bindings/",
] as const;

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

export function isServerOwnedDeliveryPlanSource(source: {
  readonly id: string;
  readonly locator: string;
}): boolean {
  return (
    SERVER_OWNED_SOURCE_IDS.has(source.id) ||
    SERVER_OWNED_SOURCE_LOCATOR_PREFIXES.some((prefix) =>
      source.locator.startsWith(prefix),
    )
  );
}

/**
 * The sources an author owns, with the rank gaps the server-owned entries leave
 * closed so authored relative order survives. Finalization re-injects the
 * server-owned pair around the result, which is what keeps a launch that
 * already carries them — a reopened candidate, a re-proposed draft — from
 * accumulating a duplicate pair per hop.
 */
export function authoredDeliveryPlanSources<
  T extends {
    readonly id: string;
    readonly locator: string;
    readonly rank: number;
  },
>(sources: readonly T[]): T[] {
  const serverOwnedRanks = sources.flatMap((source) =>
    isServerOwnedDeliveryPlanSource(source) ? [source.rank] : [],
  );
  return sources
    .filter((source) => !isServerOwnedDeliveryPlanSource(source))
    .map((source) => ({
      ...source,
      rank:
        source.rank -
        serverOwnedRanks.filter((rank) => rank < source.rank).length,
    }));
}

/**
 * The submitted sources with each server-owned entry kept once, first
 * occurrence winning. A managed draft may carry the injected pair (a plan
 * round-tripped from `get --full` does) or omit it; what it may not do is
 * store two copies, which a planner's merge of a bare plan with a stored
 * definition can produce. Authored entries pass through untouched.
 */
export function dedupeServerOwnedDeliveryPlanSources<
  T extends { readonly id: string; readonly locator: string },
>(sources: readonly T[]): T[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!isServerOwnedDeliveryPlanSource(source)) return true;
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

export function finalizeDeliveryPlanLaunch(
  input: DeliveryPlanLaunchFinalizationInput,
): WorkflowDefinitionMutation {
  const stage = input.stage ?? "candidate";
  const sourceUri = deliveryPlanCandidateSourceUri(input);
  const authoredSources = authoredDeliveryPlanSources(
    input.launch.definition.charter.sourcesOfTruth,
  ).map((source) => ({ ...source, rank: source.rank + 2 }));
  const charterLock = {
    paths: ["/charter"],
    sourceUri,
    reason: "The signed native SDD candidate owns workflow governance.",
    instruction:
      "Before launch, reopen and re-propose the plan; during a run, use the audited charter-amendment act.",
  };
  const provenanceLock = {
    paths: ["/origin", "/approvalRequired"],
    sourceUri,
    reason:
      "The signed native SDD candidate owns provenance and approval policy.",
    instruction:
      "Before launch, reopen and re-propose the plan; after launch, replace the execution.",
  };

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
      lockedRegions:
        stage === "candidate"
          ? [charterLock, provenanceLock]
          : [provenanceLock],
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
