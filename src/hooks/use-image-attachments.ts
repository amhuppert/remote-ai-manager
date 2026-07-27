"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ImagePayload } from "@/lib/images/schemas";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_IMAGES_PER_PROMPT = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  base64Data: string;
  previewUrl: string;
  sizeBytes: number;
}

export interface AddImageResult {
  attachment: ImageAttachment | null;
  error: string | null;
}

/** The conversation an attachment belongs to; `undefined` for a single-scope composer. */
type ScopeKey = string | undefined;

/** Shared empty result so an untouched scope keeps a stable array identity. */
const NO_IMAGES: ImageAttachment[] = [];

export interface UseImageAttachmentsReturn {
  pendingImages: ImageAttachment[];
  addImage: (file: File | Blob, fileName?: string) => Promise<AddImageResult>;
  removeImage: (id: string) => void;
  clearImages: () => void;
  isAtLimit: boolean;
}

function attachmentFromPayload(
  image: ImagePayload,
  index: number,
): ImageAttachment {
  return {
    id: image.attachmentId,
    fileName: `image-${index + 1}`,
    mediaType: image.mediaType,
    base64Data: image.base64Data,
    previewUrl: `data:${image.mediaType};base64,${image.base64Data}`,
    sizeBytes: 0,
  };
}

function initialImageCounter(images: readonly ImagePayload[]): number {
  return images.reduce((maximum, image) => {
    const match = /^img-(\d+)$/.exec(image.attachmentId);
    if (!match) return maximum;
    return Math.max(maximum, Number(match[1]));
  }, 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateImage(file: File | Blob, currentCount: number): string | null {
  const mimeType = file.type;
  if (
    !ACCEPTED_MIME_TYPES.includes(
      mimeType as (typeof ACCEPTED_MIME_TYPES)[number],
    )
  ) {
    return "Only JPEG, PNG, GIF, and WebP images are supported";
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return "Image exceeds the 5 MB size limit";
  }
  if (currentCount >= MAX_IMAGES_PER_PROMPT) {
    return "Maximum of 5 images per prompt reached";
  }
  return null;
}

function readFileAsBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix: "data:image/png;base64,..."
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to read image file"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useImageAttachments(
  initialImages: readonly ImagePayload[] = [],
  /**
   * Bind the attachment set to a scope (a conversation id). Attachments stay
   * with the scope that was active when they were added, so a composer shared
   * across conversations — the project cockpit's, which is one instance behind a
   * tab strip — cannot carry one conversation's attachment onto another's
   * prompt, and returning to a tab restores what was attached there. Omit for a
   * composer that only ever serves one conversation.
   */
  scopeKey?: string,
): UseImageAttachmentsReturn {
  // Attachments for every scope this composer has served, keyed by scope. One
  // map rather than an active set plus a stash: an attachment then has exactly
  // one home, so a scope change is a lookup rather than a swap, and a read that
  // resolves after the user moved on still has its own scope to land in.
  const [imagesByScope, setImagesByScope] = useState<
    ReadonlyMap<ScopeKey, ImageAttachment[]>
  >(() => new Map([[scopeKey, initialImages.map(attachmentFromPayload)]]));
  const idCounter = useRef(initialImageCounter(initialImages));
  const addQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Authoritative for writes: queued additions must see each other's results
  // before React has re-rendered.
  const imagesByScopeRef = useRef(imagesByScope);

  const imagesFor = useCallback(
    (owner: ScopeKey): ImageAttachment[] =>
      imagesByScopeRef.current.get(owner) ?? NO_IMAGES,
    [],
  );

  const commit = useCallback(
    (owner: ScopeKey, next: ImageAttachment[]) => {
      const merged = new Map(imagesByScopeRef.current);
      merged.set(owner, next);
      imagesByScopeRef.current = merged;
      setImagesByScope(merged);
    },
    [],
  );

  useEffect(() => {
    return () => {
      for (const images of imagesByScopeRef.current.values()) {
        for (const image of images) URL.revokeObjectURL(image.previewUrl);
      }
    };
  }, []);

  const addImage = useCallback(
    (file: File | Blob, fileName?: string): Promise<AddImageResult> => {
      // Ownership is captured when the user picks the file, not when the read
      // resolves. Reading is asynchronous, so without this the attachment would
      // land on whichever conversation happened to be active by then (R3.3).
      const owner = scopeKey;
      const result = addQueueRef.current.then(async () => {
        const error = validateImage(file, imagesFor(owner).length);
        if (error) return { attachment: null, error };

        let base64Data: string;
        try {
          base64Data = await readFileAsBase64(file);
        } catch {
          return { attachment: null, error: "Failed to read image file" };
        }

        const id = `img-${++idCounter.current}`;
        const previewUrl = URL.createObjectURL(file);
        const resolvedName =
          fileName ?? (file instanceof File ? file.name : "clipboard-image");

        const attachment: ImageAttachment = {
          id,
          fileName: resolvedName,
          mediaType: file.type,
          base64Data,
          previewUrl,
          sizeBytes: file.size,
        };

        commit(owner, [...imagesFor(owner), attachment]);
        return { attachment, error: null };
      });
      addQueueRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [scopeKey, imagesFor, commit],
  );

  const removeImage = useCallback(
    (id: string) => {
      const image = imagesFor(scopeKey).find(
        (candidate) => candidate.id === id,
      );
      if (image) URL.revokeObjectURL(image.previewUrl);
      commit(
        scopeKey,
        imagesFor(scopeKey).filter((candidate) => candidate.id !== id),
      );
    },
    [scopeKey, imagesFor, commit],
  );

  const clearImages = useCallback(() => {
    for (const image of imagesFor(scopeKey)) {
      URL.revokeObjectURL(image.previewUrl);
    }
    commit(scopeKey, []);
  }, [scopeKey, imagesFor, commit]);

  const pendingImages = imagesByScope.get(scopeKey) ?? NO_IMAGES;

  return {
    pendingImages,
    addImage,
    removeImage,
    clearImages,
    isAtLimit: pendingImages.length >= MAX_IMAGES_PER_PROMPT,
  };
}
