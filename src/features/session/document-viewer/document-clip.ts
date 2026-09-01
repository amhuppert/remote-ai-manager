import type { ClipCaptureCapability } from "@/components/document-viewer/annotation-contract";
import { selectionLiesWithinCode } from "@/components/notepad-capture/clip-code-ancestry";

/**
 * The document viewer's clip provenance. Documents have no registry reference
 * kind, so a clip from here carries the repo-relative document path instead —
 * still retrievable, because agents read files (D19).
 */
export function documentClipCapability(docPath: string): ClipCaptureCapability {
  return {
    enabled: true,
    buildProvenance: () => ({ kind: "path", path: docPath }),
    deriveIsCode: selectionLiesWithinCode,
  };
}
