import { createStateStore } from "@/lib/state-store/state-store";

const defaultStore = createStateStore();

export const createStateManager = createStateStore;

export const readState = defaultStore.readState;
export const writeState = defaultStore.writeState;
export const mutateState = defaultStore.mutateState;
export const mutateSession = defaultStore.mutateSession;
export const mutateConversation = defaultStore.mutateConversation;
export const getProjectSessions = defaultStore.getProjectSessions;
export const getProjectSessionListItems =
  defaultStore.getProjectSessionListItems;
export const getSession = defaultStore.getSession;
export const getConversation = defaultStore.getConversation;
export const getSessionConversations = defaultStore.getSessionConversations;
export const getReferenceDocuments = defaultStore.getReferenceDocuments;
export const getProjectMcpOverrides = defaultStore.getProjectMcpOverrides;
export const getArchivedProjects = defaultStore.getArchivedProjects;
export const getPinnedProjects = defaultStore.getPinnedProjects;
export const getOrCreateProject = defaultStore.getOrCreateProject;
export const updateSession = defaultStore.updateSession;
export const removeSession = defaultStore.removeSession;
export const setSessionArchived = defaultStore.setSessionArchived;
export const setSessionTddEnabled = defaultStore.setSessionTddEnabled;
export const setSessionFinished = defaultStore.setSessionFinished;
export const setProjectArchived = defaultStore.setProjectArchived;
export const setConversationPendingPromptText =
  defaultStore.setConversationPendingPromptText;
export const setProjectPinned = defaultStore.setProjectPinned;
export const createReferenceDocument = defaultStore.createReferenceDocument;
export const deleteReferenceDocument = defaultStore.deleteReferenceDocument;
