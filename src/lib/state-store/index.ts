import { createStateStore, type StateStore } from "./store";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

export { createStateStore, getStateDb, type StateStore } from "./store";
export type { AllRepos, StateStoreDeps } from "./schemas";
export type { SessionConversationListItem } from "./accessors";
export type { ConversationListItemProjection } from "./conversations-repo";
export type { SessionListItemProjection } from "./sessions-repo";

// One store per process, like the DB connection it wraps (`state-db`'s
// `__cc_state_db`). The repos inside hold parsed-row caches invalidated by a
// per-instance version counter; a second instance over the same DB (e.g. a
// fresh module generation after a Next.js HMR reload) would never see the
// first instance's bumps and would serve stale list reads indefinitely.
const defaultStore = getGlobalSingleton("__cc_state_store", () =>
  createStateStore(),
);

/**
 * Process-wide store singleton. Modules that need the store as an object
 * (e.g. to satisfy a `stateManager` deps slot) MUST use this accessor instead
 * of constructing their own instance via `createStateStore` — a private
 * instance over the same DB never sees the singleton's cache-version bumps
 * and serves stale reads indefinitely.
 */
export function getStateStore(): StateStore {
  return defaultStore;
}

export const mutateSession = defaultStore.mutateSession;
export const mutateConversation = defaultStore.mutateConversation;
export const createSessionConversation = defaultStore.createSessionConversation;
export const mutateProjectConversation = defaultStore.mutateProjectConversation;
export const getConversationMachineSnapshot =
  defaultStore.getConversationMachineSnapshot;
export const upsertConversationMachineSnapshot =
  defaultStore.upsertConversationMachineSnapshot;
export const deleteConversationMachineSnapshot =
  defaultStore.deleteConversationMachineSnapshot;
export type { ConversationSnapshotOwner } from "./conversation-machine-snapshots-repo";
export const getProjectSessionListItems =
  defaultStore.getProjectSessionListItems;
export const getSession = defaultStore.getSession;
export const getConversation = defaultStore.getConversation;
export const getConversationById = defaultStore.getConversationById;
export const getSessionConversations = defaultStore.getSessionConversations;
export const getProjectConversation = defaultStore.getProjectConversation;
export const getProjectConversationById =
  defaultStore.getProjectConversationById;
export const getProjectConversations = defaultStore.getProjectConversations;
export const listAllProjectConversations =
  defaultStore.listAllProjectConversations;
export const listConversationIdentities =
  defaultStore.listConversationIdentities;
export const listSessionConversationListItems =
  defaultStore.listSessionConversationListItems;
export const getSpawnedSessionStatuses = defaultStore.getSpawnedSessionStatuses;
export const getReferenceDocuments = defaultStore.getReferenceDocuments;
export const getSessionMarkdownDocuments =
  defaultStore.getSessionMarkdownDocuments;
export const isSessionMarkdownDocumentIndexed =
  defaultStore.isSessionMarkdownDocumentIndexed;
export const getDocumentComments = defaultStore.getDocumentComments;
export const getSessionDocumentComments =
  defaultStore.getSessionDocumentComments;
export const getDocumentCommentInScope = defaultStore.getDocumentCommentInScope;
export const upsertDocumentComment = defaultStore.upsertDocumentComment;
export const deleteDocumentComment = defaultStore.deleteDocumentComment;
/** @public Accessed via dynamic `import()` in actor-implementations. */
export const getProjectMcpOverrides = defaultStore.getProjectMcpOverrides;
export const getProjectAgentCapabilityOverrides =
  defaultStore.getProjectAgentCapabilityOverrides;
export const mutateProjectMcpOverrides = defaultStore.mutateProjectMcpOverrides;
export const mutateProjectAgentCapabilityOverrides =
  defaultStore.mutateProjectAgentCapabilityOverrides;
export const listProjectPaths = defaultStore.listProjectPaths;
export const getArchivedProjects = defaultStore.getArchivedProjects;
export const getPinnedProjects = defaultStore.getPinnedProjects;
export const createSessionRow = defaultStore.createSessionRow;
export const deleteSessionRow = defaultStore.deleteSessionRow;
export const retargetChildrenToMain = defaultStore.retargetChildrenToMain;
export const applyFusedSessionDelete = defaultStore.applyFusedSessionDelete;
export const deleteProjectRow = defaultStore.deleteProjectRow;
export const setSessionArchived = defaultStore.setSessionArchived;
export const setSessionTddEnabled = defaultStore.setSessionTddEnabled;
export const setSessionFinished = defaultStore.setSessionFinished;
export const setProjectArchived = defaultStore.setProjectArchived;
export const setConversationPendingPromptText =
  defaultStore.setConversationPendingPromptText;
