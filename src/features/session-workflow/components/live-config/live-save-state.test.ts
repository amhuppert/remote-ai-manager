/**
 * The live save bar's state machine (README §8.2).
 *
 * Every case here is a precedence claim: which of two simultaneously-true
 * signals the author is shown. They matter because the losing signal's chrome
 * disappears — a conflict that lost to `dirty` would take the retry copy with
 * it, and a `saved` that beat a fresh keystroke would leave the author looking
 * at a disabled Save with unsaved work in the editor.
 */
import { describe, expect, it } from "vitest";
import { liveSaveState, type LiveSaveSignals } from "./live-save-state";

function signals(overrides: Partial<LiveSaveSignals> = {}): LiveSaveSignals {
  return {
    dirty: false,
    saving: false,
    conflict: false,
    error: null,
    succeeded: false,
    ...overrides,
  };
}

describe("liveSaveState", () => {
  it("reports clean when nothing has happened", () => {
    expect(liveSaveState(signals())).toBe("clean");
  });

  it("reports dirty once the draft diverges", () => {
    expect(liveSaveState(signals({ dirty: true }))).toBe("dirty");
  });

  it("reports saving while a submission is in flight", () => {
    expect(liveSaveState(signals({ dirty: true, saving: true }))).toBe(
      "saving",
    );
  });

  it("shows the in-flight retry rather than the refusal it is retrying", () => {
    // Otherwise a retry after a conflict would keep the conflict alert up while
    // the request it answers is already running.
    expect(
      liveSaveState(signals({ dirty: true, saving: true, conflict: true })),
    ).toBe("saving");
    expect(
      liveSaveState(signals({ dirty: true, saving: true, error: "refused" })),
    ).toBe("saving");
  });

  it("keeps the conflict state while the author edits after the refusal", () => {
    // The edits survive a conflict, so editing more is expected — and the retry
    // copy has to stay until a retry actually happens.
    expect(liveSaveState(signals({ dirty: true, conflict: true }))).toBe(
      "conflict",
    );
  });

  it("keeps the server's refusal up while the author edits after it", () => {
    expect(liveSaveState(signals({ dirty: true, error: "refused" }))).toBe(
      "error",
    );
  });

  it("prefers the conflict over a stale generic error", () => {
    expect(liveSaveState(signals({ conflict: true, error: "refused" }))).toBe(
      "conflict",
    );
  });

  it("reports saved once a landed submission left the draft clean", () => {
    expect(liveSaveState(signals({ succeeded: true }))).toBe("saved");
  });

  it("returns to dirty when the author edits again after a save landed", () => {
    // The saved state disables Save and offers Resume; leaving it up over a
    // fresh edit would strand that edit behind a disabled button.
    expect(liveSaveState(signals({ succeeded: true, dirty: true }))).toBe(
      "dirty",
    );
  });

  it("treats an empty error string as no error at all", () => {
    expect(liveSaveState(signals({ error: "" }))).toBe("clean");
    expect(liveSaveState(signals({ error: "", dirty: true }))).toBe("dirty");
  });
});
