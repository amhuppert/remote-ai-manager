import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { assembleSpecCommentThreads } from "@/lib/specs/comment-threads";
import type { SpecCommentView } from "@/lib/specs/view-schemas";

import SpecCommentThread from "./SpecCommentThread";

const ANCHOR = {
  sectionId: "requirements",
  headingLabel: "Requirements",
  line: 8,
  charStart: 0,
  charEnd: 26,
  quote: "the exact selected passage",
  prefix: "",
  suffix: "",
  docRevision: "revision-4",
};

function row(
  id: string,
  overrides: Partial<SpecCommentView> = {},
): SpecCommentView {
  return {
    id,
    threadId: "thread-1",
    parentCommentId: id === "root" ? null : "root",
    elementId: "requirement-3",
    handle: "R3",
    revisionId: "revision-4",
    revisionNumber: 4,
    anchor: ANCHOR,
    quote: ANCHOR.quote,
    body:
      id === "root"
        ? "This needs to state the **failure behavior**."
        : `Reply from ${id}.`,
    author: { kind: "human" },
    blocking: false,
    resolution: "open",
    createdAt: `2026-08-22T10:${id === "root" ? "14" : "18"}:00.000Z`,
    updatedAt: "2026-08-22T10:20:00.000Z",
    ...overrides,
  };
}

function model(rows: SpecCommentView[] = [row("root")]) {
  return assembleSpecCommentThreads(rows)[0]!;
}

const meta = {
  title: "Spec Studio/SpecCommentThread",
  component: SpecCommentThread,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[min(760px,calc(100vw-32px))] bg-bg-base p-lg">
        <Story />
      </div>
    ),
  ],
  args: {
    thread: model(),
    anchorState: { status: "anchored", charStart: 0, charEnd: 26 },
  },
} satisfies Meta<typeof SpecCommentThread>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FreshOpen: Story = {};

export const AgentReplyWithConversationLink: Story = {
  args: {
    thread: model([
      row("root"),
      row("agent", {
        body: "Added the timeout and recovery requirement.",
        author: {
          kind: "agent",
          conversationId: "conversation-agent-reply",
          backend: "claude",
        },
      }),
    ]),
  },
};

export const MultipleRepliesDeterministic: Story = {
  args: {
    thread: model([
      row("later", {
        createdAt: "2026-08-22T10:20:00.000Z",
        author: {
          kind: "agent",
          conversationId: "conversation-later",
          backend: "codex",
        },
      }),
      row("root"),
      row("earlier", {
        createdAt: "2026-08-22T10:18:00.000Z",
        author: {
          kind: "agent",
          conversationId: "conversation-earlier",
          backend: "claude",
        },
      }),
    ]),
  },
};

export const BlockingOpen: Story = {
  args: { thread: model([row("root", { blocking: true })]) },
};

export const Resolved: Story = {
  args: { thread: model([row("root", { resolution: "resolved" })]) },
};

export const Reanchored: Story = {
  args: {
    anchorState: { status: "reanchored", charStart: 12, charEnd: 38 },
  },
};

export const Stale: Story = {
  args: { anchorState: { status: "stale" } },
};

export const Orphaned: Story = {
  args: { anchorState: { status: "orphaned" } },
};

export const UnknownLegacyAuthor: Story = {
  args: { thread: model([row("root", { author: null })]) },
};

export const ReplyOpen: Story = {
  args: { onReply: fn().mockResolvedValue(undefined) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Reply" }));
    await expect(
      canvas.getByRole("textbox", { name: "Reply to review thread" }),
    ).toHaveFocus();
  },
};

export const ReplySubmitting: Story = {
  args: {
    onReply: () => new Promise<void>(() => {}),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Reply" }));
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Reply to review thread" }),
      "Submitting this reply",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Send reply" }));
    await expect(
      canvas.getByRole("button", { name: "Replying…" }),
    ).toBeDisabled();
  },
};

export const ReplyFailureRetainsDraft: Story = {
  args: {
    onReply: async () => {
      throw new Error("Revision service unavailable");
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Reply" }));
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Reply to review thread" }),
      "Keep this reply",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Send reply" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Revision service unavailable",
    );
    await expect(
      canvas.getByRole("textbox", { name: "Reply to review thread" }),
    ).toHaveValue("Keep this reply");
  },
};

export const Mobile390: Story = {
  args: AgentReplyWithConversationLink.args,
  parameters: {
    viewport: {
      viewports: {
        mobile390: {
          name: "Mobile 390×844",
          styles: { width: "390px", height: "844px" },
        },
      },
      defaultViewport: "mobile390",
    },
    layout: "fullscreen",
  },
};
