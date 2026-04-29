/**
 * Collaboration Mode UI store.
 *
 * Holds ephemeral client-side UI state for the collaboration feature only:
 *
 *  - the brief draft the user is typing into the start form (per session)
 *  - the workflow the user has expanded in the side panel (per session)
 *  - per-question answer drafts when a paused workflow is awaiting user input
 *
 * Durable workflow state (envelope status, lifecycle phase, artifacts) lives
 * server-side in `WorkflowEnvelopeStore` and is fetched via TanStack Query.
 * This store deliberately stays narrow so a stale draft does not survive a
 * page reload (in-memory only) and so a round-trip refetch is the source of
 * truth for everything the slice owns.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface BriefDraft {
  brief: string;
  maxIterations: number;
  scribeBackend: "claude" | "codex";
}

interface CollaborationState {
  /** Per-session brief drafts. Key is `${projectName}::${sessionName}`. */
  briefDraftsBySession: Record<string, BriefDraft>;
  /** Per-session selected workflow id (null when nothing is open). */
  selectedWorkflowIdBySession: Record<string, string | null>;
  /**
   * Per-(session,workflow,question) user-answer drafts. Outer key is
   * `${projectName}::${sessionName}::${workflowId}`; inner record maps
   * questionId → draft answer text.
   */
  userAnswerDraftsByWorkflow: Record<string, Record<string, string>>;
}

interface CollaborationActions {
  setBriefDraft(
    projectName: string,
    sessionName: string,
    draft: Partial<BriefDraft>,
  ): void;
  clearBriefDraft(projectName: string, sessionName: string): void;
  setSelectedWorkflowId(
    projectName: string,
    sessionName: string,
    workflowId: string | null,
  ): void;
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
}

type CollaborationStore = CollaborationState & CollaborationActions;

const DEFAULT_DRAFT: BriefDraft = {
  brief: "",
  maxIterations: 4,
  scribeBackend: "claude",
};

function sessionKey(projectName: string, sessionName: string): string {
  return `${projectName}::${sessionName}`;
}

function workflowKey(
  projectName: string,
  sessionName: string,
  workflowId: string,
): string {
  return `${projectName}::${sessionName}::${workflowId}`;
}

export const useCollaborationStore = create<CollaborationStore>()(
  immer((set) => ({
    briefDraftsBySession: {},
    selectedWorkflowIdBySession: {},
    userAnswerDraftsByWorkflow: {},

    setBriefDraft: (projectName, sessionName, patch) =>
      set((state) => {
        const key = sessionKey(projectName, sessionName);
        const existing = state.briefDraftsBySession[key] ?? DEFAULT_DRAFT;
        state.briefDraftsBySession[key] = { ...existing, ...patch };
      }),

    clearBriefDraft: (projectName, sessionName) =>
      set((state) => {
        const key = sessionKey(projectName, sessionName);
        delete state.briefDraftsBySession[key];
      }),

    setSelectedWorkflowId: (projectName, sessionName, workflowId) =>
      set((state) => {
        const key = sessionKey(projectName, sessionName);
        state.selectedWorkflowIdBySession[key] = workflowId;
      }),

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
  })),
);

export const useBriefDraft = (
  projectName: string,
  sessionName: string,
): BriefDraft => {
  const draftsBySession = useCollaborationStore((s) => s.briefDraftsBySession);
  return useMemo(
    () =>
      draftsBySession[sessionKey(projectName, sessionName)] ?? DEFAULT_DRAFT,
    [draftsBySession, projectName, sessionName],
  );
};

export const useSelectedWorkflowId = (
  projectName: string,
  sessionName: string,
): string | null => {
  const map = useCollaborationStore((s) => s.selectedWorkflowIdBySession);
  return map[sessionKey(projectName, sessionName)] ?? null;
};

export const useUserAnswerDrafts = (
  projectName: string,
  sessionName: string,
  workflowId: string,
): Record<string, string> => {
  const map = useCollaborationStore((s) => s.userAnswerDraftsByWorkflow);
  return useMemo(
    () => map[workflowKey(projectName, sessionName, workflowId)] ?? {},
    [map, projectName, sessionName, workflowId],
  );
};

export const useSetBriefDraft = () =>
  useCollaborationStore((s) => s.setBriefDraft);
export const useClearBriefDraft = () =>
  useCollaborationStore((s) => s.clearBriefDraft);
export const useSetSelectedWorkflowId = () =>
  useCollaborationStore((s) => s.setSelectedWorkflowId);
export const useSetUserAnswerDraft = () =>
  useCollaborationStore((s) => s.setUserAnswerDraft);
export const useClearUserAnswerDrafts = () =>
  useCollaborationStore((s) => s.clearUserAnswerDrafts);
