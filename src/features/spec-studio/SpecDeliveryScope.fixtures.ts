import {
  deliveryDeltaProjectionSchema,
  type DeliveryDeltaProjection,
  type CriterionDeliveryClass,
} from "@/lib/specs/delivery-delta";
import type { SpecDetailView } from "@/lib/specs/queries";
import { specElementReaderDetailFixture } from "./SpecElementReader.fixtures";

export function deliveryDashboardFixture(): {
  detail: SpecDetailView;
  projection: DeliveryDeltaProjection;
} {
  const detail = specElementReaderDetailFixture();
  const snapshot = detail.currentApprovedRevision;
  const template = snapshot?.elements.find(
    (entry) => entry.version.payload.kind === "criterion",
  );
  if (!snapshot || !template)
    throw new Error("Delivery fixture requires approved criteria");
  const statements = [
    "Persist the complete execution scope at launch so every task reads the approved contract.",
    "Restore the pinned revision when resuming an interrupted execution.",
    "Show criterion evidence alongside the requirement it proves.",
    "Keep delivered work available after the source spec changes.",
    "Revalidate affected criteria when their requirement or decision changes.",
    "Review carried-forward proof when supporting context changes.",
    "Defer optional migration work with a durable reason.",
    "Record a human waiver without claiming the criterion was delivered.",
    "Capture discoveries for the next delivery attempt while the current run keeps its scope.",
    "Require confirmation before abandoning an execution for a blocking replan.",
    "Link execution results back to the originating requirements and design decisions.",
    "Make delivery status and scope inspection usable from a narrow viewport.",
  ];
  const classifications: CriterionDeliveryClass[] = [
    "delivered_and_fresh",
    "delivered_and_fresh",
    "delivered_and_fresh",
    "delivered_and_fresh",
    "hard_stale",
    "soft_stale",
    "deferred",
    "waived",
    "never_delivered",
    "never_delivered",
    "never_delivered",
    "never_delivered",
  ];
  const criteria = statements.map((text, index) => ({
    ...template,
    handle: `R1.${index + 1}`,
    element: {
      ...template.element,
      id: `criterion-${index + 1}`,
      number: index + 1,
    },
    version: {
      ...template.version,
      elementId: `criterion-${index + 1}`,
      payload: {
        kind: "criterion" as const,
        text,
        validationStrategy: {
          kinds: ["test_run" as const],
          note: "Verify the behavior through the production delivery route and persisted execution snapshot.",
        },
      },
    },
  }));
  const populated = {
    ...snapshot,
    revision: { ...snapshot.revision, id: "revision-2", number: 2 },
    elements: [
      ...snapshot.elements.filter(
        (entry) => entry.element.kind !== "criterion",
      ),
      ...criteria,
    ].map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: "revision-2" },
    })),
  };
  const projection = deliveryDeltaProjectionSchema.parse({
    specSlug: detail.spec.slug,
    current: {
      revisionId: populated.revision.id,
      revisionNumber: populated.revision.number,
    },
    base: { revisionId: "delivered-revision", revisionNumber: 1 },
    comparedExecution: {
      executionId: "delivered-execution",
      workflowExecutionId: "delivered-workflow",
      revisionId: "delivered-revision",
      state: "delivered",
      deliveredAt: "2026-08-14T12:00:00.000Z",
    },
    elements: populated.elements.map((entry) => ({
      elementId: entry.element.id,
      handle: entry.handle ?? entry.element.id,
      kind: entry.element.kind,
      class: entry.element.kind === "decision" ? "amended" : "added",
      baseHash: null,
      currentHash: entry.version.payloadHash,
    })),
    criteria: criteria.map((entry, index) => ({
      criterionElementId: entry.element.id,
      handle: entry.handle,
      class: classifications[index],
      priorDisposition: null,
      freshness: null,
    })),
    advisories: [],
    counts: {
      elements: {
        added: populated.elements.length - 1,
        amended: 1,
        removed: 0,
        unchanged: 0,
      },
      criteria: {
        delivered_and_fresh: 4,
        hard_stale: 1,
        soft_stale: 1,
        never_delivered: 4,
        deferred: 1,
        waived: 1,
      },
    },
  });
  return {
    detail: {
      ...detail,
      revisions: [...detail.revisions, populated.revision],
      status: {
        ...detail.status,
        coverage: { coveredCriteria: 12, totalCriteria: 12, percentage: 100 },
        delivery: {
          ...detail.status.delivery,
          deliveredCount: 4,
          provenCount: 4,
          totalInScope: 12,
        },
      },
      currentRevision: populated,
      currentApprovedRevision: populated,
      executionRevisionSnapshots: [populated],
    },
    projection,
  };
}
