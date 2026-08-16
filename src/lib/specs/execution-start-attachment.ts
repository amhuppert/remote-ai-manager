import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import type { SpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import type { GraphWorkflowExecutionOrigin } from "@/lib/workflow-graph/spec-bridge";

import { executionDispositionFromDeliveryPlan } from "./delivery-plan";
import type { SpecExecutionBindingSnapshotV2 } from "./execution-binding";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import type {
  ActorProvenance,
  Spec,
  SpecExecutionRow,
  SpecGateDial,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";

const logger = createLogger("specs.execution-start-attachment");

interface SpecExecutionStartAttachmentDeps {
  deliveryRepo: Pick<
    SpecDeliveryRepo,
    "insertExecution" | "saveCriterionDisposition"
  >;
  bindingRepo: Pick<SpecExecutionBindingRepo, "insert">;
  linksRepo: Pick<SpecLinksRepo, "insertLink">;
  plansRepo: Pick<SpecDeliveryPlanRepo, "recordTransition">;
  events: Pick<SpecEventsPublisher, "appendInTransaction">;
  nextLinkId(): string;
}

interface SpecExecutionStartAttachmentInput {
  spec: Spec;
  specExecutionId: string;
  attemptId: string;
  sessionName: string;
  executionStartDial: SpecGateDial;
  scope: ExecutionScope;
  /** The spec-delivery origin the launched execution records. */
  origin: GraphWorkflowExecutionOrigin;
  binding: SpecExecutionBindingSnapshotV2;
  actor: ActorProvenance;
  createdAt: string;
}

export interface SpecExecutionStartAttachment {
  readonly specExecutionId: string;
  readonly publications: readonly PreparedSpecEventPublication[];
  attach(context: { executionId: string }): void;
}

/**
 * Prepares the spec-owned half of a direct graph launch. The returned callback
 * performs synchronous database writes only and is invoked by the graph start
 * core inside the transaction that inserts the graph execution.
 */
export function prepareSpecExecutionStartAttachment(
  deps: SpecExecutionStartAttachmentDeps,
  input: SpecExecutionStartAttachmentInput,
): SpecExecutionStartAttachment {
  const publications: PreparedSpecEventPublication[] = [];
  logger.debug("specs.execution-start-attachment.prepared", {
    specId: input.spec.id,
    specExecutionId: input.specExecutionId,
    attemptId: input.attemptId,
    candidateId: input.binding.candidateId,
  });

  return {
    specExecutionId: input.specExecutionId,
    publications,
    attach({ executionId }) {
      const row: SpecExecutionRow = {
        id: input.specExecutionId,
        spec_id: input.spec.id,
        revision_id: input.binding.pinnedRevisionId,
        scope_json: stableStringify(input.scope),
        state: "definition_review",
        execution_start_dial: input.executionStartDial,
        workflow_definition_id: null,
        workflow_definition_revision: null,
        workflow_seed_source_json: stableStringify(input.origin),
        workflow_execution_binding_json: null,
        workflow_execution_id: executionId,
        session_name: input.sessionName,
        delivered_at: null,
        abandoned_reason: null,
        cleanup_phase: null,
        linked_workflow_execution_id: null,
        cleanup_last_error: null,
        cleanup_last_error_at: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      };
      deps.deliveryRepo.insertExecution(row);

      for (const disposition of input.binding.dispositions) {
        deps.deliveryRepo.saveCriterionDisposition({
          execution_id: row.id,
          criterion_element_id: disposition.criterionElementId,
          disposition: executionDispositionFromDeliveryPlan(
            disposition.disposition,
          ),
          waiver_id: null,
          delivered_by_execution_id: disposition.deliveredByExecutionId,
          created_at: input.createdAt,
          updated_at: input.createdAt,
        });
      }

      deps.bindingRepo.insert({
        specExecutionId: row.id,
        workflowExecutionId: executionId,
        binding: input.binding,
        createdAt: input.createdAt,
      });

      deps.linksRepo.insertLink({
        id: deps.nextLinkId(),
        spec_id: input.spec.id,
        object_kind: "workflow_execution",
        object_ref_json: stableStringify({ workflowExecutionId: executionId }),
        direction: "outbound",
        category: "source",
        snapshot_json: stableStringify({
          revisionId: input.binding.pinnedRevisionId,
          deliveryPlanAttemptId: input.attemptId,
          candidateId: input.binding.candidateId,
          candidateHash: input.binding.candidateHash,
          origin: input.origin,
        }),
        element_ids_json: stableStringify(
          input.binding.dispositions.map(
            (disposition) => disposition.criterionElementId,
          ),
        ),
        actor_json: stableStringify(input.actor),
        created_at: input.createdAt,
      });

      deps.plansRepo.recordTransition({
        attemptId: input.attemptId,
        transition: {
          kind: "launch",
          executionId: row.id,
          candidateId: input.binding.candidateId,
          candidateHash: input.binding.candidateHash,
        },
        occurredAt: input.createdAt,
        actor: input.actor,
      });

      publications.push(
        deps.events.appendInTransaction({
          actor: input.actor,
          durableEventType: "spec-execution-changed",
          durablePayload: {
            kind: "execution_started",
            executionId: row.id,
            revisionId: input.binding.pinnedRevisionId,
            deliveryPlanAttemptId: input.attemptId,
            candidateId: input.binding.candidateId,
            candidateHash: input.binding.candidateHash,
          },
          sseEvent: {
            type: "spec-execution-changed",
            kind: "execution_started",
            projectPath: input.spec.projectPath,
            specId: input.spec.id,
            specSlug: input.spec.slug,
            occurredAt: input.createdAt,
            revisionId: input.binding.pinnedRevisionId,
            executionId: row.id,
          },
        }),
      );
    },
  };
}
