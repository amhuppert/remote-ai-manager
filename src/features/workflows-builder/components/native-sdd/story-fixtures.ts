import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";

export function managedDeliveryStory(
  lifecycle: NativeSddWorkflowManagementDetail["lifecycle"] = "draft",
): NativeSddWorkflowManagementDetail {
  const candidate = {
    protocol: "native-sdd-delivery-candidate/v3" as const,
    schemaVersion: 3 as const,
    specId: "spec-native-sdd",
    attemptId: "attempt-8",
    candidateId: "definition-8",
    pinnedRevisionId: "revision-8",
    draftRevision: 4,
    workflowDefinition: {
      id: "definition-8",
      revision: 3,
      definitionHash: `sha256:${"d".repeat(64)}`,
    },
    binding: {
      dispositions: [
        {
          criterionElementId: "criterion-1",
          disposition: "pending_reaffirmation" as const,
          deliveredByExecutionId: "execution-7",
        },
      ],
      claims: [
        {
          contextId: "context-implement",
          criterionElementIds: ["criterion-1"],
        },
      ],
    },
    bindingHash: `sha256:${"b".repeat(64)}`,
  };
  return {
    kind: "native_sdd_delivery",
    specId: "spec-native-sdd",
    specSlug: "native-sdd",
    specName: "Native SDD",
    attemptId: "attempt-8",
    pinnedRevisionId: "revision-8",
    pinnedRevisionNumber: 8,
    lifecycle,
    editable: lifecycle === "draft",
    isCurrentDefinition: !["superseded", "abandoned"].includes(lifecycle),
    specHref: "/specs/command-center/native-sdd",
    builderHref: "/projects/command-center/workflows?definition=definition-8",
    executionHref:
      lifecycle === "launched"
        ? "/projects/command-center/session-8/workflow?execution=execution-8"
        : null,
    bindingRevision: 4,
    deltaBasisExecutionId: "execution-7",
    binding: candidate.binding,
    dispositionCounts: { pending_reaffirmation: 1 },
    unresolvedItems: [
      {
        criterionElementId: "criterion-1",
        handle: "R1.1",
        text: "The plan is reviewed in Workflow Builder",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: "execution-7",
        contextIds: ["context-implement"],
      },
    ],
    criterionRows: [
      {
        criterionElementId: "criterion-1",
        handle: "R1.1",
        text: "The plan is reviewed in Workflow Builder",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: "execution-7",
        contextIds: ["context-implement"],
      },
    ],
    claims: candidate.binding.claims,
    comments: [],
    nextAct: lifecycle === "draft" ? "propose" : null,
    currentCandidate:
      lifecycle === "draft" || lifecycle === "abandoned" ? null : candidate,
    currentCandidateHash:
      lifecycle === "draft" || lifecycle === "abandoned"
        ? null
        : `sha256:${"c".repeat(64)}`,
    currentApproval: null,
    approvedBaseline:
      lifecycle === "draft"
        ? null
        : {
            snapshotId: "snapshot-7",
            candidateId: "definition-7",
            candidateHash: `sha256:${"7".repeat(64)}`,
            approvedAt: "2026-08-30T12:00:00.000Z",
            workflowDefinition: {
              id: "definition-7",
              revision: 2,
              definitionHash: `sha256:${"e".repeat(64)}`,
            },
          },
    changes: {
      workflowSettings: true,
      contexts: true,
      tasks: false,
      edges: true,
      layout: false,
      dispositions: true,
      claims: false,
    },
    capabilities: {
      canPropose: lifecycle === "draft",
      canSignOff: lifecycle === "in_review",
      canReopen: lifecycle === "in_review" || lifecycle === "approved",
      canAbandon: ["draft", "in_review", "approved"].includes(lifecycle),
      canLaunch: lifecycle === "approved",
      refusals: {},
    },
  };
}
