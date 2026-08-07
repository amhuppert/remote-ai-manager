import type { z } from "zod";
import {
  storedConversationStateSchema,
  type ConversationState,
} from "../schemas";

/**
 * Overrides accept the schema's INPUT shape, so every field with a
 * `.default()` is optional here even though `z.infer` requires it on the
 * output type — that asymmetry is why hand-written `ConversationState`
 * literals cost an edit in every fixture whenever a field is added (audit
 * 1beec403: 49 sites for one field), and why this factory parses instead.
 */
export type ConversationStateOverrides = Partial<
  z.input<typeof storedConversationStateSchema>
>;

/**
 * Shared test/story factory for a stored conversation aggregate. Construction
 * goes through `storedConversationStateSchema.parse`, so schema defaults fill
 * every field the caller does not name and a new defaulted field costs zero
 * fixture edits. Local suite factories should delegate here, passing only the
 * fields their tests actually depend on.
 */
export function makeConversationState(
  overrides: ConversationStateOverrides = {},
): ConversationState {
  return storedConversationStateSchema.parse({
    // Only the fields without schema defaults need base values.
    id: "conv-1",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    // `.nullable().optional()` with no default — but a STORED row is null
    // (legacy) or a snapshot, never absent, so the fixture writes the
    // production-shaped explicit null.
    profileSnapshot: null,
    ...overrides,
  });
}
