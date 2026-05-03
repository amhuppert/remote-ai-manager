// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import ImageMarkerChip from "./ImageMarkerChip";
import type { ImageMarkerAttrs } from "@/lib/prompt-editor";

type ChipProps = ComponentProps<typeof ImageMarkerChip>;

interface BuildPropsOptions {
  attrs?: Partial<ImageMarkerAttrs>;
  selected?: boolean;
  deleteNode?: () => void;
  onRemoveAttachment?: ((attachmentId: string) => void) | null;
}

function buildProps(opts: BuildPropsOptions = {}): ChipProps {
  const attrs: ImageMarkerAttrs = {
    index: opts.attrs?.index ?? 1,
    attachmentId: opts.attrs?.attachmentId ?? "att-1",
    mediaType: opts.attrs?.mediaType ?? "image/png",
    thumbnailUrl: opts.attrs?.thumbnailUrl ?? "blob:thumb-1",
    fileName: opts.attrs?.fileName ?? null,
  };

  const editor = {
    storage: {
      imageMarker: {
        onRemoveAttachment:
          opts.onRemoveAttachment === undefined
            ? null
            : opts.onRemoveAttachment,
      },
    },
  };

  return {
    node: { attrs } as unknown as ChipProps["node"],
    editor: editor as unknown as ChipProps["editor"],
    selected: opts.selected ?? false,
    deleteNode: opts.deleteNode ?? (() => {}),
    getPos: () => 0,
    decorations: [],
    innerDecorations: undefined as unknown as ChipProps["innerDecorations"],
    updateAttributes: () => {},
    view: undefined as unknown as ChipProps["view"],
    HTMLAttributes: {},
    extension: undefined as unknown as ChipProps["extension"],
    ref: { current: null },
  } as ChipProps;
}

describe("ImageMarkerChip", () => {
  it("renders the thumbnail image with src", () => {
    const { container } = render(
      <ImageMarkerChip
        {...buildProps({
          attrs: { thumbnailUrl: "blob:abc-123" },
        })}
      />,
    );
    const img = container.querySelector(
      "img.image-marker-chip__thumbnail",
    ) as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("blob:abc-123");
  });

  it("renders the index label as #N", () => {
    const { container } = render(
      <ImageMarkerChip {...buildProps({ attrs: { index: 7 } })} />,
    );
    const label = container.querySelector(".image-marker-chip__index");
    expect(label?.textContent).toBe("#7");
  });

  it("renders longer indices like #42", () => {
    const { container } = render(
      <ImageMarkerChip {...buildProps({ attrs: { index: 42 } })} />,
    );
    const label = container.querySelector(".image-marker-chip__index");
    expect(label?.textContent).toBe("#42");
  });

  it("invokes deleteNode when the remove button is clicked", () => {
    const deleteNode = vi.fn();
    const { container } = render(
      <ImageMarkerChip {...buildProps({ deleteNode })} />,
    );
    const btn = container.querySelector(
      ".image-marker-chip__remove",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(deleteNode).toHaveBeenCalledTimes(1);
  });

  it("invokes onRemoveAttachment from extension storage when clicked", () => {
    const onRemoveAttachment = vi.fn();
    const { container } = render(
      <ImageMarkerChip
        {...buildProps({
          attrs: { attachmentId: "att-xyz" },
          onRemoveAttachment,
        })}
      />,
    );
    const btn = container.querySelector(
      ".image-marker-chip__remove",
    ) as HTMLButtonElement | null;
    fireEvent.click(btn!);
    expect(onRemoveAttachment).toHaveBeenCalledWith("att-xyz");
  });

  it("does not throw when onRemoveAttachment is null in storage", () => {
    const { container } = render(
      <ImageMarkerChip {...buildProps({ onRemoveAttachment: null })} />,
    );
    const btn = container.querySelector(
      ".image-marker-chip__remove",
    ) as HTMLButtonElement | null;
    expect(() => fireEvent.click(btn!)).not.toThrow();
  });

  it("sets data-selected=true when the selected prop is true", () => {
    const { container } = render(
      <ImageMarkerChip {...buildProps({ selected: true })} />,
    );
    const wrapper = container.querySelector(".image-marker-chip");
    expect(wrapper?.getAttribute("data-selected")).toBe("true");
  });

  it("sets data-selected=false when the selected prop is false", () => {
    const { container } = render(
      <ImageMarkerChip {...buildProps({ selected: false })} />,
    );
    const wrapper = container.querySelector(".image-marker-chip");
    expect(wrapper?.getAttribute("data-selected")).toBe("false");
  });

  it("uses fileName as alt text when present", () => {
    const { container } = render(
      <ImageMarkerChip
        {...buildProps({ attrs: { fileName: "screenshot.png" } })}
      />,
    );
    const img = container.querySelector(
      "img.image-marker-chip__thumbnail",
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("alt")).toBe("screenshot.png");
  });

  it("falls back to empty alt text when fileName is null", () => {
    const { container } = render(
      <ImageMarkerChip {...buildProps({ attrs: { fileName: null } })} />,
    );
    const img = container.querySelector(
      "img.image-marker-chip__thumbnail",
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("alt")).toBe("");
  });
});
