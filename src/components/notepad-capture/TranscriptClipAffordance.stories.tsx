import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { MessageMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { TranscriptClipAffordance } from "./TranscriptClipAffordance";
import type { TranscriptClipDraft } from "./use-transcript-clip-selection";

const meta = {
  title: "Notepads/Transcript selection",
  component: SelectionStory,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SelectionStory>;

export default meta;
type Story = StoryObj<typeof meta>;

const messages = [
  {
    role: "assistant",
    content:
      "The first paragraph explains the decision. Select from here into the next paragraph or message.\n\nThe second paragraph keeps its boundary when clipped.\n\n```typescript\nconst annotation = {\n  start: 4,\n  end: 9,\n};\n```",
  },
  {
    role: "user",
    content:
      "Keep the selected context together. Each message keeps its source reference.\n\nThis final paragraph can complete a selection across both messages.",
  },
] as const;

function SelectionStory(): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [captured, setCaptured] = useState<TranscriptClipDraft | null>(null);
  return (
    <main className="mx-auto max-w-[760px] space-y-xl bg-bg-base p-lg text-text-primary">
      <header className="space-y-sm font-mono">
        <h1 className="text-[1rem] font-semibold">Clip from a conversation</h1>
        <p className="text-[0.78rem] text-text-secondary">
          Select text across paragraphs, code, or messages, then choose Clip.
        </p>
      </header>
      <div ref={root} className="conversation" data-backend="claude">
        {messages.map((message, index) => (
          <section className="message space-y-sm" key={message.role}>
            <header className="font-mono text-[0.72rem] text-text-secondary">
              {message.role === "assistant" ? "Claude" : "You"} · 10:0{index}
            </header>
            <div
              className="message-content"
              data-clip-index={index}
              data-clip-role={message.role}
            >
              <MessageMarkdown content={message.content} />
            </div>
            <Button type="button" variant="ghost" size="sm">
              Copy reference
            </Button>
          </section>
        ))}
      </div>
      <TranscriptClipAffordance onClip={setCaptured} within={root} />
      {captured && (
        <section
          className="space-y-md rounded-md border border-solid border-border-default bg-bg-surface p-lg"
          aria-label="Captured selection"
        >
          <h2 className="font-mono text-[0.8rem] font-semibold">
            Captured selection
          </h2>
          {captured.messages.map((message) => (
            <div key={message.messageIndex} className="space-y-sm">
              <p className="font-mono text-[0.72rem] text-text-secondary">
                {message.role === "assistant" ? "Claude" : "You"}
              </p>
              <pre className="m-0 font-mono text-[0.78rem] whitespace-pre-wrap">
                {message.text}
              </pre>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

export const AcrossParagraphsAndMessages: Story = {
  render: () => <SelectionStory />,
};
