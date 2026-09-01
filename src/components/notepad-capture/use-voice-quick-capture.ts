"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { voiceOwnership } from "@/hooks/use-multiline-voice";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { ApiCallError } from "@/lib/api/errors";
import {
  resolveCaptureDestination,
  type CaptureDestination,
  type CaptureDestinationInput,
} from "@/lib/notepads/capture-destination";
import { useLandCaptureMutation } from "@/lib/notepads/capture-landing";
import { useWriteNotepadContentMutation } from "@/lib/notepads/mutations";
import { notepadQueries } from "@/lib/notepads/queries";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import { useQuickTicketStore } from "@/stores/quick-ticket.store";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { pushToast } from "@/stores/toast.store";

import {
  captureConfirmationPreview,
  contentWithoutAppended,
  transcriptionContextFrom,
} from "./capture-confirmation";
import {
  ambientProjectFromRoute,
  captureDestinationName,
  quickCaptureResolution,
  type AmbientProject,
} from "./quick-capture-context";

export type QuickCapturePhase =
  | "idle"
  /** Resolving the destination; the microphone is not live yet. */
  | "preparing"
  | "recording"
  | "processing"
  /** Transcription failed; the audio is still on hand to retry (R25.4). */
  | "failed"
  /** Transcribed, but the write failed; the words are still on hand (R25.4). */
  | "landing-failed";

/** A capture that has landed, held only until the user acts on it or it fades. */
export interface QuickCaptureConfirmation {
  notepadId: string;
  notepadName: string;
  preview: string;
}

export interface VoiceQuickCaptureState {
  phase: QuickCapturePhase;
  /**
   * The notepad the capture will land in, fixed before the microphone opens.
   * Null only while the destination is still being resolved.
   */
  destinationName: string | null;
  elapsedTime: number;
  confirmation: QuickCaptureConfirmation | null;
  /** Toggle from the hotkey: start when idle, stop when recording. */
  toggle(): void;
  stop(): void;
  cancel(): void;
  /** Send the retained recording again, unchanged. */
  retry(): void;
  /** Throw the retained recording away — the only thing that ever does. */
  discard(): void;
  openLanded(): void;
  undoLanded(): void;
  dismissConfirmation(): void;
}

/**
 * The destination decided at record start, and what riding on it needs.
 *
 * Fixed for the life of one capture: the surface names this notepad before a
 * word is spoken, so a listing that re-orders, a notepad opened elsewhere, or a
 * route change mid-sentence must not move where the words end up (D21).
 */
interface CaptureSession {
  destination: CaptureDestination;
  /** What the pill shows — the destination's name at record start. */
  name: string;
  ambientProject: AmbientProject | null;
  /** The destination's text at record start, already tail-bounded. */
  context: string;
  /**
   * The date the promised name was built against, so a capture that runs over
   * midnight still lands under the name the pill showed.
   */
  today: string;
}

/** What undo needs to put a notepad back the way it was. */
interface LandedCapture extends QuickCaptureConfirmation {
  /** The appended payload, which undo trims off the notepad's current tail. */
  fragment: string;
}

/** A transcription that has not reached its notepad yet, held for a retry. */
interface PendingLanding {
  capture: CaptureSession;
  fragment: string;
}

/** The listing sort is irrelevant to the rule — it re-orders by recency itself. */
const DESTINATION_POOL_SORT = "recency" as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The destination pool, read from the server rather than the cache.
 *
 * `staleTime: 0` on purpose: the app's default keeps a listing fresh for 30
 * seconds, which is long enough for a capture to be resolved against — or
 * landed into — a notepad that has since been deleted.
 */
async function fetchDestinationPool(
  queryClient: QueryClient,
  ambientProject: AmbientProject | null,
): Promise<NotepadListItem[]> {
  return ambientProject === null
    ? await queryClient.fetchQuery({
        ...notepadQueries.globalList(DESTINATION_POOL_SORT, true),
        staleTime: 0,
      })
    : await queryClient.fetchQuery({
        ...notepadQueries.panelList(
          ambientProject.name,
          DESTINATION_POOL_SORT,
          true,
        ),
        staleTime: 0,
      });
}

/** A destination read that distinguishes "gone" from every other failure. */
const GONE = Symbol("destination-gone");

