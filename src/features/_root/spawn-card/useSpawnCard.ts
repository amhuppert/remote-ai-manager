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
 * A proposed session in editable form. `initialPrompt` is a plain string ("" =
 * none) so the edit form can bind a controlled input; `toSpawnProposal` maps it
 * back to the optional schema field.
 */
export interface EditableSession {
  name: string;
  branch: string;
  target: string;
  agent: SpawnAgent;
  mode: SpawnMode;
  initialPrompt: string;
}

export type EditableField = keyof EditableSession;

/** Project a validated proposal into editable rows (pure). */
export function toEditableSessions(proposal: SpawnProposal): EditableSession[] {
  return proposal.sessions.map((s) => ({
    name: s.name,
    branch: s.branch,
    target: s.target,
    agent: s.agent,
    mode: s.mode,
    initialPrompt: s.initialPrompt ?? "",
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

/**
 * Map edited rows back to a submit-ready proposal (pure). Trims text; an empty
 * `initialPrompt` becomes absent (the optional schema field); an empty `target`
 * falls back to "main" (the schema default).
 */
export function toSpawnProposal(sessions: EditableSession[]): SpawnProposal {
  return {
    sessions: sessions.map((s): ProposedSession => {
      const initialPrompt = s.initialPrompt.trim();
      return {
        name: s.name.trim(),
        branch: s.branch.trim(),
        target: s.target.trim() || "main",
        agent: s.agent,
        mode: s.mode,
        ...(initialPrompt.length > 0 ? { initialPrompt } : {}),
      };
    }),
  };
}

export interface UseSpawnCardInput {
  projectName: string;
  conversationId: string;
  proposal: SpawnProposal;
}

export interface UseSpawnCardResult {
  editing: boolean;
  startEditing: () => void;
  cancelEditing: () => void;
  draft: EditableSession[];
  updateField: (index: number, field: EditableField, value: string) => void;
  submit: () => void;
  isPending: boolean;
  isError: boolean;
  result: SpawnResult | undefined;
}

/**
 * Card hook: holds the local edit draft and submits the *current edited values*
 * (so what the user reviews is what gets created) via the spawn mutation.
 */
export function useSpawnCard(input: UseSpawnCardInput): UseSpawnCardResult {
  const { projectName, conversationId, proposal } = input;
  const mutation = useSpawnSessions(projectName, conversationId);
  const [editing, setEditing] = useState(false);
  const initialDraft = useMemo(() => toEditableSessions(proposal), [proposal]);
  const [draft, setDraft] = useState<EditableSession[]>(initialDraft);

  const updateField = useCallback(
    (index: number, field: EditableField, value: string) => {
      setDraft((prev) => updateEditableSession(prev, index, field, value));
    },
    [],
  );

  const startEditing = useCallback(() => setEditing(true), []);
  const cancelEditing = useCallback(() => {
    setDraft(initialDraft);
    setEditing(false);
  }, [initialDraft]);

  const submit = useCallback(() => {
    mutation.mutate(toSpawnProposal(draft));
    setEditing(false);
  }, [draft, mutation]);

  return {
    editing,
    startEditing,
    cancelEditing,
    draft,
    updateField,
    submit,
    isPending: mutation.isPending,
    isError: mutation.isError,
    result: mutation.data,
  };
}
