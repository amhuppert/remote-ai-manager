"use client";

import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import {
  TicketMentionNode,
  type TicketMentionAttrs,
} from "@/lib/prompt-editor";

interface TicketMentionStoryProps {
  attrs: TicketMentionAttrs;
  selected?: boolean;
}

function TicketMentionStory({
  attrs,
  selected = false,
}: TicketMentionStoryProps): React.JSX.Element {
  const editor = useEditor({
    immediatelyRender: true,
    editable: true,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        orderedList: false,
        strike: false,
      }),
      TicketMentionNode,
    ],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "ticketMention", attrs }],
        },
      ],
    },
  });

  useEffect(() => {
    if (editor === null || !selected) return;
    editor.commands.setNodeSelection(1);
  }, [editor, selected]);

  return (
    <EditorContent
      editor={editor}
      className="rounded-md border border-solid border-border-default bg-bg-surface px-[14px] py-[12px] font-mono text-[0.85rem] text-text-primary"
    />
  );
}

const baseAttrs: TicketMentionAttrs = {
  projectName: "command-center",
  ticketNumber: "12",
  identifier: "command-center#12",
  title: "Add durable ticket context",
};

const meta = {
  title: "Components/TicketMentionChip",
  component: TicketMentionStory,
  decorators: [
    (Story) => (
      <div className="flex items-center gap-md px-lg py-md">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof TicketMentionStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: { attrs: baseAttrs, selected: false },
} satisfies Story;

export const Selected = {
  args: { attrs: baseAttrs, selected: true },
} satisfies Story;

export const Truncated = {
  args: {
    attrs: {
      ...baseAttrs,
      ticketNumber: "104",
      identifier: "command-center#104",
      title:
        "Investigate intermittent flaky test in the orchestrator integration suite",
    },
  },
} satisfies Story;
