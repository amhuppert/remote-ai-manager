/**
 * The execution host's chrome as a pure contract: which banner an affordance
 * raises, and what the save bar says in each of its six states
 * (design README §8.1, §8.2; Config Panel prototype `banner()` / `saveBar()`).
 */
import { describe, expect, it } from "vitest";
import {
  configAffordanceBanner,
  configSaveBar,
  READ_ONLY_REASON_TEXT,
} from "./affordance";
import type { ConfigAffordance, ConfigSaveState } from "./types";

const ALL_AFFORDANCES: readonly ConfigAffordance[] = [
  "editable",
  "pause-to-edit",
  "frozen",
  "read-only",
];

const ALL_SAVE_STATES: readonly ConfigSaveState[] = [
  "clean",
  "dirty",
  "saving",
  "saved",
  "conflict",
  "error",
];

describe("configAffordanceBanner", () => {
  it("never raises a banner on the builder host", () => {
    for (const affordance of ALL_AFFORDANCES) {
      expect(
        configAffordanceBanner({ host: "builder", affordance }),
      ).toBeNull();
    }
  });

  it("says nothing while the context is editable", () => {
    expect(
      configAffordanceBanner({ host: "execution", affordance: "editable" }),
    ).toBeNull();
  });

  it("locks a completed context with the frozen copy", () => {
    expect(
      configAffordanceBanner({ host: "execution", affordance: "frozen" }),
    ).toEqual({
      text: "This context has completed — its configuration is frozen.",
      icon: "lock",
      tone: "neutral",
      actionLabel: null,
    });
  });

  it("offers the way out when the context is in progress", () => {
    expect(
      configAffordanceBanner({
        host: "execution",
        affordance: "pause-to-edit",
      }),
    ).toEqual({
      text: "This context is in progress. Pause the workflow to edit it.",
      icon: "pause",
      tone: "amber",
      actionLabel: "Pause to edit",
    });
  });

  it("carries the classifier's own reason verbatim when the run is read-only", () => {
    expect(READ_ONLY_REASON_TEXT).toEqual({
      completed: "This execution has completed and can no longer be edited.",
      aborted: "This execution was aborted and can no longer be edited.",
      "halt-not-resumable":
        "This execution halted with a non-resumable reason and can no longer be edited.",
      "awaiting-definition-approval":
        "This plan is parked awaiting definition approval; approve or reject it before editing.",
    });

    for (const [reason, text] of Object.entries(READ_ONLY_REASON_TEXT)) {
      expect(
        configAffordanceBanner({
          host: "execution",
          affordance: "read-only",
          readOnlyReason: reason as keyof typeof READ_ONLY_REASON_TEXT,
        }),
      ).toEqual({ text, icon: "lock", tone: "neutral", actionLabel: null });
    }
  });

  it("falls back to the completed reason when none was classified", () => {
    expect(
      configAffordanceBanner({ host: "execution", affordance: "read-only" })
        ?.text,
    ).toBe(READ_ONLY_REASON_TEXT.completed);
  });
});

