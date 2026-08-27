/**
 * Notepad images: the bytes-plus-row pair behind the notepad image routes.
 *
 * The canonical notepad text addresses an image by id alone, so an upload has
 * to land two things atomically enough that a token can never point at nothing:
 * the bytes in the content store and the metadata row that maps the id to them.
 * This module owns that pairing, its accepted media types, and the compensation
 * when the second half fails — the decisions a route handler would otherwise
 * have to re-derive.
 */

import { imageMediaTypeSchema } from "@/lib/images/schemas";
import { createLogger } from "@/lib/logging";
import type { NotepadsRepo } from "@/lib/state-store/notepads-repo";
import { NotepadContentError, type NotepadContentStore } from "./content-store";
import type { NotepadImage } from "./schemas";
import type { NotepadError, NotepadService } from "./service";

const logger = createLogger("notepads.images");

/**
 * The notepad error vocabulary plus the three refusals only an image can raise.
 * Notepad-level misses reuse the service's own errors verbatim, so a caller
 * reads the same not-found copy whichever surface it arrived through.
 */
export type NotepadImageError =
  | NotepadError
  | {
      code: "image_not_found";
      message: string;
      rationale: string;
      instruction: string;
      notepadId: string;
      imageId: string;
    }
  | {
      code: "image_unavailable";
      message: string;
      rationale: string;
      instruction: string;
      notepadId: string;
      imageId: string;
    }
  | {
      code: "unsupported_media_type";
      message: string;
      rationale: string;
      instruction: string;
      mediaType: string;
    };

export type NotepadImageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NotepadImageError };

export interface AddNotepadImageInput {
  notepadId: string;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface NotepadImageBytes {
  image: NotepadImage;
  bytes: Uint8Array;
}

export interface NotepadImageService {
  add(input: AddNotepadImageInput): Promise<NotepadImageResult<NotepadImage>>;
  read(
    notepadId: string,
    imageId: string,
  ): Promise<NotepadImageResult<NotepadImageBytes>>;
}

export interface NotepadImageServiceDeps {
  /**
   * The notepad read goes through the service so a missing notepad is refused
   * with the domain's own not-found, rather than a second copy of that copy.
   */
  notepads: Pick<NotepadService, "get">;
  repo: Pick<NotepadsRepo, "addImage" | "findImage">;
  contentStore: Pick<NotepadContentStore, "capture" | "read" | "delete">;
  now(): string;
  generateId(): string;
}

function imageNotFound(notepadId: string, imageId: string): NotepadImageError {
  return {
    code: "image_not_found",
    message: `Notepad ${notepadId} has no image ${imageId}.`,
    rationale:
      "The image was never uploaded to this notepad, or it went away with a notepad that has since been deleted.",
    instruction:
      "Re-upload the image and use the id the upload returns, or drop the token from the notepad text.",
    notepadId,
    imageId,
  };
}

function imageUnavailable(image: NotepadImage): NotepadImageError {
  return {
    code: "image_unavailable",
    message: `Image ${image.id} is recorded on notepad ${image.notepadId}, but its bytes are no longer stored.`,
    rationale:
      "The metadata row outlived the file in the content store — the bytes were removed out from under it.",
    instruction:
      "Re-upload the image; the recorded id can no longer be served.",
    notepadId: image.notepadId,
    imageId: image.id,
  };
}

function unsupportedMediaType(mediaType: string): NotepadImageError {
  const accepted = imageMediaTypeSchema.options.join(", ");
  return {
    code: "unsupported_media_type",
    message: `${mediaType === "" ? "An unnamed media type" : mediaType} is not an image type a notepad accepts.`,
    rationale: `Notepad images are rendered in the preview and exported with the notepad, so the stored types are the ones every surface can render: ${accepted}.`,
    instruction: `Convert the image to one of ${accepted} and upload it again.`,
    mediaType,
  };
}

export function createNotepadImageService(
  deps: NotepadImageServiceDeps,
): NotepadImageService {
  return {
    async add(input) {
      const notepad = await deps.notepads.get(input.notepadId);
      if (!notepad.ok) return { ok: false, error: notepad.error };

      const mediaType = imageMediaTypeSchema.safeParse(input.mediaType);
      if (!mediaType.success) {
        logger.info("notepads.images.media_type_refused", {
          notepadId: input.notepadId,
          mediaType: input.mediaType,
        });
        return { ok: false, error: unsupportedMediaType(input.mediaType) };
      }

      const imageId = deps.generateId();
      const snapshot = await deps.contentStore.capture({
        notepadId: input.notepadId,
        imageId,
        fileName: input.fileName,
        bytes: input.bytes,
      });

      const image: NotepadImage = {
        id: imageId,
        notepadId: input.notepadId,
        // The sanitized name the store actually wrote, not the one requested:
        // the row must describe the file that exists.
        fileName: snapshot.fileName,
        mediaType: mediaType.data,
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256,
        snapshotKey: snapshot.snapshotKey,
        createdAt: deps.now(),
      };

      try {
        await deps.repo.addImage(image);
      } catch (error) {
        // Bytes with no row are unreachable forever — nothing can name them —
        // so the failed insert takes them back out. The compensation never
        // masks the original failure.
        try {
          await deps.contentStore.delete(snapshot.snapshotKey);
        } catch (cleanupError) {
          logger.warn("notepads.images.orphaned", {
            notepadId: input.notepadId,
            orphanPathKey: snapshot.snapshotKey,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          });
        }
        throw error;
      }

      logger.info("notepads.images.added", {
        notepadId: input.notepadId,
        imageId,
        sizeBytes: image.sizeBytes,
      });
      return { ok: true, value: image };
    },

    async read(notepadId, imageId) {
      const image = await deps.repo.findImage(notepadId, imageId);
      // The row carries the notepad id, so a miss covers both a deleted notepad
      // and an image that was never on this one — one lookup, one answer.
      if (image === null) {
        return { ok: false, error: imageNotFound(notepadId, imageId) };
      }

      try {
        return {
          ok: true,
          value: {
            image,
            bytes: await deps.contentStore.read(image.snapshotKey),
          },
        };
      } catch (error) {
        if (
          error instanceof NotepadContentError &&
          error.code === "snapshot_not_found"
        ) {
          logger.warn("notepads.images.bytes_missing", {
            notepadId,
            imageId,
            snapshotKey: image.snapshotKey,
          });
          return { ok: false, error: imageUnavailable(image) };
        }
        throw error;
      }
    },
  };
}
