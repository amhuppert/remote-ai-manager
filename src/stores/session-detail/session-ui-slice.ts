import {
  type SessionDetailSliceCreator,
  type SessionUiSlice,
  initialState,
} from "./types";

export const createSessionUiSlice: SessionDetailSliceCreator<SessionUiSlice> = (
  set,
) => ({
  isVoiceRecording: initialState.isVoiceRecording,
  promptPlaceholder: initialState.promptPlaceholder,
  showDeleteConfirm: initialState.showDeleteConfirm,
  pendingQuestions: initialState.pendingQuestions,
  pendingQuestionId: initialState.pendingQuestionId,
  currentQuestionIndex: initialState.currentQuestionIndex,
  messageNavRequest: initialState.messageNavRequest,

  // -- Voice recording --

  startRecording: () =>
    set((state) => {
      state.isVoiceRecording = true;
    }),

  stopRecording: () =>
    set((state) => {
      state.isVoiceRecording = false;
    }),

  // -- Command placeholder --

  showPlaceholder: (text) =>
    set((state) => {
      state.promptPlaceholder = text;
    }),

  clearPlaceholder: () =>
    set((state) => {
      state.promptPlaceholder = null;
    }),

  // -- Dialogs --

  requestDeleteSession: () =>
    set((state) => {
      state.showDeleteConfirm = true;
    }),

  cancelDeleteSession: () =>
    set((state) => {
      state.showDeleteConfirm = false;
    }),

  // -- AskUserQuestion --

  showQuestions: (questionId, questions) =>
    set((state) => {
      state.pendingQuestions = questions;
      state.pendingQuestionId = questionId;
      state.currentQuestionIndex = 0;
    }),

  navigateQuestion: (index) =>
    set((state) => {
      state.currentQuestionIndex = index;
    }),

  clearQuestions: () =>
    set((state) => {
      state.pendingQuestions = null;
      state.pendingQuestionId = null;
      state.currentQuestionIndex = 0;
    }),

  // -- Transcript message navigation --

  requestMessageNav: (conversationId, messageIndex) =>
    set((state) => {
      state.messageNavRequest = { conversationId, messageIndex };
      state.mobilePanel = "chat";
    }),

  clearMessageNavRequest: () =>
    set((state) => {
      state.messageNavRequest = null;
    }),
});
