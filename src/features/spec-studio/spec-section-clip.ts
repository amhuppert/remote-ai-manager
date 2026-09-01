import type { ClipCaptureCapability } from "@/components/document-viewer/annotation-contract";
import { selectionLiesWithinCode } from "@/components/notepad-capture/clip-code-ancestry";
import { buildSpecSectionReferenceXml } from "@/lib/prompt-editor/spec-reference-contract";

export interface SpecSectionClipSource {
  projectName: string;
  slug: string;
  /** The selected prose section's stable element id — its whole address. */
  elementId: string;
  /** The section's heading, carried on the reference for its chip. */
  sectionTitle: string;
  /** The revision whose prose is on screen. */
  revision: number;
}

/**
 * Spec Studio's clip provenance. The annotated elements here are the revision's
 * prose SECTIONS, so a clip is attributed to the section it was taken from
 * rather than to the spec as a whole — two sections of one spec must not be
 * provenance-identical. Sections carry no handle, so the `section-ref` kind
 * addresses them by element id, and its read command resolves to that section.
 */
export function specSectionClipCapability(
  source: SpecSectionClipSource,
): ClipCaptureCapability {
  return {
    enabled: true,
    buildProvenance: () => ({
      kind: "ref",
      xml: buildSpecSectionReferenceXml({
        projectName: source.projectName,
        slug: source.slug,
        elementId: source.elementId,
        name: source.sectionTitle,
        revision: String(source.revision),
      }),
    }),
    deriveIsCode: selectionLiesWithinCode,
  };
}
