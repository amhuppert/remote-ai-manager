import { getProductionWorkflowComposition } from "@/lib/workflows/production";
/**
 * Production wiring for the runtime graph-expansion service (D4 R6) — the same
 * role `lane-tool-context-loader.ts` plays for the other lane verbs.
 *
 * Kept out of `expansion-service.ts` so the service and its envelope stay
 * dependency-injected and testable against plain execution fixtures: this is the
 * only place the real repository, event publisher, and config-derived live-edit
 * deps are bound.
 */

import {
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
} from "@/lib/state-store";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  buildDefaultAssignmentSnapshotPreparation,
  buildDefaultLiveEditDeps,
} from "./live-edit-apply";
import {
  createGraphWorkflowExpansionService,
  expansionRefusalEventInput,
  type ExpansionRefusalNotice,
} from "./expansion-service";

export {
  classifyExpansionPayloadRefusal,
  graphExpansionRequestSchema,
  type ExpansionRefusalNotice,
  type GraphExpansionInput,
  type GraphExpansionOutcome,
} from "./expansion-service";

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,

  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
  eventPublisher,
});

/**
 * The production expansion service preloads the registered execution contract
 * before compiling or evaluating an expansion, then gives the pure edit core
 * only the execution-scoped result.
 */
export function createDefaultExpansionService() {
  return createGraphWorkflowExpansionService({
    getActiveExecution: getActiveGraphWorkflowExecution,
    mutateActive: executionRepository.mutateActive,
    buildLiveEditDeps: buildDefaultLiveEditDeps,
    executionContract: getProductionWorkflowComposition().executionContract,
    prepareAssignmentSnapshots: buildDefaultAssignmentSnapshotPreparation,
    publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
    publishGraphExpansion: eventPublisher.publishGraphExpansion,
    deliver: eventPublisher.deliver,
    now: () => new Date().toISOString(),
  });
}

/**
 * Broadcast the typed refusal event for an expansion refused BEFORE the service
 * runs — an unauthorized lane or a payload that never parsed (R6.2).
 *
 * Broadcast rather than committed, and unlike the service's own refusals it
 * stays that way: a receipt is keyed on the canonical payload hash, and these
 * are exactly the refusals where there IS no canonical payload to hash (the body
 * never parsed) or no verified lane to attribute one to. The ring holds the
 * attempts a retry could be answered from; an unparseable body is not one.
 */
export function publishExpansionRefusal(notice: ExpansionRefusalNotice): void {
  eventPublisher.deliver(
    eventPublisher.publishGraphExpansion(
      expansionRefusalEventInput(notice, new Date().toISOString()),
    ),
  );
}
