/**
 * Landing a capture: resolve, create if the destination does not exist yet,
 * then append. Every capture surface — clip and voice quick-capture alike —
 * lands through this one composition, so the destination rule and the write
 * path cannot drift apart between them.
 */

import { useMutation } from "@tanstack/react-query";

import {
  resolveCaptureDestination,
  type CaptureDestinationInput,
} from "./capture-destination";
import {
  useAppendNotepadContentMutation,
  useCreateNotepadMutation,
} from "./mutations";
import type { Notepad } from "./schemas";

export interface LandCaptureVariables {
  /**
   * What the destination rule decides from, sampled at landing time. A surface
   * that showed a destination earlier — quick capture names it while recording
   * — passes fresh inputs here rather than the destination it displayed, so a
   * notepad that vanished mid-capture re-resolves instead of failing (D21).
   */
  resolution: CaptureDestinationInput;
  /**
   * The fragment body exactly as its builder produced it. The blank-line
   * separator belongs to the append composition, never to the caller.
   */
  fragment: string;
}

/**
 * Lands a capture and returns the destination's new head — its name is what a
 * confirmation names, and its content is what an undo trims back.
 */
export function useLandCaptureMutation() {
  const createNotepad = useCreateNotepadMutation();
  const appendContent = useAppendNotepadContentMutation();
  return useMutation({
    mutationFn: async ({
      resolution,
      fragment,
    }: LandCaptureVariables): Promise<Notepad> => {
      const destination = resolveCaptureDestination(resolution);
      const notepadId =
        destination.kind === "existing"
          ? destination.id
          : (
              await createNotepad.mutateAsync({
                scope: destination.scope,
                ...(destination.projectName === null
                  ? {}
                  : { projectName: destination.projectName }),
                name: destination.name,
              })
            ).id;
      return appendContent.mutateAsync({ notepadId, content: fragment });
    },
  });
}
