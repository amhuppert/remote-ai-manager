import { z } from "zod";
import { createLogger } from "@/lib/logging";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type {
  SpecEventsPublisher,
  PreparedSpecEventPublication,
} from "./events";
import type { DeliveryPlanService } from "./delivery-plan-service";
import type { ExecutionService } from "./execution-service";
import type { ServiceResult } from "./evidence-service";
import {
  actorProvenanceSchema,
  specExecutionRowSchema,
  specDeliveryBasisSchema,
  type SpecExecutionRow,
  type Refusal,
  type Spec,
} from "./schemas";
import { executionScopeSchema } from "./scope-validation";

import {
  deliveryContinuationRequestSchema,
  deliveryReplacementRequestSchema,
} from "./delivery-review-schemas";

const continuationInputSchema = deliveryContinuationRequestSchema.extend({
  specId: z.string().min(1),
  actor: actorProvenanceSchema,
});
const replacementInputSchema = deliveryReplacementRequestSchema.extend({
  specId: z.string().min(1),
  actor: actorProvenanceSchema,
});
const logger = createLogger("specs.delivery-continuation");

function refuse(
  code: Refusal["code"],
  condition: string,
): ServiceResult<never> {
  logger.warn("specs.delivery-continuation.refused", { code, condition });
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions: [condition],
      instruction:
        "Refresh delivery review and choose where delivery will continue.",
    },
  };
}

export interface DeliveryContinuationDeps {
  specs: SpecsRepo;
  delivery: SpecDeliveryRepo;
  links: SpecLinksRepo;
  events: SpecEventsPublisher;
  execution: Pick<ExecutionService, "retireDelivery">;
  deliveryPlan: Pick<DeliveryPlanService, "abandonPrelaunch" | "open">;
  sessionExists(projectPath: string, sessionName: string): Promise<boolean>;
  workflowExists(projectPath: string, executionId: string): Promise<boolean>;
  nextId(): string;
  now(): string;
}

