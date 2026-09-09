/**
 * Archive-owned recovery of the image bytes one transcript entry displays.
 *
 * The caller addresses an image by ORIGINAL coordinate — conversation, CC
 * transcript frame sequence, image-bearing content-block index — and never by
 * filesystem path. The archive resolves where the bytes are, which is what
 * makes a handle stable across repeated compaction and keeps an arbitrary path
 * out of the request. A stored path that resolves outside the transcript image
 * root — lexically, or through a symlink at any level — is refused rather than
 * served.
 *
 * Reading is all this does. It copies nothing, renumbers nothing, rewrites no
 * asset, and submits no prompt: inspecting evidence must have no effect on any
 * conversation's model context. An asset that was already missing stays
 * missing — preservation means keeping the bytes CC stored, not recreating
 * them.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  historyImageHandles,
  imageGetCommand,
  type HistoryImageHandle,
} from "@/lib/conversations/history-recovery";
import { lookupArchiveEntry } from "@/lib/conversations/history-entry-service";
import {
  readContainedTranscriptImageBytes,
  transcriptImagesRoot,
  type ContainedImageRead,
} from "@/lib/images/transcript-images";
import {
  readTranscriptEntriesWithSeq as defaultReadTranscriptEntriesWithSeq,
  type TranscriptEntriesResult,
} from "@/lib/prompt/transcript";

export const historyImageRefusalCodeSchema = z.enum([
  /** No archive line addresses this sequence. */
  "entry_not_found",
  /** The line exists but the adapter does not project it as a readable entry. */
  "entry_unsupported",
  /** The entry has no content block at this index. */
  "block_not_found",
  /** The addressed block is not an image. */
  "not_an_image_block",
  /** The recorded media type is not a servable image type. */
  "unsupported_media_type",
  /** The recorded path resolves outside the archive's image root. */
  "image_outside_archive",
  /** The stored asset is gone; the original handle is still returned. */
  "asset_unavailable",
]);
export type HistoryImageRefusalCode = z.infer<
  typeof historyImageRefusalCodeSchema
>;

/** The coordinate a caller asked for, echoed back on every outcome. */
export interface HistoryImageRequest {
  conversationId: string;
  seq: number;
  contentBlockIndex: number;
}

export interface HistoryImage {
  /** Canonical handle: the IMAGE-BEARING block, even when a marker was asked for. */
  handle: HistoryImageHandle;
  mediaType: string;
  bytes: Buffer;
  byteLength: number;
  sha256: string;
}

export type HistoryImageResult =
  | { ok: true; image: HistoryImage }
  | {
      ok: false;
      code: HistoryImageRefusalCode;
      requested: HistoryImageRequest;
      /** The resolved archive handle when the block was identified. */
      handle: HistoryImageHandle | null;
      reason: string;
    };

export interface HistoryImageServiceDeps {
  readTranscriptEntries(
    transcriptPath: string | null,
  ): Promise<TranscriptEntriesResult>;
  /**
   * Archive-contained bytes for a recorded path. Containment belongs to the
   * module that owns where images live, not to this reader — and it is decided
   * against the real filesystem, so a symlink cannot lend an outside file an
   * archive coordinate.
   */
  readImageBytes(imagePath: string): Promise<ContainedImageRead>;
}

export interface GetHistoryImageInput extends HistoryImageRequest {
  /** Resolved by the SCOPED caller; this module never addresses a conversation. */
  transcriptPath: string | null;
}

export interface HistoryImageService {
  getImage(input: GetHistoryImageInput): Promise<HistoryImageResult>;
}

function defaultDeps(): HistoryImageServiceDeps {
  return {
    readTranscriptEntries: defaultReadTranscriptEntriesWithSeq,
    readImageBytes: (imagePath) =>
      readContainedTranscriptImageBytes(imagePath, transcriptImagesRoot()),
  };
}

/**
 * A media type CC will serve as an image. Validated because the value comes
 * from the archive: a response header must never carry an arbitrary recorded
 * string.
 */
const SERVABLE_IMAGE_MEDIA_TYPE = /^image\/[a-z0-9][a-z0-9.+-]*$/;

function failure(
  code: HistoryImageRefusalCode,
  requested: HistoryImageRequest,
  handle: HistoryImageHandle | null,
  reason: string,
): HistoryImageResult {
  return { ok: false, code, requested, handle, reason };
}

export function createHistoryImageService(
  deps: HistoryImageServiceDeps = defaultDeps(),
): HistoryImageService {
  async function getImage(
    input: GetHistoryImageInput,
  ): Promise<HistoryImageResult> {
    const requested: HistoryImageRequest = {
      conversationId: input.conversationId,
      seq: input.seq,
      contentBlockIndex: input.contentBlockIndex,
    };

    const read = await deps.readTranscriptEntries(input.transcriptPath);
    const found = lookupArchiveEntry(read, input.seq);
    if (!found.ok) {
      return failure(found.code, requested, null, found.reason);
    }

    const content = found.entry.content;
    const addressed = content[input.contentBlockIndex];
    if (
      !Number.isInteger(input.contentBlockIndex) ||
      input.contentBlockIndex < 0 ||
      addressed === undefined
    ) {
      return failure(
        "block_not_found",
        requested,
        null,
        "the entry has no content block at this index",
      );
    }

    // A paired marker/reference is ONE displayed image, and the reference is
    // the half that carries the bytes: addressing either resolves to the
    // image-bearing index, so a handle taken from any surface works.
    const next = content[input.contentBlockIndex + 1];
    const canonicalIndex =
      addressed.type === "image_marker" &&
      next?.type === "image_ref" &&
      next.imagePath === addressed.imagePath
        ? input.contentBlockIndex + 1
        : input.contentBlockIndex;
    const block = content[canonicalIndex];

    if (
      block === undefined ||
      (block.type !== "image" &&
        block.type !== "image_ref" &&
        block.type !== "image_marker")
    ) {
      return failure(
        "not_an_image_block",
        requested,
        null,
        "the addressed content block does not carry an image",
      );
    }

    const handle = historyImageHandles({
      conversationId: input.conversationId,
      seq: input.seq,
      content,
    }).find((candidate) => candidate.contentBlockIndex === canonicalIndex) ?? {
      conversationId: input.conversationId,
      seq: input.seq,
      contentBlockIndex: canonicalIndex,
      mediaType: block.mediaType,
      storage:
        block.type === "image" ? ("inline" as const) : ("external" as const),
      command: imageGetCommand(input.conversationId, input.seq, canonicalIndex),
    };

    if (!SERVABLE_IMAGE_MEDIA_TYPE.test(block.mediaType)) {
      return failure(
        "unsupported_media_type",
        requested,
        handle,
        `recorded media type is not a servable image: ${block.mediaType}`,
      );
    }

    if (block.type === "image") {
      return complete(handle, Buffer.from(block.base64Data, "base64"));
    }

    const stored = await deps.readImageBytes(block.imagePath);
    if (!stored.ok) {
      // The handle survives either refusal: the coordinate is still the
      // evidence, and CC never recreates bytes it did not store.
      return stored.reason === "outside_root"
        ? failure(
            "image_outside_archive",
            requested,
            handle,
            "the recorded image path does not resolve inside the archive image root",
          )
        : failure(
            "asset_unavailable",
            requested,
            handle,
            "the stored image file is no longer present",
          );
    }
    return complete(handle, stored.bytes);
  }

  function complete(
    handle: HistoryImageHandle,
    bytes: Buffer,
  ): HistoryImageResult {
    return {
      ok: true,
      image: {
        handle,
        mediaType: handle.mediaType,
        bytes,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }

  return { getImage };
}
