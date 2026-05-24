import { enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  GraphWorkflowVisualLayout,
  WorkflowGeneratedDraft,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
enableMapSet();

interface PersistedWorkflowDraft {
  definition: WorkflowSemanticDefinition;
  layout: GraphWorkflowVisualLayout;
}

interface GraphWorkflowBuilderStoreState {
  persistedDraft: PersistedWorkflowDraft | null;
  draftDefinition: WorkflowSemanticDefinition | null;
  draftLayout: GraphWorkflowVisualLayout | null;
  selectedContextId: string | null;
  selectedTaskId: string | null;
  dirty: boolean;
  validationErrors: WorkflowGraphValidationError[];
}

interface GraphWorkflowBuilderStoreActions {
  loadPersistedDraft: (draft: PersistedWorkflowDraft) => void;
  applyGeneratedDraft: (draft: WorkflowGeneratedDraft) => void;
  updateDefinition: (definition: WorkflowSemanticDefinition) => void;
  updateLayout: (layout: GraphWorkflowVisualLayout) => void;
  setSelectedContextId: (contextId: string | null) => void;
  setSelectedTaskId: (taskId: string | null) => void;
  setValidationErrors: (errors: WorkflowGraphValidationError[]) => void;
  markSaved: (draft: PersistedWorkflowDraft) => void;
  resetToPersisted: () => void;
}

type GraphWorkflowBuilderStore = GraphWorkflowBuilderStoreState &
  GraphWorkflowBuilderStoreActions;

function cloneDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const useGraphWorkflowBuilderStore = create<GraphWorkflowBuilderStore>()(
  immer((set) => ({
    persistedDraft: null,
    draftDefinition: null,
    draftLayout: null,
    selectedContextId: null,
    selectedTaskId: null,
    dirty: false,
    validationErrors: [],

    loadPersistedDraft: (draft) =>
      set((state) => {
        state.persistedDraft = cloneDraft(draft);
        state.draftDefinition = cloneDraft(draft.definition);
        state.draftLayout = cloneDraft(draft.layout);
        state.selectedContextId = null;
        state.selectedTaskId = null;
        state.dirty = false;
        state.validationErrors = [];
      }),

    applyGeneratedDraft: (draft) =>
      set((state) => {
        state.draftDefinition = cloneDraft(draft.definition);
        state.draftLayout = cloneDraft(draft.layout);
        state.selectedContextId = null;
        state.selectedTaskId = null;
        state.dirty = true;
        state.validationErrors = cloneDraft(draft.validationErrors);
      }),

    updateDefinition: (definition) =>
      set((state) => {
        state.draftDefinition = cloneDraft(definition);
        state.dirty = true;
      }),

    updateLayout: (layout) =>
      set((state) => {
        state.draftLayout = cloneDraft(layout);
        state.dirty = true;
      }),

    setSelectedContextId: (contextId) =>
      set((state) => {
        state.selectedContextId = contextId;
        if (contextId === null) {
          state.selectedTaskId = null;
        }
      }),

    setSelectedTaskId: (taskId) =>
      set((state) => {
        state.selectedTaskId = taskId;
      }),

    setValidationErrors: (errors) =>
      set((state) => {
        state.validationErrors = cloneDraft(errors);
      }),

    markSaved: (draft) =>
      set((state) => {
        state.persistedDraft = cloneDraft(draft);
        state.draftDefinition = cloneDraft(draft.definition);
        state.draftLayout = cloneDraft(draft.layout);
        state.dirty = false;
        state.validationErrors = [];
      }),

    resetToPersisted: () =>
      set((state) => {
        if (!state.persistedDraft) {
          state.draftDefinition = null;
          state.draftLayout = null;
          state.dirty = false;
          state.validationErrors = [];
          state.selectedContextId = null;
          state.selectedTaskId = null;
          return;
        }

        state.draftDefinition = cloneDraft(state.persistedDraft.definition);
        state.draftLayout = cloneDraft(state.persistedDraft.layout);
        state.dirty = false;
        state.validationErrors = [];
        state.selectedContextId = null;
        state.selectedTaskId = null;
      }),
  })),
);

export { useGraphWorkflowBuilderStore as _useGraphWorkflowBuilderStore };
