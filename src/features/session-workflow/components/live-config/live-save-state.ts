import type { ConfigSaveState } from "@/components/workflow-config-panel/types";

/**
 * Which of the save bar's six states the live host is in (README §8.2).
 *
 * The signals arrive from three unrelated places — the draft's own dirtiness,
 * the runtime-edit mutation's pending/settled flags, and the server's refusal —
 * and only their ORDER decides what the author is told. That order is the whole
 * content of this module, which is why it is a pure function rather than a
 * ternary inside the panel: "a refusal outranks a fresh edit" and "a fresh edit
 * outranks a landed save" are behavioural claims a test can hold.
 */
export interface LiveSaveSignals {
  /** The draft differs from the baseline it was seeded against. */
  dirty: boolean;
  /** A runtime-edit submission is in flight. */
  saving: boolean;
  /** The last submission was refused as a `revision_conflict`. */
  conflict: boolean;
  /** A non-conflict refusal, in the server's own words. Empty reads as none. */
  error: string | null;
  /** The last submission landed. */
  succeeded: boolean;
}

export function liveSaveState({
  dirty,
  saving,
  conflict,
  error,
  succeeded,
}: LiveSaveSignals): ConfigSaveState {
  // In-flight first: a retry answers the refusal it is retrying, so keeping the
  // refusal up would describe a request that is already gone.
  if (saving) return "saving";
  // Then the refusals, ABOVE `dirty`: edits survive a failed save, so the
  // author is expected to still be editing — dropping to `dirty` would take the
  // retry copy and the server's message away exactly when they are being acted
  // on. The conflict outranks a generic error because it is the more specific
  // account of the same failed submission.
  if (conflict) return "conflict";
  if (error !== null && error !== "") return "error";
  // Then a fresh edit, ABOVE `saved`: the saved state disables Save, so leaving
  // it up over new work would strand that work behind a disabled button.
  if (dirty) return "dirty";
  if (succeeded) return "saved";
  return "clean";
}
