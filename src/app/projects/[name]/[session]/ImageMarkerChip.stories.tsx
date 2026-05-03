import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { ComponentProps } from "react";
import ImageMarkerChip from "./ImageMarkerChip";
import type { ImageMarkerAttrs } from "@/lib/prompt-editor";

const SAMPLE_THUMB =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

type ChipProps = ComponentProps<typeof ImageMarkerChip>;

function buildProps(args: {
  attrs?: Partial<ImageMarkerAttrs>;
  selected?: boolean;
  onRemoveAttachment?: ((attachmentId: string) => void) | null;
}): ChipProps {
  const attrs: ImageMarkerAttrs = {
    index: args.attrs?.index ?? 1,
    attachmentId: args.attrs?.attachmentId ?? "att-storybook",
    mediaType: args.attrs?.mediaType ?? "image/png",
    thumbnailUrl: args.attrs?.thumbnailUrl ?? SAMPLE_THUMB,
    fileName: args.attrs?.fileName ?? "screenshot.png",
  };

  const editor = {
    storage: {
      imageMarker: {
        onRemoveAttachment:
          args.onRemoveAttachment === undefined
            ? null
            : args.onRemoveAttachment,
      },
    },
  };

  return {
    node: { attrs } as unknown as ChipProps["node"],
    editor: editor as unknown as ChipProps["editor"],
    selected: args.selected ?? false,
    deleteNode: fn(),
    getPos: () => 0,
    decorations: [],
    innerDecorations: undefined as unknown as ChipProps["innerDecorations"],
    updateAttributes: fn(),
    view: undefined as unknown as ChipProps["view"],
    HTMLAttributes: {},
    extension: undefined as unknown as ChipProps["extension"],
    ref: { current: null },
  } as ChipProps;
}

const meta = {
  title: "Session/ImageMarkerChip",
  component: ImageMarkerChip,
} satisfies Meta<typeof ImageMarkerChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: buildProps({ attrs: { index: 1 } }),
} satisfies Story;

export const LongIndex = {
  args: buildProps({ attrs: { index: 42 } }),
} satisfies Story;

export const Selected = {
  args: buildProps({ attrs: { index: 3 }, selected: true }),
} satisfies Story;

export const WithFileName = {
  args: buildProps({
    attrs: { index: 5, fileName: "design-mockup.png" },
  }),
} satisfies Story;

export const WithRemoveCallback = {
  args: buildProps({
    attrs: { index: 2 },
    onRemoveAttachment: fn(),
  }),
} satisfies Story;

export const Mobile = {
  args: buildProps({ attrs: { index: 1 } }),
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;