/**
 * The destination's text, to ride along as transcription context (R25.2). A
 * destination that does not exist yet has none to read; one that has been
 * deleted reports itself gone, so the caller can resolve somewhere else rather
 * than name a notepad it already knows the capture cannot land in.
 */
async function destinationContent(
  queryClient: QueryClient,
  destination: CaptureDestination,
): Promise<string | typeof GONE> {
  if (destination.kind !== "existing") return "";
  try {
    const notepad = await queryClient.fetchQuery({
      ...notepadQueries.detail(destination.id),
      staleTime: 0,
    });
    return notepad.content;
  } catch (error) {
    if (isNotFound(error)) return GONE;
    throw error;
  }
}

/**
 * What landing decides from: the destination the pill named, and a
 * re-resolution over the fresh listing only once it is genuinely gone.
 *
 * An existing destination rides in as the "open notepad", the rule's first
 * tier — `quickCaptureResolution` keeps it only while the fresh listing still
 * holds it unarchived, which is exactly the vanished-mid-capture re-resolution
 * D21 asks for. A destination still to be created rides in as its promised
 * name, which is what the pill actually showed: a notepad that took that name
 * mid-capture receives the words, and nothing else does — neither a second
 * notepad under a dodged name nor whichever notepad happened to become the
 * most recent while the user was talking.
 *
 * `abandonFrozenId` is the 404 retry, where the notepad the append was aimed
 * at turned out to be gone. Only an id can vanish like that: a promised name
 * is always re-satisfiable — by a notepad that now holds it, or by creating it
 * — so the promise survives the retry rather than dropping the capture back
 * into the recency tier and a notepad the user was never shown.
 */
