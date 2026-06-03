import { createStateStore } from "./store";

export { createStateStore, getStateDb, type StateStore } from "./store";
export type { AllRepos, StateStoreDeps } from "./schemas";

const defaultStore = createStateStore();

export const createStateManager = createStateStore;

export const readState = defaultStore.readState;
export const mutateState = defaultStore.mutateState;
export const mutateSession = defaultStore.mutateSession;
export const mutateConversation = defaultStore.mutateConversation;
export const mutateProjectConversation = defaultStore.mutateProjectConversation;
export const getProjectSessionListItems =
  defaultStore.getProjectSessionListItems;
export const getSession = defaultStore.getSession;
export const getConversation = defaultStore.getConversation;
export const getSessionConversations = defaultStore.getSessionConversations;
export const getProjectConversation = defaultStore.getProjectConversation;
export const getProjectConversations = defaultStore.getProjectConversations;
export const listAllProjectConversations =
  defaultStore.listAllProjectConversations;
export const getSpawnedSessionStatuses = defaultStore.getSpawnedSessionStatuses;
export const getReferenceDocuments = defaultStore.getReferenceDocuments;
/** @public Accessed via dynamic `import()` in actor-implementations. */
export const getProjectMcpOverrides = defaultStore.getProjectMcpOverrides;
export const getArchivedProjects = defaultStore.getArchivedProjects;
export const getPinnedProjects = defaultStore.getPinnedProjects;
export const setSessionArchived = defaultStore.setSessionArchived;
export const setSessionTddEnabled = defaultStore.setSessionTddEnabled;
export const setSessionFinished = defaultStore.setSessionFinished;
export const setProjectArchived = defaultStore.setProjectArchived;
export const setConversationPendingPromptText =
  defaultStore.setConversationPendingPromptText;
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
export const createReferenceDocument = defaultStore.createReferenceDocument;
export const deleteReferenceDocument = defaultStore.deleteReferenceDocument;
