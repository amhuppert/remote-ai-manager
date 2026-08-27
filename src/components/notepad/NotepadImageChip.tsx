"use client";

import { useState, type MouseEvent } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { notepadImageUrl } from "@/lib/notepads/image-client";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function notepadIdFromOptions(options: unknown): string {
  if (typeof options !== "object" || options === null) return "";
  return stringValue((options as Record<string, unknown>)["notepadId"]);
}

/**
 * Editor chip for an embedded notepad image: thumbnail from the image route,
 * the upload-time file name as its label, and a remove control. A thumbnail
 * that fails to load (a dangling id) degrades to the label alone rather than
 * a broken image glyph.
 */
export default function NotepadImageChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, extension, selected, deleteNode } = props;
  const imageId = stringValue(node.attrs["imageId"]);
  const fileName = stringValue(node.attrs["fileName"]);
  const notepadId = notepadIdFromOptions(extension.options);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  const label = fileName.length > 0 ? fileName : "image";

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  };

  return (
    <NodeViewWrapper
      as="span"
      className="inline-flex items-center gap-xs rounded-md border border-border-default bg-bg-raised py-2xs pr-[6px] pl-2xs align-baseline font-mono text-[0.78rem] leading-none transition-[border-color,box-shadow] duration-150 data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:py-xs max-768:pr-sm max-768:pl-xs"
      data-selected={selected ? "true" : "false"}
      data-testid="notepad-image-chip"
      data-image-id={imageId}
      contentEditable={false}
    >
      {thumbnailFailed ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- id-addressed route URL, dimensions unknown
        <img
          src={notepadImageUrl(notepadId, imageId)}
          alt={label}
          className="h-[20px] w-[20px] shrink-0 rounded-[3px] object-cover"
          draggable={false}
          onError={() => setThumbnailFailed(true)}
        />
      )}
      <span className="text-text-secondary">{label}</span>
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        onClick={handleRemove}
        onMouseDown={(event) => event.preventDefault()}
        aria-label={`Remove image ${label}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
