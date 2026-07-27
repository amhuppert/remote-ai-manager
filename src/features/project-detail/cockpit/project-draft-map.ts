import type { SerializedPromptDoc } from "@/lib/prompt-editor";

export const PROJECT_FIRST_RUN_DRAFT_KEY = "__project-first-run__";

export type ProjectDraftMap = ReadonlyMap<string, SerializedPromptDoc>;

export function projectDraftKey(conversationId: string | null): string {
  return conversationId ?? PROJECT_FIRST_RUN_DRAFT_KEY;
}

export function hasProjectDraftContent(document: SerializedPromptDoc): boolean {
  return document.prompt.trim() !== "" || document.images.length > 0;
}

export function setProjectDraft(
  drafts: ProjectDraftMap,
  key: string,
  document: SerializedPromptDoc,
): ProjectDraftMap {
  const next = new Map(drafts);
  next.set(key, document);
  return next;
}

export function deleteProjectDraft(
  drafts: ProjectDraftMap,
  key: string,
): ProjectDraftMap {
  const next = new Map(drafts);
  next.delete(key);
  return next;
}
