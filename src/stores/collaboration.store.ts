/**
 * Collaboration Mode UI store.
 *
 * Holds ephemeral client-side UI state for the inline `/collab` flow only:
 *
 *  - per-question answer drafts when a paused workflow is awaiting user input
 *  - per-conversation `/collab` config drafts (second agent, max rounds, etc.)
 *
 * Durable workflow state (envelope status, lifecycle phase, artifacts) lives
 * server-side in `WorkflowEnvelopeStore` and is fetched via TanStack Query.
 * This store deliberately stays narrow so a stale draft does not survive a
 * page reload (in-memory only) and so a round-trip refetch is the source of
 * truth for everything the slice owns.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

type CollabAgent = "claude" | "codex";

type CollabAutonomousResolutionThreshold =
  | "none"
  | "minor"
  | "major"
  | "blocking";

export interface CollabConfigDraft {
  secondAgent: CollabAgent;
  negotiationRounds: number;
  autonomousResolutionThreshold: CollabAutonomousResolutionThreshold;
}

interface CollaborationState {
  /**
   * Per-(session,workflow,question) user-answer drafts. Outer key is
   * `${projectName}::${sessionName}::${workflowId}`; inner record maps
   * questionId → draft answer text.
   */
  userAnswerDraftsByWorkflow: Record<string, Record<string, string>>;
  /**
   * Per-conversation `/collab` config drafts. Keyed by
   * `${projectName}::${sessionName}::${conversationId}` so opening a
   * different conversation gets a fresh draft.
   */
  collabConfigDraftsByConversation: Record<string, CollabConfigDraft>;
}

interface CollaborationActions {
  setUserAnswerDraft(
    projectName: string,
    sessionName: string,
    workflowId: string,
    questionId: string,
    answer: string,
  ): void;
  clearUserAnswerDrafts(
    projectName: string,
    sessionName: string,
    workflowId: string,
  ): void;
  setCollabConfigDraft(
    projectName: string,
    sessionName: string,
    conversationId: string,
    draft: CollabConfigDraft,
  ): void;
  clearCollabConfigDraft(
    projectName: string,
    sessionName: string,
    conversationId: string,
  ): void;
}

type CollaborationStore = CollaborationState & CollaborationActions;

export const DEFAULT_COLLAB_CONFIG_DRAFT: CollabConfigDraft = {
  secondAgent: "codex",
  negotiationRounds: 3,
  autonomousResolutionThreshold: "major",
};

function workflowKey(
  projectName: string,
  sessionName: string,
  workflowId: string,
): string {
  return `${projectName}::${sessionName}::${workflowId}`;
}

function conversationKey(
  projectName: string,
  sessionName: string,
  conversationId: string,
): string {
  return `${projectName}::${sessionName}::${conversationId}`;
}

export const useCollaborationStore = create<CollaborationStore>()(
  immer((set) => ({
    userAnswerDraftsByWorkflow: {},
    collabConfigDraftsByConversation: {},

    setUserAnswerDraft: (
      projectName,
      sessionName,
      workflowId,
      questionId,
      answer,
    ) =>
      set((state) => {
        const key = workflowKey(projectName, sessionName, workflowId);
        const existing = state.userAnswerDraftsByWorkflow[key] ?? {};
        state.userAnswerDraftsByWorkflow[key] = {
          ...existing,
          [questionId]: answer,
        };
      }),

    clearUserAnswerDrafts: (projectName, sessionName, workflowId) =>
      set((state) => {
        const key = workflowKey(projectName, sessionName, workflowId);
        delete state.userAnswerDraftsByWorkflow[key];
      }),

    setCollabConfigDraft: (projectName, sessionName, conversationId, draft) =>
      set((state) => {
        const key = conversationKey(projectName, sessionName, conversationId);
        state.collabConfigDraftsByConversation[key] = draft;
      }),

    clearCollabConfigDraft: (projectName, sessionName, conversationId) =>
      set((state) => {
        const key = conversationKey(projectName, sessionName, conversationId);
        delete state.collabConfigDraftsByConversation[key];
      }),
  })),
);

// Stable empty-record sentinel so subscribers don't get a new reference each
// time their workflow has no drafts.
const EMPTY_ANSWER_DRAFTS: Record<string, string> = Object.freeze({});

export const useUserAnswerDrafts = (
  projectName: string,
  sessionName: string,
  workflowId: string,
): Record<string, string> => {
  const key = workflowKey(projectName, sessionName, workflowId);
  return useCollaborationStore(
    (s) => s.userAnswerDraftsByWorkflow[key] ?? EMPTY_ANSWER_DRAFTS,
  );
};

export const useCollabConfigDraft = (
  projectName: string,
  sessionName: string,
  conversationId: string,
): CollabConfigDraft => {
  const key = conversationKey(projectName, sessionName, conversationId);
  return useCollaborationStore(
    (s) =>
      s.collabConfigDraftsByConversation[key] ?? DEFAULT_COLLAB_CONFIG_DRAFT,
  );
};

export const useSetUserAnswerDraft = () =>
  useCollaborationStore((s) => s.setUserAnswerDraft);
export const useClearUserAnswerDrafts = () =>
  useCollaborationStore((s) => s.clearUserAnswerDrafts);
export const useSetCollabConfigDraft = () =>
  useCollaborationStore((s) => s.setCollabConfigDraft);
export const useClearCollabConfigDraft = () =>
  useCollaborationStore((s) => s.clearCollabConfigDraft);
