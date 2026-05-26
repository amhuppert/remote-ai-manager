/**
 * Resolve a stable, non-empty display label for a conversation, applying the
 * fallback chain: name → summary → firstPromptSnippet → conversationId.
 *
 * Whitespace-only or empty strings are treated as absent. Newlines and
 * tabs are flattened to single spaces and runs of whitespace collapsed.
 */
export interface DisplayLabelInput {
  conversationName: string | null;
  summary: string | null;
  firstPromptSnippet: string | null;
  conversationId: string;
}

export function resolveDisplayLabel(input: DisplayLabelInput): string {
  const candidates = [
    input.conversationName,
    input.summary,
    input.firstPromptSnippet,
  ];
  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (normalized !== null) return normalized;
  }
  return input.conversationId;
}

function normalize(value: string | null): string | null {
  if (value === null) return null;
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > 0 ? flattened : null;
}
