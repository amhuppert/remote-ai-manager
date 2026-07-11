import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MarkdownDocumentList from "./MarkdownDocumentList";

const documents = [
  {
    docPath: "docs/plan.md",
    title: "plan.md",
    origin: "edit" as const,
    firstSeenAt: "2026-07-11T10:00:00.000Z",
    lastSeenAt: "2026-07-11T12:00:00.000Z",
    location: "worktree" as const,
    registered: true,
    description: "Implementation plan and validation notes",
  },
  {
    docPath: "/Users/alex/shared/runbook.md",
    title: "runbook.md",
    origin: "read" as const,
    firstSeenAt: "2026-07-11T09:00:00.000Z",
    lastSeenAt: "2026-07-11T11:00:00.000Z",
    location: "external" as const,
    registered: false,
    description: null,
  },
  {
    docPath: "memory-bank/focus.md",
    title: "focus.md",
    origin: "registered" as const,
    firstSeenAt: "2026-07-11T08:00:00.000Z",
    lastSeenAt: "2026-07-11T08:00:00.000Z",
    location: "worktree" as const,
    registered: true,
    description: "Current work-in-progress and remaining tasks",
  },
];

const meta = {
  title: "Session/Conversation/MarkdownDocumentList",
  component: MarkdownDocumentList,
  args: {
    documents,
    activeDocPath: "docs/plan.md",
    onOpen: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[520px] max-w-[420px] flex-col bg-bg-void p-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkdownDocumentList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;
export const Empty = { args: { documents: [] } } satisfies Story;
export const Loading = {
  args: { documents: [], loading: true },
} satisfies Story;
export const ErrorState = {
  args: { documents: [], error: "Could not load Markdown documents." },
} satisfies Story;
