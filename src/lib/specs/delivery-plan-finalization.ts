import { workflowDefinitionMutationSchema } from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowDefinitionMutation } from "@/lib/workflow-graph/definition-schemas";
import { type SeededWorkflowDocument } from "@/lib/workflow-graph/spec-bridge";
import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";

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
  readonly seededDocuments?: readonly SeededWorkflowDocument[];
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

export function isServerOwnedDeliveryPlanDocument(
  relativePath: string,
): boolean {
  return SERVER_OWNED_SOURCE_LOCATOR_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix),
  );
}

export function contextSpecDocumentPath(
  specSlug: string,
  contextId: string,
): string {
  return `.cc/graph-workflow-docs/spec/${specSlug}/${encodeURIComponent(contextId)}.md`;
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

export function isServerOwnedDeliveryPlanSource(source: {
  readonly id: string;
  readonly locator: string;
}): boolean {
  return (
    SERVER_OWNED_SOURCE_IDS.has(source.id) ||
    isServerOwnedDeliveryPlanDocument(source.locator)
  );
}

/**
 * The sources an author owns, with the rank gaps the server-owned entries leave
 * closed so authored relative order survives. Finalization re-injects the
 * server-owned entries around the result, which is what keeps a launch that
 * already carries them — a reopened candidate, a draft restaged at sign-off —
 * from accumulating duplicate entries per hop.
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
 * occurrence winning. A managed draft may carry the injected entries (a plan
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
  const contextSources = input.launch.definition.executionContexts.map(
    (context, index) => ({
      rank: index + 1,
      id: `native-sdd-context-${context.id}`,
      label: `Pinned spec excerpt for ${context.id}`,
      type: "spec" as const,
      locator: contextSpecDocumentPath(input.specSlug, context.id),
      description:
        "The pinned requirements, criteria and decisions covered by this context.",
      appliesTo: { contextIds: [context.id] },
    }),
  );
  const authoredSources = authoredDeliveryPlanSources(
    input.launch.definition.charter.sourcesOfTruth,
  ).map((source) => ({
    ...source,
    rank: source.rank + contextSources.length + 2,
  }));
  const charterLock = {
    paths: ["/charter"],
    sourceUri,
    reason: "The signed native SDD candidate owns workflow governance.",
    instruction:
      "Before launch, reopen the plan and have the revised draft signed off; during a run, use the audited charter-amendment act.",
  };
  const provenanceLock = {
    paths: ["/origin", "/approvalRequired"],
    sourceUri,
    reason:
      "The signed native SDD candidate owns provenance and approval policy.",
    instruction:
      "Before launch, reopen the plan and have the revised draft signed off; after launch, replace the execution.",
  };

  return workflowDefinitionMutationSchema.parse({
    ...input.launch,
    definition: {
      ...input.launch.definition,
      ...(input.launch.definition.seededDocuments !== undefined ||
      input.seededDocuments !== undefined
        ? {
            seededDocuments: [
              ...(input.launch.definition.seededDocuments ?? []).filter(
                (document) =>
                  !isServerOwnedDeliveryPlanDocument(document.relativePath),
              ),
              ...(input.seededDocuments ??
                (stage === "candidate"
                  ? (input.launch.definition.seededDocuments ?? []).filter(
                      (document) =>
                        isServerOwnedDeliveryPlanDocument(
                          document.relativePath,
                        ),
                    )
                  : [])),
            ],
          }
        : {}),
      charter: {
        ...input.launch.definition.charter,
        sourcesOfTruth: [
          ...contextSources,
          {
            rank: contextSources.length + 1,
            id: NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
            label: "Pinned native SDD specification",
            type: "spec",
            locator: pinnedSpecDocumentPath(input.specSlug),
            description:
              "The full immutable specification revision; read when the excerpt is insufficient.",
          },
          {
            rank: contextSources.length + 2,
            id: NATIVE_SDD_CLAIMS_SOURCE_ID,
            label: "Native SDD candidate claims",
            type: "document",
            locator: candidateClaimsDocumentPath(input.candidateId),
            description:
              "The candidate-specific criterion dispositions and authored-context claims.",
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
