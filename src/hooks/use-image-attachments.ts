"use client";

import { useState, useCallback, useEffect, useRef } from "react";

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

export interface UseImageAttachmentsReturn {
  pendingImages: ImageAttachment[];
  addImage: (file: File | Blob, fileName?: string) => Promise<string | null>;
  removeImage: (id: string) => void;
  clearImages: () => void;
  isAtLimit: boolean;
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

export function useImageAttachments(): UseImageAttachmentsReturn {
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const idCounter = useRef(0);

  // Cleanup all object URLs on unmount
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });
  useEffect(() => {
    return () => {
      for (const img of pendingImagesRef.current) {
        URL.revokeObjectURL(img.previewUrl);
      }
    };
  }, []);

  const addImage = useCallback(
    async (file: File | Blob, fileName?: string): Promise<string | null> => {
      const error = validateImage(file, pendingImagesRef.current.length);
      if (error) return error;

      let base64Data: string;
      try {
        base64Data = await readFileAsBase64(file);
      } catch {
        return "Failed to read image file";
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

      setPendingImages((prev) => [...prev, attachment]);
      return null;
    },
    [],
  );

  const removeImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clearImages = useCallback(() => {
    setPendingImages((prev) => {
      for (const img of prev) {
        URL.revokeObjectURL(img.previewUrl);
      }
      return [];
    });
  }, []);

  return {
    pendingImages,
    addImage,
    removeImage,
    clearImages,
    isAtLimit: pendingImages.length >= MAX_IMAGES_PER_PROMPT,
  };
}
