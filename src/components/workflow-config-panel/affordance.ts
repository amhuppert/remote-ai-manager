import { outputSchemaSaveBlockReason } from "./schema-lint";
import type {
  ConfigAffordance,
  ConfigPanelHost,
  ConfigReadOnlyReason,
  ConfigSaveState,
} from "./types";

/**
 * What the execution host is allowed to say and offer, as a pure function of
 * the affordance and the save state (design README §8).
 *
 * The panel itself classifies nothing: the mounting page hands it the verdict
 * `classifyExecutionEditability` already produced. What this module owns is the
 * copy that verdict earns and which controls come with it — so the banner, the
 * alert and the save bar cannot drift apart across the two hosts.
 */

/** The classifier's not-editable reasons, in the author's own terms. */
export const READ_ONLY_REASON_TEXT: Record<ConfigReadOnlyReason, string> = {
  completed: "This execution has completed and can no longer be edited.",
  aborted: "This execution was aborted and can no longer be edited.",
  "halt-not-resumable":
    "This execution halted with a non-resumable reason and can no longer be edited.",
  "awaiting-definition-approval":
    "This plan is parked awaiting definition approval; approve or reject it before editing.",
};

export interface ConfigBannerDescriptor {
  text: string;
  icon: "lock" | "pause";
  tone: "neutral" | "amber";
  /** The one banner with a way out names it here. */
  actionLabel: string | null;
}

export interface ConfigSaveBarDescriptor {
  saveLabel: string;
  saveDisabled: boolean;
  note: string;
  noteTone: "muted" | "amber" | "green" | "red";
  showResume: boolean;
  /** Rendered `role="alert"` above the body when the save did not land. */
  alertText: string | null;
}

/** Anything but `editable` disables every editor on the surface. */
export function isConfigLocked(affordance: ConfigAffordance): boolean {
  return affordance !== "editable";
}

export function configAffordanceBanner({
  host,
  affordance,
  readOnlyReason = "completed",
}: {
  host: ConfigPanelHost;
  affordance: ConfigAffordance;
  readOnlyReason?: ConfigReadOnlyReason;
}): ConfigBannerDescriptor | null {
  // The builder edits a saved template, which no execution state can lock.
  if (host !== "execution") return null;
  switch (affordance) {
    case "editable":
      return null;
    case "frozen":
      return {
        text: "This context has completed — its configuration is frozen.",
        icon: "lock",
        tone: "neutral",
        actionLabel: null,
      };
    case "pause-to-edit":
      return {
        text: "This context is in progress. Pause the workflow to edit it.",
        icon: "pause",
        tone: "amber",
        actionLabel: "Pause to edit",
      };
    case "read-only":
      return {
        text: READ_ONLY_REASON_TEXT[readOnlyReason],
        icon: "lock",
        tone: "neutral",
        actionLabel: null,
      };
  }
}

export function configSaveBar({
  host,
  affordance,
  saveState,
  blockedReason = null,
  errorMessage,
  resumable = false,
  voiceBusy = false,
}: {
  host: ConfigPanelHost;
  affordance: ConfigAffordance;
  saveState: ConfigSaveState;
  /**
   * Why a validation refuses this draft before it is ever submitted (§8.2) —
   * the refusing module's own sentence, or null when nothing blocks. A reason
   * rather than a flag because the two blocking validations (output schema
   * text, placement) send the author to different screens.
   */
  blockedReason?: string | null;
  errorMessage?: string;
  /**
   * The execution can actually be resumed — it is paused or halted. Default
   * FALSE, because an unstarted context is editable while its execution is
   * still running: `saved` is reachable with nothing to resume, and offering
   * the action there would fire the resume mutation at a live execution.
   */
  resumable?: boolean;
  /**
   * A dictation is still settling into one of the panel's prose editors. The
   * draft is not dirty yet — the text has not been delivered — so Save stays
   * reachable anyway: it is how the author stops and submits. Reachable, and
   * therefore subject to `blockedReason` like every other reachable state.
   */
  voiceBusy?: boolean;
}): ConfigSaveBarDescriptor | null {
  if (host !== "execution" || isConfigLocked(affordance)) return null;

  const idle = {
    saveLabel: "Save changes",
    showResume: false,
    alertText: null,
  } as const;

  /**
   * A pre-submission refusal outranks whatever else the state would say, in
   * EVERY state that leaves Save reachable. The state machine ranks a failed
   * save above a fresh edit, so a blocked draft after a conflict or a server
   * refusal lands here rather than in `dirty` — and without this the button
   * would stay enabled over a draft the host will silently refuse to submit.
   */
  const blockedNote = {
    saveDisabled: true,
    note: `Blocked: ${blockedReason}`,
    noteTone: "red",
  } as const;

  switch (saveState) {
    case "clean":
      // Dictating is the ONE clean state that leaves Save reachable, so it is
      // the one that a blocker has to reach as well: "Save to submit" over a
      // save that cannot submit is the false promise, and stopping the
      // dictation through it would land the text with nothing saved. An idle
      // clean draft is left alone — Save is already disabled there, and naming
      // a blocker (a sibling context's in-flight save, say) would announce
      // someone else's business on a panel with nothing to save.
      if (voiceBusy && blockedReason !== null)
        return { ...idle, ...blockedNote };
      return {
        ...idle,
        saveDisabled: !voiceBusy,
        note: voiceBusy ? "Dictating — Save to submit" : "No unsaved changes",
        noteTone: "muted",
      };
    case "dirty":
      return {
        ...idle,
        saveDisabled: blockedReason !== null,
        note:
          blockedReason === null
            ? "Unsaved changes"
            : `Blocked: ${blockedReason}`,
        noteTone: blockedReason === null ? "amber" : "red",
      };
    case "saving":
      return {
        ...idle,
        saveLabel: "Saving…",
        saveDisabled: true,
        note: resumable
          ? "Applying to the paused execution"
          : "Applying to the execution",
        noteTone: "muted",
      };
    case "saved":
      return {
        ...idle,
        saveDisabled: true,
        note: resumable ? "Saved — the execution is still paused" : "Saved",
        noteTone: "green",
        showResume: resumable,
      };
    case "conflict":
      return {
        ...idle,
        ...(blockedReason === null
          ? {
              saveDisabled: false,
              note: "Retry after reviewing",
              noteTone: "red" as const,
            }
          : blockedNote),
        alertText:
          "The execution changed since you started editing. Review your changes and retry.",
      };
    case "error":
      return {
        ...idle,
        ...(blockedReason === null
          ? {
              saveDisabled: false,
              note: "Save failed",
              noteTone: "red" as const,
            }
          : blockedNote),
        // The server's own message is the whole point of this state; without
        // one the alert still has to exist, so it falls back to the note.
        alertText: errorMessage ?? "Save failed",
      };
  }
}

/**
 * Whether the draft's output schema stops the save, for callers that only need
 * the verdict and carry their own copy (the builder's lint list names the
 * refusal itself through `describeOutputSchemaRefusal`).
 *
 * Delegates to `outputSchemaSaveBlockReason` rather than re-reading the lint
 * stages: what counts as an unacceptable schema is one decision, and a second
 * spelling of it here would be free to drift from the sentence the save bar
 * shows. An empty contract stays a legitimate choice, so only a refused one
 * blocks.
 */
export function isOutputSchemaSaveBlocked(text: string): boolean {
  return outputSchemaSaveBlockReason(text) !== null;
}
