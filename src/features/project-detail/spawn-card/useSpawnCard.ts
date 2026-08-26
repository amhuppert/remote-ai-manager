"use client";

import { useCallback, useMemo, useState } from "react";
import { useSpawnSessions } from "@/lib/chat-spawning/mutations";
import {
  spawnAgentSchema,
  type ProposedSession,
  type SpawnAgent,
  type SpawnMode,
  type SpawnProposal,
  type SpawnResult,
} from "@/lib/chat-spawning/schemas";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";

/**
 * A proposed session in editable form. The branch is intentionally absent — CC
 * derives it from `name` server-side (slug + prefix), so the card only ever
 * shows a preview. `initialPrompt` is a plain string ("" = none) so the edit
 * form can bind a controlled input; `toSpawnProposal` maps it back to the
 * optional schema field. `included` drives the per-session create toggle: only
 * included sessions are submitted.
 */
export interface EditableSession {
  name: string;
  target: string;
  agent: SpawnAgent;
  mode: SpawnMode;
  initialPrompt: string;
  images?: ImagePayload[];
  /** The complete first-turn model variant; absent for the composite dual race. */
  modelSelection: BackendModelSelection | null;
  included: boolean;
}

/** The free-text / picker fields edited via `updateField` (excludes `included`). */
export type EditableField =
  | "name"
  | "target"
  | "agent"
  | "mode"
  | "initialPrompt";

/**
 * The concrete backend a single-backend agent runs on; `null` for the `dual`
 * race — two backends, so there is no single valid model selection. The card
 * hides the model controls and omits the selection on submit when null.
 */
export function backendForAgent(agent: SpawnAgent): AgentBackendId | null {
  // `dual` is the only non-backend member of `SpawnAgent` (it is derived from
  // the canonical backend enum plus that one literal), so excluding it leaves a
  // registered backend. Naming the backends here instead would silently hide
  // the model controls for every backend registered afterwards.
  return agent === "dual" ? null : agent;
}

function cloneSelection(
  selection: BackendModelSelection,
): BackendModelSelection {
  return {
    modelId: selection.modelId,
    parameters: { ...selection.parameters },
  };
}

/** Configured complete selection for an agent; dual has no single selection. */
function modelSelectionDefault(
  agent: SpawnAgent,
  backendDefaults?: BackendSelectionDefaultsById,
): BackendModelSelection | null {
  const backend = backendForAgent(agent);
  if (backend === null) return null;
  const configured = backendDefaults?.[backend];
  if (configured !== undefined) return cloneSelection(configured);
  const catalog = getConfiguredBackendModelCatalog(backend);
  return defaultSelectionForModel(catalog, catalog.defaultModelId);
}

/** Project a validated proposal into editable rows (pure). All included by default. */
export function toEditableSessions(
  proposal: SpawnProposal,
  backendDefaults?: BackendSelectionDefaultsById,
): EditableSession[] {
  return proposal.sessions.map((s) => {
    const modelSelection =
      s.modelSelection === undefined
        ? modelSelectionDefault(s.agent, backendDefaults)
        : cloneSelection(s.modelSelection);
    return {
      name: s.name,
      target: s.target,
      agent: s.agent,
      mode: s.mode,
      initialPrompt: s.initialPrompt ?? "",
      images: s.images ?? [],
      modelSelection,
      included: true,
    };
  });
}

/** Reset the complete selection to the new agent's backend default. */
function applyAgentChange(
  s: EditableSession,
  value: string,
  backendDefaults?: BackendSelectionDefaultsById,
): EditableSession {
  const parsed = spawnAgentSchema.safeParse(value);
  const agent = parsed.success ? parsed.data : s.agent;
  return {
    ...s,
    agent,
    modelSelection: modelSelectionDefault(agent, backendDefaults),
  };
}

/**
 * Apply a single-field edit at an index, returning a new list (pure). An agent
 * change resets the complete model selection to the new backend's default.
 */
export function updateEditableSession(
  sessions: EditableSession[],
  index: number,
  field: EditableField,
  value: string,
  backendDefaults?: BackendSelectionDefaultsById,
): EditableSession[] {
  return sessions.map((s, i) => {
    if (i !== index) return s;
    if (field === "agent") return applyAgentChange(s, value, backendDefaults);
    return { ...s, [field]: value };
  });
}

/** Replace one row's model selection as a single indivisible value. */
export function setSessionModelSelection(
  sessions: EditableSession[],
  index: number,
  modelSelection: BackendModelSelection,
): EditableSession[] {
  return sessions.map((session, currentIndex) =>
    currentIndex === index
      ? { ...session, modelSelection: cloneSelection(modelSelection) }
      : session,
  );
}

/** Toggle whether the session at `index` will be created (pure). */
export function setSessionIncluded(
  sessions: EditableSession[],
  index: number,
  included: boolean,
): EditableSession[] {
  return sessions.map((s, i) => (i === index ? { ...s, included } : s));
}

export function setSessionImages(
  sessions: EditableSession[],
  index: number,
  images: ImagePayload[],
): EditableSession[] {
  const current = sessions[index]?.images ?? [];
  const unchanged =
    current.length === images.length &&
    current.every((image, imageIndex) => {
      const next = images[imageIndex];
      return (
        next !== undefined &&
        image.attachmentId === next.attachmentId &&
        image.mediaType === next.mediaType &&
        image.base64Data === next.base64Data &&
        image.inlineMarkerIndex === next.inlineMarkerIndex
      );
    });
  if (unchanged) return sessions;
  return sessions.map((session, currentIndex) =>
    currentIndex === index ? { ...session, images } : session,
  );
}

