"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type { ImageMarkerAttrs, ImageMarkerStorage } from "@/lib/prompt-editor";

function isImageMarkerAttrs(value: unknown): value is ImageMarkerAttrs {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["index"] === "number" &&
    typeof v["attachmentId"] === "string" &&
    typeof v["mediaType"] === "string" &&
    typeof v["thumbnailUrl"] === "string"
  );
}

export default function ImageMarkerChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, editor, selected, deleteNode } = props;

  const attrs = isImageMarkerAttrs(node.attrs)
    ? node.attrs
    : {
        index: 0,
        attachmentId: "",
        mediaType: "image/png",
        thumbnailUrl: "",
        fileName: null,
      };

  const storage = editor.storage.imageMarker as ImageMarkerStorage | undefined;
  const onRemoveAttachment = storage?.onRemoveAttachment ?? null;

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
    if (onRemoveAttachment && attrs.attachmentId.length > 0) {
      onRemoveAttachment(attrs.attachmentId);
    }
  };

  return (
    <NodeViewWrapper
      as="span"
      className="image-marker-chip"
      data-selected={selected ? "true" : "false"}
      data-attachment-id={attrs.attachmentId}
      contentEditable={false}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs for paste/drop previews */}
      <img
        src={attrs.thumbnailUrl}
        alt={attrs.fileName ?? ""}
        className="image-marker-chip__thumbnail"
        draggable={false}
      />
      <span className="image-marker-chip__index">#{attrs.index}</span>
      <button
        type="button"
        className="image-marker-chip__remove"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="Remove image"
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
