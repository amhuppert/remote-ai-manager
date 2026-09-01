import type { ClipCaptureCapability } from "@/components/document-viewer/annotation-contract";
import { selectionLiesWithinCode } from "@/components/notepad-capture/clip-code-ancestry";
import {
  buildNotepadRefXml,
  type NotepadRefInput,
} from "@/lib/notepads/references";

/**
 * The notepad review surface's clip provenance: the source notepad's own
 * reference, so a clip taken while reviewing one notepad points back at it by
 * id — and keeps pointing after a rename (D19).
 */
export function notepadReviewClipCapability(
  source: NotepadRefInput,
): ClipCaptureCapability {
  return {
    enabled: true,
    buildProvenance: () => ({ kind: "ref", xml: buildNotepadRefXml(source) }),
    deriveIsCode: selectionLiesWithinCode,
  };
}
