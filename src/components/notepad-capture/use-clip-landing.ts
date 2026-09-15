"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { getOpenNotepadClipTarget } from "@/components/notepad/open-editor-registry";
import { ApiCallError } from "@/lib/api/errors";
import { createClientLogger } from "@/lib/logging/client-logger";
import { trimAppendedNotepadContent } from "@/lib/notepads/append-composition";
import {
  resolveCaptureDestination,
  type CaptureDestinationInput,
} from "@/lib/notepads/capture-destination";
import {
  buildClipFragment,
  type ClipFragmentInput,
} from "@/lib/notepads/capture-fragment";
import { useLandCaptureMutation } from "@/lib/notepads/capture-landing";
import { useWriteNotepadContentMutation } from "@/lib/notepads/mutations";
import { notepadQueries } from "@/lib/notepads/queries";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { pushToast } from "@/stores/toast.store";

const UNDO_REFUSED_MESSAGE =
  "Can't undo — the notepad changed since the clip landed";
const UNDO_FAILED_MESSAGE = "Undo failed — the notepad could not be updated";
const log = createClientLogger("clip-landing");

/**
 * Lands a clip from either transcript entry point (selection or whole-message)
 * through the foundation pipeline: build the fragment, resolve the shared
 * capture destination (D21) over a fresh listing, and append — through the
 * open editor's handle when the destination is the notepad open in this
 * session's right pane (R22.5), so the user's own clip never raises the
 * external-write banner; through the HTTP capture landing otherwise. Every
 * landing confirms with a toast naming the destination, with Open (routes the
 * right pane to that notepad) and Undo (removes the composed suffix while it
 * is still the content tail).
 */
export function useClipLanding(projectName: string): {
  land(input: ClipFragmentInput | ClipFragmentInput[]): Promise<void>;
} {
  const queryClient = useQueryClient();
  const landCapture = useLandCaptureMutation();
  const writeContent = useWriteNotepadContentMutation();

  const { mutateAsync: landCaptureAsync } = landCapture;
  const { mutateAsync: writeContentAsync } = writeContent;

  const undo = useCallback(
    async (notepadId: string, fragment: string): Promise<void> => {
      const handle = getOpenNotepadClipTarget(notepadId);
      if (handle) {
        // The open view owns its undo: it defers in-flight flushes and posts
        // the removal under an enforced base revision, so an external write
        // it has seen but not yet adopted refuses instead of being
        // overwritten.
        try {
          if (!(await handle.undoAppend(fragment))) {
            pushToast(UNDO_REFUSED_MESSAGE);
          }
        } catch {
          pushToast(UNDO_FAILED_MESSAGE);
        }
        return;
      }
      const head = await queryClient.fetchQuery({
        ...notepadQueries.detail(notepadId),
        staleTime: 0,
      });
      const trimmed = trimAppendedNotepadContent(head.content, fragment);
      if (trimmed === null) {
        pushToast(UNDO_REFUSED_MESSAGE);
        return;
      }
      try {
        // Enforced base: the tail check above is only valid for the revision
        // it read, so the write is a compare-and-swap — a write racing in
        // between refuses as stale instead of being overwritten.
        await writeContentAsync({
          notepadId,
          content: trimmed,
          baseRevision: head.revision,
          enforceBaseRevision: true,
        });
      } catch (error) {
        pushToast(
          error instanceof ApiCallError && error.code === "stale_revision"
            ? UNDO_REFUSED_MESSAGE
            : UNDO_FAILED_MESSAGE,
        );
      }
    },
    [queryClient, writeContentAsync],
  );

  const land = useCallback(
    async (input: ClipFragmentInput | ClipFragmentInput[]): Promise<void> => {
      const inputs = Array.isArray(input) ? input : [input];
      if (inputs.length === 0) return;
      const fragment = inputs.map(buildClipFragment).join("\n\n");
      // A fresh listing (archived included, for name collisions) so the
      // recency tier and takenNames never decide from a stale cache.
      const candidates = await queryClient.fetchQuery({
        ...notepadQueries.panelList(projectName, "recency", true),
        staleTime: 0,
      });
      const openNotepadId = useSessionDetailStore.getState().openNotepadId;
      const resolution: CaptureDestinationInput = {
        openNotepad: openNotepadId === null ? null : { id: openNotepadId },
        candidates,
        ambientProject: { name: projectName },
        takenNames: candidates
          .filter(
            (row) => row.scope === "project" && row.projectName === projectName,
          )
          .map((row) => row.name),
        today: new Date().toISOString().slice(0, 10),
      };
      const destination = resolveCaptureDestination(resolution);

      // A registered target means the destination is the notepad open in this
      // session's right pane — whatever its view mode — so the clip goes
      // through the open view and stays a local write (R22.5).
      const handle =
        destination.kind === "existing"
          ? getOpenNotepadClipTarget(destination.id)
          : null;
      let landedId: string;
      let landedName: string;
      if (destination.kind === "existing" && handle) {
        handle.appendFragment(fragment);
        landedId = destination.id;
        landedName =
          candidates.find((row) => row.id === destination.id)?.name ??
          (await queryClient.fetchQuery(notepadQueries.detail(destination.id)))
            .name;
      } else {
        const landed = await landCaptureAsync({ resolution, fragment });
        landedId = landed.id;
        landedName = landed.name;
      }

      log.info("clip.landed", {
        notepadId: landedId,
        fragmentCount: inputs.length,
        characters: fragment.length,
        destination: handle ? "open_editor" : "http",
      });
      pushToast(`Clipped to ${landedName}`, {
        actions: [
          {
            label: "Open",
            onClick: () =>
              useSessionDetailStore.getState().openNotepadPanel(landedId),
          },
          {
            label: "Undo",
            onClick: () => void undo(landedId, fragment),
          },
        ],
      });
    },
    [projectName, queryClient, landCaptureAsync, undo],
  );

  return { land };
}