export const clearConversationPendingPromptTextIfMatches =
  defaultStore.clearConversationPendingPromptTextIfMatches;
export const createProjectConversationRecord =
  defaultStore.createProjectConversation;
export const setProjectConversationPendingPromptText =
  defaultStore.setProjectConversationPendingPromptText;
export const setProjectConversationArchived =
  defaultStore.setProjectConversationArchived;
export const setProjectConversationOpen =
  defaultStore.setProjectConversationOpen;
export const setProjectPinned = defaultStore.setProjectPinned;
export const setSessionSpawnedFrom = defaultStore.setSessionSpawnedFrom;
export const addPlcSpawnedSessionIds = defaultStore.addPlcSpawnedSessionIds;
export const mutateActiveGraphWorkflowExecution =
  defaultStore.mutateActiveGraphWorkflowExecution;
export const reserveActiveGraphWorkflowExecution =
  defaultStore.reserveActiveGraphWorkflowExecution;
export const clearGraphWorkflowPendingArtifacts =
  defaultStore.clearGraphWorkflowPendingArtifacts;
export const archiveActiveGraphWorkflowExecution =
  defaultStore.archiveActiveGraphWorkflowExecution;
export const markGraphWorkflowContextEventsPreReset =
  defaultStore.markGraphWorkflowContextEventsPreReset;
export const mutateSessionWorkflowLanes =
  defaultStore.mutateSessionWorkflowLanes;
export const mutateSessionWorkflowEnvelopes =
  defaultStore.mutateSessionWorkflowEnvelopes;
export const claimGraphWorkflowResultDeliveries =
  defaultStore.claimGraphWorkflowResultDeliveries;
export const settleGraphWorkflowResultDeliveries =
  defaultStore.settleGraphWorkflowResultDeliveries;
export const releaseGraphWorkflowResultDeliveries =
  defaultStore.releaseGraphWorkflowResultDeliveries;
export const settleGraphWorkflowResultDeliveryFallback =
  defaultStore.settleGraphWorkflowResultDeliveryFallback;
export const commitGraphWorkflowMissingOriginFallback =
  defaultStore.commitGraphWorkflowMissingOriginFallback;
export const markGraphWorkflowResultEffectDelivered =
  defaultStore.markGraphWorkflowResultEffectDelivered;
export const recoverGraphWorkflowResultDeliveries =
  defaultStore.recoverGraphWorkflowResultDeliveries;
export const getGraphWorkflowResultDelivery =
  defaultStore.getGraphWorkflowResultDelivery;
export const listPendingGraphWorkflowResultEffects =
  defaultStore.listPendingGraphWorkflowResultEffects;
export const getGraphWorkflowEventsTail =
  defaultStore.getGraphWorkflowEventsTail;
export const getGraphWorkflowEventsPage =
  defaultStore.getGraphWorkflowEventsPage;
export const findLatestGraphWorkflowContextEvent =
  defaultStore.findLatestGraphWorkflowContextEvent;
export const getActiveGraphWorkflowExecution =
  defaultStore.getActiveGraphWorkflowExecution;
export const getArchivedGraphWorkflowExecutionById =
  defaultStore.getArchivedGraphWorkflowExecutionById;
export const getGraphWorkflowExecutionById =
  defaultStore.getGraphWorkflowExecutionById;
export const getGraphWorkflowBoundaryResultAfter =
  defaultStore.getGraphWorkflowBoundaryResultAfter;
export const getGraphWorkflowPendingArtifacts =
  defaultStore.getGraphWorkflowPendingArtifacts;
export const listActiveGraphWorkflowExecutions =
  defaultStore.listActiveGraphWorkflowExecutions;
export const listArchivedGraphWorkflowExecutions =
  defaultStore.listArchivedGraphWorkflowExecutions;
export const createReferenceDocument = defaultStore.createReferenceDocument;
export const deleteReferenceDocument = defaultStore.deleteReferenceDocument;
export const upsertSessionMarkdownDocuments =
  defaultStore.upsertSessionMarkdownDocuments;
