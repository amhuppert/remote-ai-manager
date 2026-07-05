// Pure decision logic for collapsing the mobile prompt composer to a single
// tap-to-expand bar when it is idle, so reading the conversation owns the
// screen. Kept side-effect-free and unit-tested; the component owns the focus
// and latch effects that feed it.

export interface ComposerIdleInput {
  promptText: string;
  pendingImageCount: number;
  isRecording: boolean;
  /** The /collab config chip is showing — the user is mid-composition. */
  hasCollabChip: boolean;
  /** The editor cannot accept input (read-only session or a live collab). */
  inputInert: boolean;
}

// Idle = nothing worth keeping expanded for. An inert editor is always idle:
// there is nothing to type, so the composer may as well collapse and give the
// space back to the conversation.
export function computeComposerIdle(input: ComposerIdleInput): boolean {
  if (input.inputInert) return true;
  return (
    input.promptText.trim() === "" &&
    input.pendingImageCount === 0 &&
    !input.isRecording &&
    !input.hasCollabChip
  );
}

export interface ComposerCollapseInput {
  isMobile: boolean;
  idle: boolean;
  composerFocused: boolean;
  /** Held true from tap until focus lands, preventing a collapse flicker. */
  expandLatch: boolean;
}

export function computeComposerCollapsed(
  input: ComposerCollapseInput,
): boolean {
  return (
    input.isMobile && input.idle && !input.composerFocused && !input.expandLatch
  );
}
