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
    <div className="flex flex-wrap items-center gap-sm py-xs">
      {images.map((img) => (
        <div key={img.id} className="group relative h-[48px] w-[48px] shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs from client-side file selection */}
          <img
            src={img.previewUrl}
            alt={img.fileName}
            className="h-[48px] w-[48px] rounded-md border-2 border-solid border-border-default object-cover transition-[border-color] duration-150 ease-[ease] group-hover:border-border-strong"
          />
          <button
            className="absolute top-[-4px] right-[-4px] flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border border-solid border-border-subtle bg-bg-raised p-0 text-[12px] leading-none text-text-secondary hover:border-[var(--danger)] hover:bg-[var(--danger)] hover:text-text-primary"
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
