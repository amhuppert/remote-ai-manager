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
      className="inline-flex items-center gap-xs rounded-md border border-border-default bg-bg-raised py-2xs pr-[6px] pl-2xs align-baseline font-mono text-[0.78rem] leading-none transition-[border-color,box-shadow] duration-150 data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:py-xs max-768:pr-sm max-768:pl-xs"
      data-selected={selected ? "true" : "false"}
      data-attachment-id={attrs.attachmentId}
      contentEditable={false}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs for paste/drop previews */}
      <img
        src={attrs.thumbnailUrl}
        alt={attrs.fileName ?? ""}
        className="h-[20px] w-[20px] shrink-0 rounded-[3px] object-cover"
        draggable={false}
      />
      <span className="font-semibold text-cyan">#{attrs.index}</span>
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="Remove image"
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
