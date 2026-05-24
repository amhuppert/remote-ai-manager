import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

// Tiny 1x1 colored PNG data URLs for visual distinction in stories
const SAMPLE_PREVIEW_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

function makeImage(id: string, fileName: string): ImageAttachment {
  return {
    id,
    fileName,
    mediaType: "image/png",
    base64Data: "",
    previewUrl: SAMPLE_PREVIEW_URL,
    sizeBytes: 1024,
  };
}

const meta = {
  title: "Session/ImageAttachmentPreview",
  component: ImageAttachmentPreview,
  args: {
    onRemove: () => {},
  },
} satisfies Meta<typeof ImageAttachmentPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleImage = {
  args: {
    images: [makeImage("img-1", "screenshot.png")],
  },
} satisfies Story;

export const MultipleImages = {
  args: {
    images: [
      makeImage("img-1", "screenshot.png"),
      makeImage("img-2", "diagram.png"),
      makeImage("img-3", "mockup.png"),
      makeImage("img-4", "photo.jpg"),
      makeImage("img-5", "icon.webp"),
    ],
  },
} satisfies Story;

export const Empty = {
  args: {
    images: [],
  },
} satisfies Story;
