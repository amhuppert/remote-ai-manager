"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useEffect, useRef, useState } from "react";
import {
  PromptEditor,
  type PromptEditorHandle,
} from "@/components/session/prompt/PromptEditor";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

const CYAN_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVQYV2P8z8BQz0BKYBw1aBgaBQAgPAX/cbQbLwAAAABJRU5ErkJggg==";
const GREEN_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVQYV2Nk+M9Qz0BKYBQ1aBgaBQAJYgX/4mKgpAAAAABJRU5ErkJggg==";
const AMBER_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVQYV2P4z8DwnoGUwDhq0DA0CgBVCBT/hGzfHAAAAABJRU5ErkJggg==";

function makeImage(id: string, fileName: string, url: string): ImageAttachment {
  return {
    id,
    fileName,
    mediaType: "image/png",
    base64Data: "",
    previewUrl: url,
    sizeBytes: 1024,
  };
}

interface DemoProps {
  initialValue: string;
  initialImages: ImageAttachment[];
  cumulativeImageCount: number;
  disabled?: boolean;
  placeholder?: string;
  withInlineMarkers?: Array<{
    attachmentId: string;
    index: number;
    thumbnailUrl: string;
  }>;
}

function Demo({
  initialValue,
  initialImages,
  cumulativeImageCount,
  disabled,
  placeholder,
  withInlineMarkers,
}: DemoProps): React.JSX.Element {
  const editorRef = useRef<PromptEditorHandle>(null);
  const [pending, setPending] = useState<ImageAttachment[]>(initialImages);

  const onAddImage = async (file: File): Promise<ImageAttachment> => {
    const att: ImageAttachment = {
      id: `att-${Date.now()}`,
      fileName: file.name,
      mediaType: file.type,
      base64Data: "",
      previewUrl: URL.createObjectURL(file),
      sizeBytes: file.size,
    };
    setPending((prev) => [...prev, att]);
    return att;
  };

  const onRemoveImage = (id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  // After mount, optionally insert pre-made marker chips so stories with
  // existing markers render predictably without requiring a paste interaction.
  useEffect(() => {
    if (!withInlineMarkers || withInlineMarkers.length === 0) return;
    const editor = editorRef.current?.editor;
    if (!editor) return;
    for (const m of withInlineMarkers) {
      editor
        .chain()
        .focus("end")
        .insertContent({
          type: "imageMarker",
          attrs: {
            index: m.index,
            attachmentId: m.attachmentId,
            mediaType: "image/png",
            thumbnailUrl: m.thumbnailUrl,
            fileName: null,
          },
        })
        .insertContent(" ")
        .run();
    }
  }, [withInlineMarkers]);

  return (
    <div style={{ maxWidth: 640, padding: 24, background: "#0b1019" }}>
      <PromptEditor
        ref={editorRef}
        conversationId="storybook-conv"
        value={initialValue}
        onChange={() => {}}
        onSubmit={fn()}
        pendingImages={pending}
        onAddImage={onAddImage}
        onRemoveImage={onRemoveImage}
        cumulativeImageCount={cumulativeImageCount}
        disabled={disabled ?? false}
        placeholder={placeholder ?? "Type a message…"}
      />
      <div style={{ marginTop: 8, color: "#738699", fontSize: 12 }}>
        {pending.length} pending image{pending.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

const meta = {
  title: "Session/PromptEditor",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty = {
  args: {
    initialValue: "",
    initialImages: [],
    cumulativeImageCount: 0,
  },
} satisfies Story;

export const WithText = {
  args: {
    initialValue: "Hi Claude, please refactor the prompt builder.",
    initialImages: [],
    cumulativeImageCount: 0,
  },
} satisfies Story;

export const WithSingleMarker = {
  args: {
    initialValue: "Take a look at this screenshot ",
    initialImages: [makeImage("att-1", "screenshot.png", CYAN_PNG)],
    cumulativeImageCount: 0,
    withInlineMarkers: [
      { attachmentId: "att-1", index: 1, thumbnailUrl: CYAN_PNG },
    ],
  },
} satisfies Story;

export const WithMultipleMarkers = {
  args: {
    initialValue: "Compare ",
    initialImages: [
      makeImage("att-1", "before.png", CYAN_PNG),
      makeImage("att-2", "after.png", GREEN_PNG),
      makeImage("att-3", "diff.png", AMBER_PNG),
    ],
    cumulativeImageCount: 0,
    withInlineMarkers: [
      { attachmentId: "att-1", index: 1, thumbnailUrl: CYAN_PNG },
      { attachmentId: "att-2", index: 2, thumbnailUrl: GREEN_PNG },
      { attachmentId: "att-3", index: 3, thumbnailUrl: AMBER_PNG },
    ],
  },
} satisfies Story;

export const Disabled = {
  args: {
    initialValue: "This editor is read-only while a turn is running.",
    initialImages: [],
    cumulativeImageCount: 0,
    disabled: true,
  },
} satisfies Story;

export const CustomPlaceholder = {
  args: {
    initialValue: "",
    initialImages: [],
    cumulativeImageCount: 0,
    placeholder: "Describe the bug…",
  },
} satisfies Story;

export const Mobile = {
  args: {
    initialValue: "",
    initialImages: [],
    cumulativeImageCount: 0,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;
