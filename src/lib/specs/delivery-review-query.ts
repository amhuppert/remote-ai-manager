import type { SpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { findDeliveryVerdictForExecution } from "./delivery-verdict-identity";
import { specDeliveryBasisSchema } from "./schemas";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { DeliveryGateEvaluator } from "@/lib/workflows/merge/types";
import type { DeliveryReviewView } from "./delivery-review-schemas";
import type { Spec } from "./schemas";
import {
  applicableAcceptanceReview,
  criterionAcceptanceHash,
} from "./acceptance-review";
import { elementHandleInSnapshot } from "./revision-handles";
import { executionScopeSchema } from "./scope-validation";
import { resolveDial } from "./policy";
import { createLogger } from "@/lib/logging";

const logger = createLogger("specs.delivery-review-query");

export interface DeliveryReviewQueryDeps {
  specs: SpecsRepo;
  bindings: Pick<SpecExecutionBindingRepo, "findBySpecExecutionId">;
  delivery: SpecDeliveryRepo;
  review: Pick<SpecReviewRepo, "hasValidHumanGateApproval">;
  gate: DeliveryGateEvaluator;
}

export async function readDeliveryReview(
  deps: DeliveryReviewQueryDeps,
  spec: Spec,
  executionId?: string,
): Promise<DeliveryReviewView | null> {
  const revisions = await deps.specs.listRevisions(spec.id);
  const approved = revisions
    .filter(
      (revision) =>
        revision.state === "approved" &&
        revision.authoringStage !== "requirements",
    )
    .sort((a, b) => b.number - a.number)[0];
  const active = deps.delivery.findActiveExecutionBySpecId(spec.id);
  const executions = deps.delivery.findExecutionsBySpecId(spec.id);
  const execution = executionId
    ? (executions.find(
        (row) =>
          row.id === executionId || row.workflow_execution_id === executionId,
      ) ?? null)
    : (active ??
      executions.filter((row) => row.revision_id === approved?.id).at(-1) ??
      null);
  if (executionId && !execution)
    throw new Error(
      "The requested delivery execution does not belong to this spec.",
    );
  const revisionId = execution?.revision_id ?? approved?.id;
  if (!revisionId) return null;
  const snapshot = await deps.specs.getRevisionSnapshot(revisionId);
  if (!snapshot) throw new Error("The delivery revision is missing.");
  const history = deps.delivery.findAcceptanceReviewsBySpecId(spec.id);
  const scope = execution
    ? executionScopeSchema.parse(JSON.parse(execution.scope_json))
    : null;
  const approvalGranted =
    execution !== null &&
    deps.review.hasValidHumanGateApproval({
      specId: spec.id,
      revisionId,
      executionId: execution.id,
      gate: "delivery",
    });
  const gate =
    execution?.state === "running"
      ? await deps.gate.evaluate({
          specExecutionId: execution.id,
          projectPath: spec.projectPath,
          preparedSha: "",
          expectedTargetSha: "",
          readOnly: true,
        })
      : null;
  const basis = execution?.delivery_basis_json
    ? specDeliveryBasisSchema.parse(JSON.parse(execution.delivery_basis_json))
    : null;
  const delivered =
    execution?.state === "delivered" ||
    (execution === null && snapshot.revision.externalDelivery !== null);
  const verdicts = execution
    ? deps.delivery.findDeliveryVerdictsBySpecExecutionId(execution.id)
    : [];
  const binding = execution
    ? deps.bindings.findBySpecExecutionId(execution.id)
    : null;
  const outcomes =
    gate?.status === "pass"
      ? gate.satisfied
      : [...(gate?.unmet ?? []), ...(gate?.satisfied ?? [])];
  const criteria: DeliveryReviewView["criteria"] = snapshot.elements.flatMap(
    ({ element, version }) => {
      if (version.payload.kind !== "criterion") return [];
      const contentHash = criterionAcceptanceHash(snapshot, element.id);
      const humanReview =
        contentHash === null
          ? null
          : applicableAcceptanceReview(history, element.id, contentHash);
      const evaluation = outcomes.find(
        (outcome) => outcome.criterionId === element.id,
      );
      const verdict =
        execution && delivered
          ? findDeliveryVerdictForExecution(
              verdicts,
              execution,
              binding,
              element.id,
            )
          : null;
      const disposition = execution
        ? deps.delivery.findCriterionDisposition(execution.id, element.id)
        : null;
      const recorded =
        delivered &&
        disposition?.disposition === "in_scope" &&
        disposition.delivered_by_execution_id === execution?.id;
      const external =
        delivered &&
        (basis?.kind === "external" ||
          (execution === null && snapshot.revision.externalDelivery !== null));
      const parent = snapshot.elements.find(
        (row) => row.element.id === element.parentElementId,
      );
      const inScope =
        scope === null || scope.selectedCriterionIds.includes(element.id);
      const outcome: DeliveryReviewView["criteria"][number]["outcome"] =
        !inScope
          ? "excluded"
          : evaluation?.outcome === "satisfied" || verdict !== null
            ? "proven"
            : external
              ? "delivered_externally"
              : humanReview?.decision === "satisfied" ||
                  evaluation?.outcome === "human_satisfied"
                ? "satisfied"
                : humanReview?.decision === "waived" ||
                    evaluation?.outcome === "waived"
                  ? "waived"
                  : recorded
                    ? "delivered"
                    : "needs_review";
      return [
        {
          id: element.id,
          handle: elementHandleInSnapshot(snapshot, element.id) ?? element.id,
          text: version.payload.text,
          requirement:
            parent?.version.payload.kind === "requirement"
              ? parent.version.payload.statement
              : "Acceptance criteria",
          inScope,
          outcome,
          humanReview,
          automated:
            evaluation?.automated ??
            (verdict
              ? [
                  `Verified by ${verdict.satisfying_context_id} in workflow ${verdict.workflow_execution_id}.`,
                ]
              : []),
        },
      ];
    },
  );
  const blockers: DeliveryReviewView["blockers"] =
    gate?.status === "refused"
      ? gate.unmet.map((item) => ({
          criterionId: item.criterionId,
          reason: item.reason ?? item.outcome,
          kind:
            item.outcome === "approval_required"
              ? "approval"
              : criteria.some((criterion) => criterion.id === item.criterionId)
                ? "criterion"
                : "execution",
        }))
      : delivered
        ? []
        : gate === null
          ? [
              {
                criterionId: "execution",
                reason:
                  "Choose how to continue delivery before approving a merge.",
                kind: "execution",
              },
            ]
          : [];
  logger.debug("specs.delivery-review.read", {
    specId: spec.id,
    revisionId,
    executionId: execution?.id ?? null,
    criterionCount: criteria.length,
    blockerCount: blockers.length,
  });
  return {
    revisionId,
    revisionNumber: snapshot.revision.number,
    contentHash: snapshot.revision.contentHash,
    lastReviewId: history.at(-1)?.id ?? null,
    execution,
    delivered,
    criteria,
    approvalGranted,
    requiresApproval: resolveDial(spec.gatePolicy, "delivery") === "gate",
    blockers,
    history,
  };
}