export function applyPromptDocument(
  sessions: EditableSession[],
  index: number,
  document: SerializedPromptDoc,
): EditableSession[] {
  const withPrompt = updateEditableSession(
    sessions,
    index,
    "initialPrompt",
    document.prompt,
  );
  return setSessionImages(withPrompt, index, document.images);
}

/**
 * Map edited rows back to a submit-ready proposal (pure). Only included
 * sessions are emitted. Trims text; an empty `initialPrompt` becomes absent (the
 * optional schema field); an empty `target` falls back to "main" (the schema
 * default). No branch is emitted — the server derives it from the name. The
 * complete model selection is emitted only for a single-backend agent; the
 * `dual` race runs both participants at their backend defaults.
 */
export function toSpawnProposal(sessions: EditableSession[]): SpawnProposal {
  return {
    sessions: sessions
      .filter((s) => s.included)
      .map((s): ProposedSession => {
        const initialPrompt = s.initialPrompt.trim();
        const backend = backendForAgent(s.agent);
        return {
          name: s.name.trim(),
          target: s.target.trim() || "main",
          agent: s.agent,
          mode: s.mode,
          ...(initialPrompt.length > 0 ? { initialPrompt } : {}),
          ...(s.images && s.images.length > 0 ? { images: s.images } : {}),
          ...(backend !== null && s.modelSelection !== null
            ? { modelSelection: cloneSelection(s.modelSelection) }
            : {}),
        };
      }),
  };
}

/** Default character budget before an initial prompt is collapsed behind "Show more". */
export const PROMPT_TRUNCATE_LIMIT = 92;

/**
 * Collapse a long initial prompt to a word-boundary-trimmed preview (pure).
 * `long` is true when the prompt exceeds the limit; `display` is the full prompt
 * when short or expanded, otherwise the truncated preview with an ellipsis.
 */
export function summarizePrompt(
  text: string,
  expanded: boolean,
  limit: number = PROMPT_TRUNCATE_LIMIT,
): { display: string; long: boolean } {
  const long = text.length > limit;
  if (!long || expanded) return { display: text, long };
  const clipped = text.slice(0, limit).replace(/\s+\S*$/, "");
  return { display: `${clipped}…`, long };
}

export interface UseSpawnCardInput {
  projectName: string;
  conversationId: string;
  proposal: SpawnProposal;
  backendDefaults: BackendSelectionDefaultsById;
}

export interface UseSpawnCardResult {
  editing: boolean;
  toggleEditing: () => void;
  draft: EditableSession[];
  updateField: (index: number, field: EditableField, value: string) => void;
  setModelSelection(index: number, modelSelection: BackendModelSelection): void;
  setIncluded: (index: number, included: boolean) => void;
  setImages: (index: number, images: ImagePayload[]) => void;
  setPromptDocument(index: number, document: SerializedPromptDoc): void;
  includedCount: number;
  expanded: Record<number, boolean>;
  toggleExpanded: (index: number) => void;
  submit: () => void;
  submitPromptDocument(index: number, document: SerializedPromptDoc): void;
  isPending: boolean;
  isError: boolean;
  result: SpawnResult | undefined;
}

/**
 * Card hook: holds the local edit draft (including the per-session include
 * toggle and prompt-expansion state) and submits the *current edited values* of
 * the included sessions (so what the user reviews is what gets created) via the
 * spawn mutation.
 */
export function useSpawnCard(input: UseSpawnCardInput): UseSpawnCardResult {
  const { projectName, conversationId, proposal, backendDefaults } = input;
  const mutation = useSpawnSessions(projectName, conversationId);
  const [editing, setEditing] = useState(false);
  const initialDraft = useMemo(
    () => toEditableSessions(proposal, backendDefaults),
    [proposal, backendDefaults],
  );
  const [draft, setDraft] = useState<EditableSession[]>(initialDraft);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const updateField = useCallback(
    (index: number, field: EditableField, value: string) => {
      setDraft((prev) =>
        updateEditableSession(prev, index, field, value, backendDefaults),
      );
    },
    [backendDefaults],
  );

  const setIncluded = useCallback((index: number, included: boolean) => {
    setDraft((prev) => setSessionIncluded(prev, index, included));
  }, []);

  const setModelSelection = useCallback(
    (index: number, modelSelection: BackendModelSelection) => {
      setDraft((prev) => setSessionModelSelection(prev, index, modelSelection));
    },
    [],
  );

  const setImages = useCallback((index: number, images: ImagePayload[]) => {
    setDraft((prev) => setSessionImages(prev, index, images));
  }, []);

  const setPromptDocument = useCallback(
    (index: number, document: SerializedPromptDoc) => {
      setDraft((prev) => applyPromptDocument(prev, index, document));
    },
    [],
  );

  const toggleEditing = useCallback(() => setEditing((e) => !e), []);

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((prev) => ({ ...prev, [index]: !prev[index] }));
  }, []);

  const submitDraft = useCallback(
    (nextDraft: EditableSession[]) => {
      mutation.mutate(toSpawnProposal(nextDraft));
      setEditing(false);
    },
    [mutation],
  );

  const submit = useCallback(() => {
    submitDraft(draft);
  }, [draft, submitDraft]);

  const submitPromptDocument = useCallback(
    (index: number, document: SerializedPromptDoc) => {
      const nextDraft = applyPromptDocument(draft, index, document);
      setDraft(nextDraft);
      submitDraft(nextDraft);
    },
    [draft, submitDraft],
  );

  const includedCount = draft.filter((s) => s.included).length;

  return {
    editing,
    toggleEditing,
    draft,
    updateField,
    setModelSelection,
    setIncluded,
    setImages,
    setPromptDocument,
    includedCount,
    expanded,
    toggleExpanded,
    submit,
    submitPromptDocument,
    isPending: mutation.isPending,
    isError: mutation.isError,
    result: mutation.data,
  };
}