describe("configSaveBar", () => {
  it("never offers a save bar on the builder host", () => {
    for (const saveState of ALL_SAVE_STATES) {
      expect(
        configSaveBar({ host: "builder", affordance: "editable", saveState }),
      ).toBeNull();
    }
  });

  it("withholds the save bar whenever the context is not editable", () => {
    for (const affordance of [
      "pause-to-edit",
      "frozen",
      "read-only",
    ] as const) {
      expect(
        configSaveBar({ host: "execution", affordance, saveState: "dirty" }),
      ).toBeNull();
    }
  });

  it("disables save with nothing to apply", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "clean",
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: true,
      note: "No unsaved changes",
      noteTone: "muted",
      showResume: false,
      alertText: null,
    });
  });

  it("enables save once the draft is dirty", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "dirty",
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: false,
      note: "Unsaved changes",
      noteTone: "amber",
      showResume: false,
      alertText: null,
    });
  });

  it("blocks a dirty draft and names the refusal it is blocked on", () => {
    // AC save-blocked: "cannot save" is not actionable on its own — the note
    // carries the blocking module's own sentence so the author knows which of
    // the two validations (schema text, placement) to go fix.
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "dirty",
        blockedReason: "The output schema cannot be parsed.",
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: true,
      note: "Blocked: The output schema cannot be parsed.",
      noteTone: "red",
      showResume: false,
      alertText: null,
    });
  });

  it("carries a placement refusal just as verbatim as a schema one", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "dirty",
        blockedReason: "This placement is not a legal declaration.",
      })?.note,
    ).toBe("Blocked: This placement is not a legal declaration.");
  });

  it("leaves an idle draft alone — it is already disabled, so a blocker is noise", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "clean",
        blockedReason: "The output schema cannot be parsed.",
      })?.note,
    ).toBe("No unsaved changes");
  });

  it("keeps Save reachable while a dictation is still settling", () => {
    // The draft is not dirty — the text has not been delivered yet — and Save
    // is how the author stops the dictation and submits it in one act.
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "clean",
        voiceBusy: true,
      }),
    ).toMatchObject({
      saveDisabled: false,
      note: "Dictating — Save to submit",
    });
  });

  it("withdraws the dictation promise when the save is blocked", () => {
    // The one clean state that leaves Save REACHABLE, so the blocked reason has
    // to reach it too: "Save to submit" over a save that cannot submit is the
    // false promise, whether the blocker is the draft itself or a sibling
    // context holding the one shared runtime-edit mutation.
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "clean",
        voiceBusy: true,
        blockedReason: "Another edit on this execution is still saving.",
      }),
    ).toMatchObject({
      saveDisabled: true,
      note: "Blocked: Another edit on this execution is still saving.",
      noteTone: "red",
    });
  });

  it("names the paused execution while the save is in flight", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "saving",
      }),
    ).toEqual({
      saveLabel: "Saving…",
      saveDisabled: true,
      note: "Applying to the execution",
      noteTone: "muted",
      showResume: false,
      alertText: null,
    });
  });

  it("offers the resume once the edit landed on a paused run", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "saved",
        resumable: true,
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: true,
      note: "Saved — the execution is still paused",
      noteTone: "green",
      showResume: true,
      alertText: null,
    });
  });

  it("never offers a resume for an execution that is already running", () => {
    // An unstarted context is editable while the run is going, so `saved` is
    // reachable with nothing to resume — and the resume mutation would be
    // fired at a live execution.
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "saved",
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: true,
      note: "Saved",
      noteTone: "green",
      showResume: false,
      alertText: null,
    });
  });

  it("does not claim the execution is paused while saving unless it is", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "saving",
      })?.note,
    ).toBe("Applying to the execution");
  });

  it("keeps Save disabled and names the blocker after a conflict", () => {
    // AC save-blocked: a refusal outranks a fresh edit in the state machine, so
    // without this the blocked draft would show the retry note with Save
    // enabled — and the click would be silently swallowed.
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "conflict",
        blockedReason: "The output schema cannot be parsed.",
      }),
    ).toMatchObject({
      saveDisabled: true,
      note: "Blocked: The output schema cannot be parsed.",
      alertText:
        "The execution changed since you started editing. Review your changes and retry.",
    });
  });

  it("keeps Save disabled and names the blocker after a server refusal", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "error",
        errorMessage: "Live edit refused: lane delivery is mid-merge.",
        blockedReason: "This placement is not a legal declaration.",
      }),
    ).toMatchObject({
      saveDisabled: true,
      note: "Blocked: This placement is not a legal declaration.",
      alertText: "Live edit refused: lane delivery is mid-merge.",
    });
  });

  it("keeps save reachable after a revision conflict and states what changed", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "conflict",
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: false,
      note: "Retry after reviewing",
      noteTone: "red",
      showResume: false,
      alertText:
        "The execution changed since you started editing. Review your changes and retry.",
    });
  });

  it("shows the server's own refusal on a save error", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "error",
        errorMessage:
          "Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry.",
      }),
    ).toEqual({
      saveLabel: "Save changes",
      saveDisabled: false,
      note: "Save failed",
      noteTone: "red",
      showResume: false,
      alertText:
        "Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry.",
    });
  });

  it("still raises an alert when the server sent no message", () => {
    expect(
      configSaveBar({
        host: "execution",
        affordance: "editable",
        saveState: "error",
      })?.alertText,
    ).toBe("Save failed");
  });
});
