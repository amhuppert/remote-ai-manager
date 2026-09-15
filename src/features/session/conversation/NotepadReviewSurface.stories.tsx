import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

import { notepadAnchorFromSelection } from "@/lib/notepads/annotatable-projection";
import { notepadQueries } from "@/lib/notepads/queries";
import {
  createNotepadCommentInputSchema,
  notepadContentWriteSchema,
  type Notepad,
  type ResolvedNotepadCommentThread,
} from "@/lib/notepads/schemas";

import NotepadReviewSurface from "./NotepadReviewSurface";

const CONTENT = [
  "# Release checklist",
  "",
  "The **migration** lands on Tuesday after the backfill finishes.",
  "",
  "Confirm the queue is empty before opening traffic to the next region.",
  "",
  "## Rollout",
  "",
  "- Deploy the application.",
  "- Verify the health checks.",
  "",
  "Keep the rollback window open until both checks pass.",
].join("\n");

const NOW = "2026-09-15T12:00:00.000Z";

function notepad(id: string, name: string, content: string): Notepad {
  return {
    id,
    name,
    content,
    scope: "global",
    projectPath: null,
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function installStoryApi(): () => void {
  const previousFetch = window.fetch;
  const source = notepad("np-annotation-story", "Release checklist", CONTENT);
  const clips = notepad("np-clips-story", "Clips", "");
  clips.scope = "project";
  clips.projectPath = "/stories/annotation-story";
  const quote =
    "migration lands on Tuesday after the backfill finishes.\n\nConfirm the queue";
  const anchor = notepadAnchorFromSelection(
    {
      sectionId: "release-checklist",
      headingLabel: "Release checklist",
      line: 3,
      endBlock: { line: 5, sectionId: "release-checklist" },
      charStart: 4,
      charEnd: 4 + quote.length,
      quote,
    },
    CONTENT,
    1,
  );
  if (anchor === null) throw new Error("Story passage could not be anchored");
  const comments: ResolvedNotepadCommentThread[] = [
    {
      comment: {
        id: "nc-story-1",
        notepadId: source.id,
        anchor,
        body: "Review these two steps together.",
        status: "open",
        authorKind: "user",
        authorConversationId: null,
        createdAt: NOW,
        updatedAt: NOW,
        resolvedAt: null,
      },
      replies: [],
      passage: {
        quote: anchor.quote,
        location: "Release checklist, line 3",
        state: "anchored",
      },
    },
  ];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  window.fetch = async (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), window.location.origin), init);
    const path = new URL(request.url).pathname;
    if (path === "/api/conversations/all")
      return json({ items: [], totalCount: 0 });
    if (path === `/api/notepads/${source.id}/comments`) {
      if (request.method === "GET") return json({ comments });
      const body: unknown = await request.json();
      const parsed = createNotepadCommentInputSchema.safeParse(body);
      if (!parsed.success) return json({ error: "Invalid comment" }, 400);
      const comment = {
        ...comments[0]!.comment,
        id: `nc-story-${comments.length + 1}`,
        anchor: parsed.data.anchor,
        body: parsed.data.body,
      };
      comments.push({
        comment,
        replies: [],
        passage: {
          quote: comment.anchor.quote,
          location: "Release checklist",
          state: "anchored",
        },
      });
      return json({ comment }, 201);
    }
    if (path === "/api/notepads") {
      const { content: _content, ...summary } = clips;
      return json({
        notepads: [{ ...summary, projectName: "annotation-story" }],
      });
    }
    if (path === `/api/notepads/${clips.id}/content`) {
      const body: unknown = await request.json();
      const parsed = notepadContentWriteSchema.safeParse(
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? { ...body, author: { kind: "user" } }
          : body,
      );
      if (!parsed.success) return json({ error: "Invalid content" }, 400);
      clips.content =
        clips.content === ""
          ? parsed.data.content
          : `${clips.content}\n\n${parsed.data.content}`;
      clips.revision += 1;
      return json({ notepad: clips });
    }
    if (path === `/api/notepads/${clips.id}`) return json({ notepad: clips });
    if (path === `/api/notepads/${source.id}`) return json({ notepad: source });
    return previousFetch(input, init);
  };
  return () => {
    window.fetch = previousFetch;
  };
}

function CaptureOutput(): React.JSX.Element {
  const { data } = useQuery(notepadQueries.detail("np-clips-story"));
  return (
    <section className="border-x-0 border-t border-b-0 border-solid border-border-subtle p-md">
      <h2 className="m-0 font-mono text-xs text-text-secondary">
        Clipped text
      </h2>
      <pre
        data-testid="notepad-story-clips"
        className="m-0 mt-sm font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-text-secondary"
      >
        {data?.content || "Select text across paragraphs, then choose Clip."}
      </pre>
    </section>
  );
}

function StoryFrame({ children }: { children: ReactNode }): React.JSX.Element {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto flex h-dvh w-full max-w-[960px] min-w-0 flex-col overflow-y-auto bg-bg-base">
        {children}
        <CaptureOutput />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Session/NotepadReviewSurface",
  component: NotepadReviewSurface,
  parameters: { layout: "fullscreen" },
  beforeEach: installStoryApi,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
  args: {
    notepadId: "np-annotation-story",
    notepadName: "Release checklist",
    notepadScope: "global",
    projectName: "annotation-story",
    sessionName: "review",
    content: CONTENT,
    revision: 1,
    active: true,
  },
} satisfies Meta<typeof NotepadReviewSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultiBlock: Story = {};
