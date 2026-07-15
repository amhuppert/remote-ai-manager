"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import ModelSelector from "@/components/ModelSelector";
import { SEND_BUTTON_CLASS } from "@/components/session/prompt/PromptDesktopToolbar";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

// Tiny colored PNGs for visual distinction in stories
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

const SAMPLE_IMAGES: ImageAttachment[] = [
  makeImage("img-1", "screenshot.png", CYAN_PNG),
  makeImage("img-2", "diagram.png", GREEN_PNG),
  makeImage("img-3", "mockup.png", AMBER_PNG),
];

/** Wrapper component that composes the prompt input area with all sub-components */
function PromptInputAreaDemo({
  images = [],
  isRecording = false,
  sending = false,
  isFinished = false,
  voiceAvailable = true,
}: {
  images?: ImageAttachment[];
  isRecording?: boolean;
  sending?: boolean;
  isFinished?: boolean;
  voiceAvailable?: boolean;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("sonnet");
  const removeImage = fn();
  const toggleRecording = fn();

  return (
    <div className="shrink-0 border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-lg py-md max-768:border-border-default max-768:bg-[var(--cc-bg-base-a60)] max-768:px-sm max-768:py-xs">
      <div className="relative flex flex-col gap-sm">
        <textarea
          className="max-h-[50vh] min-h-[80px] resize-none overflow-y-auto rounded-md border border-solid border-border-default bg-bg-surface px-[14px] py-[12px] font-mono text-[0.85rem] leading-[1.5] text-text-primary transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-text-tertiary focus:border-cyan-dim focus:shadow-[0_0_0_3px_var(--cyan-glow)] max-768:max-h-[120px] max-768:min-h-[44px]"
          placeholder={
            isFinished
              ? "Session is merged and read-only"
              : "Send a prompt to Claude..."
          }
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isFinished}
        />
        <ImageAttachmentPreview images={images} onRemove={removeImage} />
        <div className="flex items-center justify-between max-768:hidden">
          <div className="flex items-center gap-sm">
            <button
              className="flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-subtle bg-transparent p-0 text-text-secondary transition-[border-color,color] duration-150 ease-[ease] hover:border-cyan-dim hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title="Attach image"
              type="button"
              disabled={sending || isFinished}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <ModelSelector
              value={model}
              backend="claude"
              onChange={setModel}
              disabled={sending || isFinished}
            />
          </div>
          <div className="flex items-center gap-sm">
            <VoiceRecordButton
              isRecording={isRecording}
              isProcessing={false}
              elapsedTime={isRecording ? 5 : 0}
              isAvailable={voiceAvailable}
              toggleRecording={toggleRecording}
              disabled={sending}
            />
            <button
              className={SEND_BUTTON_CLASS}
              data-busy={sending}
              disabled={
                (!text.trim() && images.length === 0) ||
                sending ||
                isFinished ||
                isRecording
              }
              title={
                isFinished
                  ? "Session is read-only"
                  : sending
                    ? "Session is busy"
                    : "Send prompt"
              }
            >
              {sending ? (
                <div
                  className="spinner"
                  style={{
                    borderColor: "rgba(0, 229, 255, 0.3)",
                    borderTopColor: "var(--cyan)",
                    width: 18,
                    height: 18,
                  }}
                />
              ) : (
                "\u25B6"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Session/PromptInputArea",
  component: PromptInputAreaDemo,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 700, margin: "0 auto" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PromptInputAreaDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAttachments: Story = {
  args: {
    images: SAMPLE_IMAGES,
  },
};

export const Recording: Story = {
  args: {
    isRecording: true,
  },
};

export const Sending: Story = {
  args: {
    sending: true,
  },
};

export const Finished: Story = {
  args: {
    isFinished: true,
  },
};

export const NoVoice: Story = {
  args: {
    voiceAvailable: false,
  },
};

export const NarrowWidth: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 400, margin: "0 auto" }}>
        <Story />
      </div>
    ),
  ],
};

export const MobileWidth: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360, margin: "0 auto" }}>
        <Story />
      </div>
    ),
  ],
};
