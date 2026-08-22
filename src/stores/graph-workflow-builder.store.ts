import { enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  GraphWorkflowVisualLayout,
  WorkflowGeneratedDraft,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  defaultEphemeralLaneName,
  definitionLaneNames,
  type EphemeralLane,
} from "@/lib/workflow-graph/ephemeral-lanes";
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
  /**
   * Edits the canvas REFUSED — a self-edge, a duplicate dependency, a cycle.
   * The draft was never mutated, so no verdict about it can carry them and they
   * are not a reason to refuse a save; they are transient feedback about one
   * attempt, and the next accepted edit retires them.
   */
  refusedEdits: WorkflowGraphValidationError[];
  /**
   * Output-schema editor text the draft could not absorb, keyed by context. See
   * `output-schema-drafts.ts` — it lives with the draft because every screen
   * that could hold it is unmounted by navigation the author did not intend as
   * a discard.
   */
  pendingOutputSchemaText: Record<string, { text: string; committed: string }>;
  /**
   * Empty lanes the author has drawn (README §2.2). Deliberately BESIDE the
   * draft rather than in it: a lane exists because a context's `placement.lane`
   * names it, so an empty one has no authored form, and holding it here is what
   * keeps `+ New lane` from dirtying a definition it cannot change.
   */
  ephemeralLanes: EphemeralLane[];
}

interface GraphWorkflowBuilderStoreActions {
  loadPersistedDraft: (draft: PersistedWorkflowDraft) => void;
  applyGeneratedDraft: (draft: WorkflowGeneratedDraft) => void;
  updateDefinition: (definition: WorkflowSemanticDefinition) => void;
  updateLayout: (layout: GraphWorkflowVisualLayout) => void;
  setSelectedContextId: (contextId: string | null) => void;
  setSelectedTaskId: (taskId: string | null) => void;
  setRefusedEdits: (errors: WorkflowGraphValidationError[]) => void;
  setPendingOutputSchemaText: (
    contextId: string,
    draft: { text: string; committed: string },
  ) => void;
  addEphemeralLane: () => void;
  renameEphemeralLane: (id: string, name: string) => void;
  removeEphemeralLane: (id: string) => void;
  markSaved: (draft: PersistedWorkflowDraft) => void;
  resetToPersisted: () => void;
}

type GraphWorkflowBuilderStore = GraphWorkflowBuilderStoreState &
  GraphWorkflowBuilderStoreActions;

function cloneDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Ephemeral-lane ids are opaque and only have to be unique among the bands
 * currently on the canvas, so a monotonic counter is enough — and unlike a name
 * it survives the rename the id exists to outlive.
 */
let ephemeralLaneSeq = 0;

const useGraphWorkflowBuilderStore = create<GraphWorkflowBuilderStore>()(
  immer((set) => ({
    persistedDraft: null,
    draftDefinition: null,
    draftLayout: null,
    selectedContextId: null,
    selectedTaskId: null,
    dirty: false,
    refusedEdits: [],
    pendingOutputSchemaText: {},
    ephemeralLanes: [],

    loadPersistedDraft: (draft) =>
      set((state) => {
        state.persistedDraft = cloneDraft(draft);
        state.draftDefinition = cloneDraft(draft.definition);
        state.draftLayout = cloneDraft(draft.layout);
        state.selectedContextId = null;
        state.selectedTaskId = null;
        state.dirty = false;
        state.refusedEdits = [];
        state.pendingOutputSchemaText = {};
        state.ephemeralLanes = [];
      }),

    applyGeneratedDraft: (draft) =>
      set((state) => {
        state.draftDefinition = cloneDraft(draft.definition);
        state.draftLayout = cloneDraft(draft.layout);
        state.selectedContextId = null;
        state.selectedTaskId = null;
        state.dirty = true;
        state.refusedEdits = cloneDraft(draft.validationErrors);
        state.pendingOutputSchemaText = {};
        state.ephemeralLanes = [];
      }),

    updateDefinition: (definition) =>
      set((state) => {
        state.draftDefinition = cloneDraft(definition);
        state.dirty = true;
        // The refusal described the draft as it stood; this is a different
        // draft, so keeping it would refuse an attempt nobody made.
        state.refusedEdits = [];
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

    setRefusedEdits: (errors) =>
      set((state) => {
        state.refusedEdits = cloneDraft(errors);
      }),

    setPendingOutputSchemaText: (contextId, draft) =>
      set((state) => {
        state.pendingOutputSchemaText[contextId] = { ...draft };
      }),

    // Naming is done against every lane on the canvas at once — the draft's and
    // the bands' — because the two share one namespace: a band spelled like an
    // existing lane IS that lane (§2.2), so it can never be created as a second
    // one.
    addEphemeralLane: () =>
      set((state) => {
        ephemeralLaneSeq += 1;
        state.ephemeralLanes.push({
          id: `ephemeral-lane-${ephemeralLaneSeq}`,
          name: defaultEphemeralLaneName([
            ...definitionLaneNames(state.draftDefinition),
            ...state.ephemeralLanes.map((lane) => lane.name),
          ]),
        });
      }),

    renameEphemeralLane: (id, name) =>
      set((state) => {
        const lane = state.ephemeralLanes.find((entry) => entry.id === id);
        if (lane) lane.name = name;
      }),

    removeEphemeralLane: (id) =>
      set((state) => {
        state.ephemeralLanes = state.ephemeralLanes.filter(
          (entry) => entry.id !== id,
        );
      }),

    markSaved: (draft) =>
      set((state) => {
        state.persistedDraft = cloneDraft(draft);
        state.draftDefinition = cloneDraft(draft.definition);
        state.draftLayout = cloneDraft(draft.layout);
        state.dirty = false;
        state.refusedEdits = [];
        state.pendingOutputSchemaText = {};
        state.ephemeralLanes = [];
      }),

    resetToPersisted: () =>
      set((state) => {
        state.dirty = false;
        state.refusedEdits = [];
        state.pendingOutputSchemaText = {};
        state.ephemeralLanes = [];
        state.selectedContextId = null;
        state.selectedTaskId = null;

        if (!state.persistedDraft) {
          state.draftDefinition = null;
          state.draftLayout = null;
          return;
        }

        state.draftDefinition = cloneDraft(state.persistedDraft.definition);
        state.draftLayout = cloneDraft(state.persistedDraft.layout);
      }),
  })),
);

export { useGraphWorkflowBuilderStore as _useGraphWorkflowBuilderStore };
