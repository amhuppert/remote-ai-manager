"use client";

import { memo } from "react";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

interface ImageAttachmentPreviewProps {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}

export default memo(function ImageAttachmentPreview({
  images,
  onRemove,
}: ImageAttachmentPreviewProps): React.JSX.Element | null {
  if (images.length === 0) return null;

  return (
    <div className="attachment-preview-strip">
      {images.map((img) => (
        <div key={img.id} className="attachment-thumbnail">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs from client-side file selection */}
          <img
            src={img.previewUrl}
            alt={img.fileName}
            className="attachment-thumbnail-img"
          />
          <button
            className="attachment-thumbnail-remove"
            onClick={() => onRemove(img.id)}
            title="Remove image"
            type="button"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
});
