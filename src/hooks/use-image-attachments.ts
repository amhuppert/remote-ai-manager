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

function revokePreviewUrl(previewUrl: string): void {
  if (!previewUrl.startsWith("blob:")) return;
  URL.revokeObjectURL(previewUrl);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useImageAttachments(
  initialImages: readonly ImagePayload[] = [],
): UseImageAttachmentsReturn {
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>(() =>
    initialImages.map(attachmentFromPayload),
  );
  const idCounter = useRef(initialImageCounter(initialImages));
  const addQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Cleanup all object URLs on unmount
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });
  useEffect(() => {
    return () => {
      for (const img of pendingImagesRef.current) {
        revokePreviewUrl(img.previewUrl);
      }
    };
  }, []);

  const addImage = useCallback(
    (file: File | Blob, fileName?: string): Promise<AddImageResult> => {
      const result = addQueueRef.current.then(async () => {
        const error = validateImage(file, pendingImagesRef.current.length);
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

        const nextImages = [...pendingImagesRef.current, attachment];
        pendingImagesRef.current = nextImages;
        setPendingImages(nextImages);
        return { attachment, error: null };
      });
      addQueueRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  const removeImage = useCallback((id: string) => {
    const image = pendingImagesRef.current.find(
      (candidate) => candidate.id === id,
    );
    if (image) revokePreviewUrl(image.previewUrl);
    const nextImages = pendingImagesRef.current.filter(
      (candidate) => candidate.id !== id,
    );
    pendingImagesRef.current = nextImages;
    setPendingImages(nextImages);
  }, []);

  const clearImages = useCallback(() => {
    for (const image of pendingImagesRef.current) {
      revokePreviewUrl(image.previewUrl);
    }
    pendingImagesRef.current = [];
    setPendingImages([]);
  }, []);

  return {
    pendingImages,
    addImage,
    removeImage,
    clearImages,
    isAtLimit: pendingImages.length >= MAX_IMAGES_PER_PROMPT,
  };
}
