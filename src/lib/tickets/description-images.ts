import type { ImageMediaType } from "@/lib/images/schemas";
import { imageMediaTypeSchema } from "@/lib/images/schemas";
import type { TicketAttachment } from "./schemas";

// ============================================================
// Pasted description images — the linkage convention
// ============================================================
//
// An image pasted into a ticket description serializes as an inline
// `[Image #N]` token; the bytes live in an ordinary file attachment. The two
// are associated purely through the attachment's deterministic description
// (the index agents and the editor both read), so the convention below is a
// contract: `pastedImageDescription` and `parsePastedImageIndex` must stay in
// lockstep, and the description is re-synced whenever a later edit renumbers
// the surviving chips.

const INDEXED_DESCRIPTION_PATTERN =
  /^Pasted image — appears as \[Image #(\d+)\] in the ticket description$/;

export function pastedImageDescription(index: number | null): string {
  if (index === null) {
    return "Pasted image attached while editing the ticket description";
  }
  return `Pasted image — appears as [Image #${index}] in the ticket description`;
}

export function parsePastedImageIndex(description: string): number | null {
  const match = INDEXED_DESCRIPTION_PATTERN.exec(description);
  if (match === null) return null;
  const index = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}

const EXTENSION_BY_MEDIA_TYPE: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function pastedImageFileName(
  index: number | null,
  mediaType: ImageMediaType,
): string {
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];
  return index === null
    ? `pasted-image.${extension}`
    : `pasted-image-${index}.${extension}`;
}

// ============================================================
// Hydration — which attachments are inline description images
// ============================================================

export interface DescriptionImageRef {
  attachmentId: string;
  index: number;
  fileName: string;
}

/**
 * File attachments that carry an indexed pasted-image description and image
 * bytes the editor can render. Attachments with the non-indexed description
 * are deliberately excluded: they are plain attachments, never auto-deleted
 * or renumbered by description edits.
 */
export function collectDescriptionImageRefs(
  attachments: readonly TicketAttachment[],
): DescriptionImageRef[] {
  return attachments.flatMap((attachment) => {
    if (attachment.payload.kind !== "file") return [];
    const index = parsePastedImageIndex(attachment.description);
    if (index === null) return [];
    const mediaType = imageMediaTypeSchema.safeParse(
      attachment.payload.mediaType,
    );
    if (!mediaType.success) return [];
    return [
      {
        attachmentId: attachment.id,
        index,
        fileName: attachment.payload.fileName,
      },
    ];
  });
}

// ============================================================
// Save-time sync plan
// ============================================================

export interface DescriptionEditorImage {
  /** Existing ticket attachment id, or the editor-local id for a new paste. */
  id: string;
  mediaType: ImageMediaType;
  base64Data: string;
  inlineMarkerIndex?: number;
}

export interface DescriptionImageUpload {
  imageId: string;
  mediaType: ImageMediaType;
  base64Data: string;
  fileName: string;
  description: string;
}

export interface DescriptionImageSyncPlan {
  uploads: DescriptionImageUpload[];
  /** Existing attachments whose description must follow a renumber/demotion. */
  descriptionSyncs: { attachmentId: string; description: string }[];
  /** Existing inline-image attachments removed from the editor entirely. */
  deletions: string[];
}

/** Materialize an upload's bytes as the File the attachment route expects. */
export function pastedImageUploadFile(upload: DescriptionImageUpload): File {
  const binary = atob(upload.base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], upload.fileName, { type: upload.mediaType });
}

export function planDescriptionImageSync(input: {
  editorImages: readonly DescriptionEditorImage[];
  existing: readonly DescriptionImageRef[];
}): DescriptionImageSyncPlan {
  const existingById = new Map(
    input.existing.map((ref) => [ref.attachmentId, ref]),
  );
  const uploads: DescriptionImageUpload[] = [];
  const descriptionSyncs: { attachmentId: string; description: string }[] = [];
  const seen = new Set<string>();

  for (const image of input.editorImages) {
    const index = image.inlineMarkerIndex ?? null;
    const existing = existingById.get(image.id);
    if (existing === undefined) {
      uploads.push({
        imageId: image.id,
        mediaType: image.mediaType,
        base64Data: image.base64Data,
        fileName: pastedImageFileName(index, image.mediaType),
        description: pastedImageDescription(index),
      });
      continue;
    }
    seen.add(existing.attachmentId);
    if (existing.index !== index) {
      descriptionSyncs.push({
        attachmentId: existing.attachmentId,
        description: pastedImageDescription(index),
      });
    }
  }

  const deletions = input.existing
    .filter((ref) => !seen.has(ref.attachmentId))
    .map((ref) => ref.attachmentId);

  return { uploads, descriptionSyncs, deletions };
}