export function createDeliveryContinuationService(
  deps: DeliveryContinuationDeps,
) {
  async function resolve(
    parsed: z.infer<typeof replacementInputSchema>,
  ): Promise<ServiceResult<{ spec: Spec; active: SpecExecutionRow | null }>> {
    if (parsed.actor.kind !== "human")
      return refuse(
        "human_act_required",
        "Delivery continuation and external delivery require a human in Spec Studio.",
      );
    const spec = await deps.specs.findById(parsed.specId);
    const snapshot = await deps.specs.getRevisionSnapshot(parsed.revisionId);
    if (!spec || !snapshot || snapshot.revision.specId !== spec.id)
      return refuse("not_found", "The revision does not belong to this spec.");
    if (
      spec.abandonedAt ||
      snapshot.revision.state !== "approved" ||
      snapshot.revision.authoringStage === "requirements"
    )
      return refuse(
        "revision_not_approved",
        "Delivery requires an active spec with approved design.",
      );
    const active = deps.delivery.findActiveExecutionBySpecId(spec.id);
    if ((active?.id ?? null) !== parsed.expectedExecutionId)
      return refuse(
        "stale_revision",
        "The active delivery execution changed while this review was open.",
      );
    if (active && active.revision_id !== parsed.revisionId)
      return refuse(
        "stale_revision",
        "Review the revision pinned by the active delivery execution.",
      );
    return { ok: true, value: { spec, active } };
  }

  async function retire(
    spec: Spec,
    active: SpecExecutionRow | null,
    parsed: z.infer<typeof replacementInputSchema>,
  ): Promise<ServiceResult<null>> {
    if (active) {
      const abandoned = await deps.execution.retireDelivery({
        specId: spec.id,
        executionId: active.id,
        reason: parsed.note.trim() || "Delivery continued through Spec Studio.",
        actor: parsed.actor,
      });
      if (!abandoned.ok) return abandoned;
    }

    const retiredPlan = await deps.deliveryPlan.abandonPrelaunch({
      spec,
      reason: parsed.note.trim() || "Delivery continued through Spec Studio.",
      actor: parsed.actor,
    });
    if (!retiredPlan.ok && retiredPlan.refusal.code !== "not_found")
      return retiredPlan;

    return { ok: true, value: null };
  }

  return {
    async replace(input: z.infer<typeof replacementInputSchema>) {
      const parsed = replacementInputSchema.parse(input);
      const resolved = await resolve(parsed);
      if (!resolved.ok) return resolved;
      const { spec, active } = resolved.value;
      const retired = await retire(spec, active, parsed);
      if (!retired.ok) return retired;
      if (deps.delivery.findActiveExecutionBySpecId(spec.id))
        return refuse(
          "execution_active",
          "Another delivery execution started while replacement was being prepared.",
        );
      logger.info("specs.delivery-continuation.replacement_requested", {
        specId: spec.id,
        executionId: active?.id ?? null,
      });
      return deps.deliveryPlan.open({ spec, actor: parsed.actor });
    },
    async continue(
      input: z.infer<typeof continuationInputSchema>,
    ): Promise<ServiceResult<SpecExecutionRow>> {
      const parsed = continuationInputSchema.parse(input);
      const resolved = await resolve(parsed);
      if (!resolved.ok) return resolved;
      const { spec, active } = resolved.value;
      if (
        parsed.mode !== "external" &&
        (!parsed.sessionName ||
          !(await deps.sessionExists(spec.projectPath, parsed.sessionName)))
      )
        return refuse(
          "validation",
          "Choose an existing session for the remaining work and merge.",
        );
      if (parsed.mode === "workflow" && !parsed.workflowExecutionId)
        return refuse(
          "validation",
          "Choose the workflow that performed the remaining work.",
        );
      if (
        parsed.workflowExecutionId &&
        !(await deps.workflowExists(
          spec.projectPath,
          parsed.workflowExecutionId,
        ))
      )
        return refuse(
          "not_found",
          "The referenced workflow does not belong to this project.",
        );

      const prior = deps.delivery.findExecutionsBySpecId(spec.id);
      const sourceSpecExecutionIds = new Set<string>();
      const sourceWorkflowExecutionIds = new Set<string>();
      for (const execution of prior) {
        if (execution.workflow_execution_id) {
          sourceSpecExecutionIds.add(execution.id);
          sourceWorkflowExecutionIds.add(execution.workflow_execution_id);
        }
        if (!execution.delivery_basis_json) continue;
        const basis = specDeliveryBasisSchema.parse(
          JSON.parse(execution.delivery_basis_json),
        );
        for (const id of basis.sourceSpecExecutionIds)
          sourceSpecExecutionIds.add(id);
        for (const id of basis.sourceWorkflowExecutionIds)
          sourceWorkflowExecutionIds.add(id);
      }
      if (parsed.workflowExecutionId)
        sourceWorkflowExecutionIds.add(parsed.workflowExecutionId);
      const retired = await retire(spec, active, parsed);
      if (!retired.ok) return retired;

      const publications: PreparedSpecEventPublication[] = [];
      const result = await deps.specs.transaction<
        ServiceResult<SpecExecutionRow>
      >("specs.delivery-continuation.record", (repo) => {
        if (deps.delivery.findActiveExecutionBySpecId(spec.id))
          return refuse(
            "execution_active",
            "Another delivery execution started while continuation was being prepared.",
          );
        const current = repo.findById(spec.id);
        const pinned = repo.getRevisionSnapshot(parsed.revisionId);
        if (
          !current ||
          current.abandonedAt ||
          pinned?.revision.state !== "approved"
        )
          return refuse(
            "stale_revision",
            "The spec or its reviewed revision changed.",
          );
        const previousScope =
          active ??
          prior.findLast(
            (execution) => execution.revision_id === parsed.revisionId,
          );
        const scope = previousScope
          ? executionScopeSchema.parse(JSON.parse(previousScope.scope_json))
          : {
              selectedTaskIds: [],
              selectedCriterionIds: pinned.elements
                .filter(({ element }) => element.kind === "criterion")
                .map(({ element }) => element.id),
              exclusionDispositions: [],
            };
        const now = deps.now();
        const basis = specDeliveryBasisSchema.parse({
          kind: parsed.mode === "external" ? "external" : "session",
          sourceSpecExecutionIds: [...sourceSpecExecutionIds],
          sourceWorkflowExecutionIds: [...sourceWorkflowExecutionIds],
          commitRefs: parsed.commitRefs,
          note: parsed.note.trim(),
          actor: parsed.actor,
          createdAt: now,
        });
        const execution = specExecutionRowSchema.parse({
          id: deps.nextId(),
          spec_id: spec.id,
          revision_id: parsed.revisionId,
          scope_json: JSON.stringify(scope),
          state: basis.kind === "external" ? "delivered" : "running",
          execution_start_dial: null,
          workflow_definition_id: null,
          workflow_definition_revision: null,
          workflow_seed_source_json: null,
          workflow_execution_binding_json: null,
          workflow_execution_id: null,
          delivery_basis_json: JSON.stringify(basis),
          session_name: parsed.mode === "external" ? null : parsed.sessionName,
          delivered_at: basis.kind === "external" ? now : null,
          abandoned_reason: null,
          cleanup_phase: null,
          linked_workflow_execution_id: null,
          cleanup_last_error: null,
          cleanup_last_error_at: null,
          created_at: now,
          updated_at: now,
        });
        deps.delivery.insertExecution(execution);
        for (const criterionId of scope.selectedCriterionIds)
          deps.delivery.saveCriterionDisposition({
            execution_id: execution.id,
            criterion_element_id: criterionId,
            disposition: "in_scope",
            waiver_id: null,
            delivered_by_execution_id:
              basis.kind === "external" ? execution.id : null,
            created_at: now,
            updated_at: now,
          });
        for (const exclusion of scope.exclusionDispositions) {
          const previous = previousScope
            ? deps.delivery.findCriterionDisposition(
                previousScope.id,
                exclusion.criterionId,
              )
            : null;
          deps.delivery.saveCriterionDisposition({
            execution_id: execution.id,
            criterion_element_id: exclusion.criterionId,
            disposition: exclusion.disposition,
            waiver_id: previous?.waiver_id ?? null,
            delivered_by_execution_id:
              previous?.delivered_by_execution_id ?? null,
            created_at: now,
            updated_at: now,
          });
        }
        for (const workflowId of sourceWorkflowExecutionIds)
          deps.links.insertLink({
            id: deps.nextId(),
            spec_id: spec.id,
            object_kind: "workflow_execution",
            object_ref_json: JSON.stringify({
              projectPath: spec.projectPath,
              executionId: workflowId,
            }),
            direction: "inbound",
            category: "source",
            snapshot_json: JSON.stringify({
              specExecutionId: execution.id,
              revisionId: execution.revision_id,
            }),
            element_ids_json: null,
            actor_json: JSON.stringify(parsed.actor),
            created_at: now,
          });
        const kind =
          basis.kind === "external"
            ? "external_delivery_recorded"
            : "delivery_continued";
        publications.push(
          deps.events.appendInTransaction({
            actor: parsed.actor,
            durableEventType: "spec-execution-changed",
            durablePayload: {
              kind,
              executionId: execution.id,
              revisionId: execution.revision_id,
              basis,
            },
            sseEvent: {
              type: "spec-execution-changed",
              kind,
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt: now,
              executionId: execution.id,
              revisionId: execution.revision_id,
            },
          }),
        );
        return { ok: true, value: execution };
      });
      for (const event of publications) deps.events.publishAfterCommit(event);
      if (result.ok)
        logger.info("specs.delivery-continuation.recorded", {
          specId: spec.id,
          executionId: result.value.id,
          revisionId: parsed.revisionId,
          mode: parsed.mode,
          priorExecutionId: active?.id ?? null,
          sourceWorkflowCount: sourceWorkflowExecutionIds.size,
        });
      return result;
    },
  };
}
export type DeliveryContinuationService = ReturnType<
  typeof createDeliveryContinuationService
>;
