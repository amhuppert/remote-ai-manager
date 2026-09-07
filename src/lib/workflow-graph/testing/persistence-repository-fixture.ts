import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionRepository } from "../execution-repository";
import { createGraphWorkflowExecutionEventPublisher } from "../execution-events";

export function createPersistenceGraphRepository(fixture: PersistenceFixture) {
  return createGraphWorkflowExecutionRepository({
    getSession: fixture.store.getSession,
    getActiveGraphWorkflowExecution:
      fixture.store.getActiveGraphWorkflowExecution,
    mutateActiveGraphWorkflowExecution:
      fixture.store.mutateActiveGraphWorkflowExecution,
    reserveActiveGraphWorkflowExecution:
      fixture.store.reserveActiveGraphWorkflowExecution,
    archiveActiveGraphWorkflowExecution:
      fixture.store.archiveActiveGraphWorkflowExecution,
    markGraphWorkflowContextEventsPreReset:
      fixture.store.markGraphWorkflowContextEventsPreReset,
    getGraphWorkflowPendingArtifacts:
      fixture.store.getGraphWorkflowPendingArtifacts,
    clearGraphWorkflowPendingArtifacts:
      fixture.store.clearGraphWorkflowPendingArtifacts,
    eventPublisher: createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
    }),
  });
}
