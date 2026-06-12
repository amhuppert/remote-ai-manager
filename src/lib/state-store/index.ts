import { createStateStore } from "./store";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

export { createStateStore, getStateDb, type StateStore } from "./store";
export type { AllRepos, StateStoreDeps } from "./schemas";

// One store per process, like the DB connection it wraps (`state-db`'s
// `__cc_state_db`). The repos inside hold parsed-row caches invalidated by a
// per-instance version counter; a second instance over the same DB (e.g. a
// fresh module generation after a Next.js HMR reload) would never see the
// first instance's bumps and would serve stale list reads indefinitely.
const defaultStore = getGlobalSingleton("__cc_state_store", () =>
  createStateStore(),
);

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
export const getConversationById = defaultStore.getConversationById;
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