function landingResolution(
  session: CaptureSession,
  listing: readonly NotepadListItem[],
  options: { abandonFrozenId: boolean },
): CaptureDestinationInput {
  const destination = session.destination;
  return quickCaptureResolution({
    ambientProject: session.ambientProject,
    openNotepadId:
      destination.kind === "existing" && !options.abandonFrozenId
        ? destination.id
        : null,
    ...(destination.kind === "create"
      ? { promisedName: destination.name }
      : {}),
    listing,
    today: session.today,
  });
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 404;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The app-global voice quick capture: one hotkey away from anywhere, recording
 * into the notepad the shared destination rule picks (D21, D22).
 *
 * Everything the capture depends on is read at the moment of the press —
 * route, conversation registry, notepad listing, destination content — rather
 * than subscribed to during render. This host is mounted on every route, so a
 * standing listing query would be a cost paid by everyone who never dictates;
 * and reading at the press is what lets the destination be fixed before the
 * microphone opens.
 */
export function useVoiceQuickCapture(): VoiceQuickCaptureState {
  const pathname = usePathname();
  const ownerId = useId();
  const queryClient = useQueryClient();
  const [preparing, setPreparing] = useState(false);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [landed, setLanded] = useState<LandedCapture | null>(null);
  const [pendingLanding, setPendingLanding] = useState<PendingLanding | null>(
    null,
  );
  const landCapture = useLandCaptureMutation();
  const writeContent = useWriteNotepadContentMutation();

  /** Read by callbacks that outlive the render that started them. */
  const sessionRef = useRef<CaptureSession | null>(null);
  /** Bumped by anything that abandons a capture, so a slow start gives up. */
  const attemptRef = useRef(0);

  const applySession = useCallback((next: CaptureSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  /**
   * Land in the destination the surface named, re-resolving only when it is
   * genuinely gone: the fresh listing answers that, and a 404 racing the check
   * gets one re-resolved retry rather than losing the transcription.
   */
  const landTranscription = useCallback(
    async (capture: CaptureSession, fragment: string) => {
      const listing = await fetchDestinationPool(
        queryClient,
        capture.ambientProject,
      );
      try {
        return await landCapture.mutateAsync({
          resolution: landingResolution(capture, listing, {
            abandonFrozenId: false,
          }),
          fragment,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const refreshed = await fetchDestinationPool(
          queryClient,
          capture.ambientProject,
        );
        return await landCapture.mutateAsync({
          resolution: landingResolution(capture, refreshed, {
            abandonFrozenId: true,
          }),
          fragment,
        });
      }
    },
    [landCapture, queryClient],
  );

  /**
   * A write that fails keeps the transcription rather than reporting it to a
   * toast and dropping it: the words the user spoke are exactly as unlosable
   * once transcribed as they were while they were still audio (R25.4).
   */
  const land = useCallback(
    async (pending: PendingLanding) => {
      try {
        const notepad = await landTranscription(
          pending.capture,
          pending.fragment,
        );
        setPendingLanding(null);
        applySession(null);
        setLanded({
          notepadId: notepad.id,
          notepadName: notepad.name,
          preview: captureConfirmationPreview(pending.fragment),
          fragment: pending.fragment,
        });
      } catch (error) {
        setPendingLanding(pending);
        pushToast(errorMessage(error, "Capture failed to land"));
      }
    },
    [applySession, landTranscription],
  );

  const handleResult = useCallback(
    (text: string) => {
      // A blank transcription never reaches here: the recorder holds that
      // recording back for a retry instead of reporting it as a result.
      const transcription = text.trim();
      const capture = sessionRef.current;
      if (capture === null) {
        pushToast("The capture lost its destination before it could land");
        return;
      }
      void land({ capture, fragment: transcription });
    },
    [land],
  );

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    ensureAvailable,
    hasRetryableRecording,
    toggleRecording,
    stopRecording,
    cancelRecording,
    retryTranscription,
    discardRecording,
  } = useVoiceRecorder({
    // Nothing at all outside a project: the transcription request must not
    // invent one for a capture bound for a global notepad.
    ...(session === null || session.ambientProject === null
      ? {}
      : { projectName: session.ambientProject.name }),
    // Re-read when the audio is sent, so the context is what the notepad says
    // now rather than what it said before the user started talking. The value
    // frozen at record start is the floor, not the answer: it keeps a slow or
    // failed read from downgrading a real context to none (R25.2).
    getContext: async () => {
      const capture = sessionRef.current;
      if (capture === null) return "";
      if (capture.destination.kind !== "existing") return "";
      try {
        const notepad = await queryClient.fetchQuery({
          ...notepadQueries.detail(capture.destination.id),
          staleTime: 0,
        });
        return transcriptionContextFrom(notepad.content);
      } catch {
        return capture.context;
      }
    },
    onResult: (text) => handleResult(text),
    onError: (message) => pushToast(message),
  });

  const cancel = useCallback(() => {
    attemptRef.current += 1;
    setPreparing(false);
    cancelRecording();
    applySession(null);
    voiceOwnership.release(ownerId);
  }, [applySession, cancelRecording, ownerId]);

  // Ownership is claimed at the press and held for as long as the microphone
  // is spoken for — including while the destination is being resolved, so a
  // composer that claims voice mid-preparation stops this capture rather than
  // recording alongside it.
  useEffect(() => {
    if (preparing || isRecording) return;
    voiceOwnership.release(ownerId);
  }, [isRecording, ownerId, preparing]);

  useEffect(() => () => cancel(), [cancel]);

  /**
   * Take the microphone. A first claim that finds another owner stops it and
   * reports failure; the second claim is the takeover the hotkey promises — the
   * user asked to record here, so recording starts here (R25.3).
   */
  const claimVoice = useCallback(() => {
    if (voiceOwnership.currentId() === ownerId) return true;
    const owner = { id: ownerId, stop: cancel };
    if (voiceOwnership.claim(owner)) return true;
    return voiceOwnership.claim(owner);
  }, [cancel, ownerId]);

  const startCapture = useCallback(async () => {
    const attempt = (attemptRef.current += 1);
    const current = () => attempt === attemptRef.current;
    setPreparing(true);
    try {
      // Asked before the microphone opens, and worth waiting for: a probe that
      // has not answered yet is not an outage (R25.4).
      const available = await ensureAvailable();
      if (!current()) return;
      if (!available) {
        pushToast("Voice transcription is unavailable");
        return;
      }

      const ambientProject = ambientProjectFromRoute(
        pathname,
        typeof window === "undefined" ? "" : window.location.search,
        useQuickTicketStore.getState().conversationRegistry,
      );

      // A destination deleted between the listing and its content read is
      // resolved past rather than named: the pill must never show a notepad
      // the capture already knows it cannot land in. One retry is enough — the
      // second listing no longer contains it.
      const gone = new Set<string>();
      const startedOn = today();
      for (let round = 0; round < 2; round += 1) {
        const listing = (
          await fetchDestinationPool(queryClient, ambientProject)
        ).filter((row) => !gone.has(row.id));
        if (!current()) return;

        const destination = resolveCaptureDestination(
          quickCaptureResolution({
            ambientProject,
            openNotepadId: useSessionDetailStore.getState().openNotepadId,
            listing,
            today: startedOn,
          }),
        );
        const name = captureDestinationName(destination, listing);
        if (name === null) {
          pushToast("Couldn't work out which notepad to capture into");
          return;
        }

        const content = await destinationContent(queryClient, destination);
        if (!current()) return;
        if (content === GONE) {
          if (destination.kind === "existing") gone.add(destination.id);
          continue;
        }

        applySession({
          destination,
          name,
          ambientProject,
          context: transcriptionContextFrom(content),
          today: startedOn,
        });
        await toggleRecording();
        return;
      }
      pushToast("Couldn't work out which notepad to capture into");
    } catch (error) {
      if (current()) {
        pushToast(
          errorMessage(error, "Couldn't reach the notepad to capture into"),
        );
      }
    } finally {
      if (current()) setPreparing(false);
    }
  }, [applySession, ensureAvailable, pathname, queryClient, toggleRecording]);

  /** Send back whatever is being held: the audio, or the words it became. */
  const retry = useCallback(() => {
    if (pendingLanding !== null) {
      void land(pendingLanding);
      return;
    }
    retryTranscription();
  }, [land, pendingLanding, retryTranscription]);

  /** The explicit throw-away: the recording goes, and so does its destination. */
  const discard = useCallback(() => {
    discardRecording();
    setPendingLanding(null);
    applySession(null);
  }, [applySession, discardRecording]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (preparing || isProcessing) return;
    // Held-back speech owns the hotkey until it is sent or thrown away:
    // starting a new capture over it would destroy words nobody discarded.
    if (hasRetryableRecording || pendingLanding !== null) {
      retry();
      return;
    }
    if (!claimVoice()) {
      pushToast("Another surface is using the microphone");
      return;
    }
    // A new capture supersedes the last one's confirmation, so the recording
    // surface is never hidden behind it.
    setLanded(null);
    void startCapture();
  }, [
    claimVoice,
    hasRetryableRecording,
    isProcessing,
    isRecording,
    pendingLanding,
    preparing,
    retry,
    startCapture,
    stopRecording,
  ]);

  const dismissConfirmation = useCallback(() => setLanded(null), []);

  const openLanded = useCallback(() => {
    if (landed === null) return;
    const store = useSessionDetailStore.getState();
    store.switchRightPaneTab("notepad");
    store.openNotepad(landed.notepadId);
    setLanded(null);
  }, [landed]);

  /**
   * Undo trims the capture off the notepad as it stands now, never off the
   * copy the append returned: a user write does not enforce its base revision,
   * so restoring a remembered body would silently overwrite whatever landed
   * after the capture. If the fragment is no longer the tail, someone else has
   * written and undo declines rather than guessing.
   */
  const undoLanded = useCallback(() => {
    if (landed === null) return;
    const capture = landed;
    setLanded(null);
    void (async () => {
      try {
        const current = await queryClient.fetchQuery({
          ...notepadQueries.detail(capture.notepadId),
          staleTime: 0,
        });
        const restored = contentWithoutAppended(
          current.content,
          capture.fragment,
        );
        if (restored === null) {
          pushToast(
            "The notepad changed since the capture — nothing was undone",
          );
          return;
        }
        await writeContent.mutateAsync({
          notepadId: capture.notepadId,
          content: restored,
          baseRevision: current.revision,
        });
      } catch (error) {
        pushToast(errorMessage(error, "Undo failed"));
      }
    })();
  }, [landed, queryClient, writeContent]);

  let phase: QuickCapturePhase = "idle";
  if (isRecording) phase = "recording";
  else if (preparing) phase = "preparing";
  else if (isProcessing) phase = "processing";
  else if (hasRetryableRecording) phase = "failed";
  else if (pendingLanding !== null) phase = "landing-failed";

  return {
    phase,
    destinationName: session?.name ?? null,
    elapsedTime,
    confirmation:
      landed === null
        ? null
        : {
            notepadId: landed.notepadId,
            notepadName: landed.notepadName,
            preview: landed.preview,
          },
    toggle,
    stop: stopRecording,
    cancel,
    retry,
    discard,
    openLanded,
    undoLanded,
    dismissConfirmation,
  };
}
