"use client";

import { useCallback, useMemo, useState } from "react";
import { useSpawnSessions } from "@/lib/chat-spawning/mutations";
import type {
  ProposedSession,
  SpawnAgent,
  SpawnMode,
  SpawnProposal,
  SpawnResult,
} from "@/lib/chat-spawning/schemas";

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
  included: boolean;
}

/** The free-text / picker fields edited via `updateField` (excludes `included`). */
export type EditableField =
  | "name"
  | "target"
  | "agent"
  | "mode"
  | "initialPrompt";

/** Project a validated proposal into editable rows (pure). All included by default. */
export function toEditableSessions(proposal: SpawnProposal): EditableSession[] {
  return proposal.sessions.map((s) => ({
    name: s.name,
    target: s.target,
    agent: s.agent,
    mode: s.mode,
    initialPrompt: s.initialPrompt ?? "",
    included: true,
  }));
}

/** Apply a single-field edit at an index, returning a new list (pure). */
export function updateEditableSession(
  sessions: EditableSession[],
  index: number,
  field: EditableField,
  value: string,
): EditableSession[] {
  return sessions.map((s, i) => (i === index ? { ...s, [field]: value } : s));
}

/** Toggle whether the session at `index` will be created (pure). */
export function setSessionIncluded(
  sessions: EditableSession[],
  index: number,
  included: boolean,
): EditableSession[] {
  return sessions.map((s, i) => (i === index ? { ...s, included } : s));
}

/**
 * Map edited rows back to a submit-ready proposal (pure). Only included
 * sessions are emitted. Trims text; an empty `initialPrompt` becomes absent (the
 * optional schema field); an empty `target` falls back to "main" (the schema
 * default). No branch is emitted — the server derives it from the name.
 */
export function toSpawnProposal(sessions: EditableSession[]): SpawnProposal {
  return {
    sessions: sessions
      .filter((s) => s.included)
      .map((s): ProposedSession => {
        const initialPrompt = s.initialPrompt.trim();
        return {
          name: s.name.trim(),
          target: s.target.trim() || "main",
          agent: s.agent,
          mode: s.mode,
          ...(initialPrompt.length > 0 ? { initialPrompt } : {}),
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
}

export interface UseSpawnCardResult {
  editing: boolean;
  toggleEditing: () => void;
  draft: EditableSession[];
  updateField: (index: number, field: EditableField, value: string) => void;
  setIncluded: (index: number, included: boolean) => void;
  includedCount: number;
  expanded: Record<number, boolean>;
  toggleExpanded: (index: number) => void;
  submit: () => void;
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
  const { projectName, conversationId, proposal } = input;
  const mutation = useSpawnSessions(projectName, conversationId);
  const [editing, setEditing] = useState(false);
  const initialDraft = useMemo(() => toEditableSessions(proposal), [proposal]);
  const [draft, setDraft] = useState<EditableSession[]>(initialDraft);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const updateField = useCallback(
    (index: number, field: EditableField, value: string) => {
      setDraft((prev) => updateEditableSession(prev, index, field, value));
    },
    [],
  );

  const setIncluded = useCallback((index: number, included: boolean) => {
    setDraft((prev) => setSessionIncluded(prev, index, included));
  }, []);

  const toggleEditing = useCallback(() => setEditing((e) => !e), []);

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((prev) => ({ ...prev, [index]: !prev[index] }));
  }, []);

  const submit = useCallback(() => {
    mutation.mutate(toSpawnProposal(draft));
    setEditing(false);
  }, [draft, mutation]);

  const includedCount = draft.filter((s) => s.included).length;

  return {
    editing,
    toggleEditing,
    draft,
    updateField,
    setIncluded,
    includedCount,
    expanded,
    toggleExpanded,
    submit,
    isPending: mutation.isPending,
    isError: mutation.isError,
    result: mutation.data,
  };
}
