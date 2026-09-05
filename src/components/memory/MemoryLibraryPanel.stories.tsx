import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installFetchFixture } from "@/test/fetch-fixture";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { memoryNoteSchema, type MemoryNote } from "@/lib/memory/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import MemoryLibraryPanel from "./MemoryLibraryPanel";

const base = memoryNoteSchema.parse({
  id: "lesson",
  slug: "persisted-state",
  scope: "project",
  projectPath: "/repos/cc",
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "Verify persisted state after saving a note",
  body: "Reload the detail and compare the saved revision with the server response.",
  statusNote: null,
  aliases: [],
  indexMode: "auto",
  lifecycle: "active",
  reviewAfter: null,
  expiresAt: null,
  supersedesId: null,
  supersededById: null,
  createdBy: "agent",
  authorConversationId: null,
  revision: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const proposal: MemoryNote = {
  ...base,
  id: "proposal",
  slug: "scratch-server",
  scope: "global",
  projectPath: null,
  lifecycle: "proposed",
  kind: "preference",
  hook: "Use a scratch server for live verification",
};
const candidate: MemoryNote = {
  ...base,
  id: "candidate",
  slug: "durable-session-lesson",
  scope: "session",
  sessionName: "completed-session",
  sessionCreatedAt: "2026-08-01T00:00:00.000Z",
  hook: "Preserve durable lessons after the source session ends",
};
const due: MemoryNote = {
  ...base,
  id: "review",
  slug: "leased-claim",
  hook: "Review this leased claim before relying on it",
  reviewAfter: "2026-08-15T00:00:00.000Z",
};

function Preview(args: ComponentProps<typeof MemoryLibraryPanel>) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <div className="flex h-[85vh] min-h-0 flex-col gap-lg bg-bg-void p-xl max-768:p-md">
        <h1 className="font-display text-[1.5rem] font-extrabold text-text-primary">
          Memory
        </h1>
        <MemoryLibraryPanel {...args} />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Memory/Library",
  component: MemoryLibraryPanel,
  parameters: { layout: "fullscreen" },
  args: {
    projectName: "cc",
    sessionName: null,
    conversationId: null,
    layout: "page",
    active: true,
  },
  render: (args) => <Preview {...args} />,
  beforeEach: (context) => {
    const api = installFetchFixture();
    let notes =
      context.name === "Empty" ? [] : [base, proposal, candidate, due];
    api.reply("GET", "/api/agent-backends", {
      json: { backends: listBackendCatalogEntries() },
    });
    api.reply("GET", "/api/projects/cc/conversations", {
      json: [
        toPublicConversationState(
          makeConversationState({
            id: "preview",
            name: "Project planning",
            scope: "project",
          }),
        ),
      ],
    });
    api.reply("GET", "/api/projects/cc/sessions", { json: { sessions: [] } });
    api.reply("GET", "/api/memory/notes", (req) => ({
      json: {
        notes: notes.filter(
          (note) =>
            note.scope !== "session" &&
            note.lifecycle ===
              (req.searchParams.get("lifecycle") ?? "active") &&
            (!req.searchParams.has("scope") ||
              note.scope === req.searchParams.get("scope")),
        ),
      },
    }));
    api.reply("GET", "/api/memory/review", (req) => ({
      json: {
        entries: notes
          .filter(
            (note) =>
              note.lifecycle === "active" &&
              (req.searchParams.has("projectCandidates")
                ? note.id === "candidate"
                : note.id === "review" && note.reviewAfter !== null),
          )
          .map((note) => ({
            note,
            staleness:
              note.id === "review" ? [{ cause: "lease", target: "note" }] : [],
            noteReviewDue: note.id === "review",
            statusReviewDue: false,
            expired: false,
            promotionCandidate: note.id === "candidate",
          })),
      },
    }));
    api.reply("GET", /^\/api\/memory\/notes\/[^/?]+\?/, (req) => ({
      json: {
        note: notes.find((note) => req.pathname.endsWith(`/${note.id}`)),
        links: [],
        lineage: { supersedes: null, supersededBy: null },
      },
    }));
    api.reply("GET", /^\/api\/memory\/notes\/[^/]+\/revisions/, {
      json: { revisions: [] },
    });
    api.reply("PATCH", /^\/api\/memory\/notes\//, (req) => {
      const note = notes.find((note) => req.pathname.endsWith(`/${note.id}`));
      if (!note) return { status: 404, json: { error: "Note not found" } };
      if (context.name === "Conflict")
        return {
          status: 409,
          json: {
            error: "Another writer changed this note",
            code: "stale_revision",
            details: { currentRevision: 2, baseRevision: 1, slug: note.slug },
          },
        };
      const fields =
        req.jsonBody !== null && typeof req.jsonBody === "object"
          ? req.jsonBody
          : {};
      const updated = memoryNoteSchema.parse({
        ...note,
        ...fields,
        revision: note.revision + 1,
      });
      notes = notes.map((n) => (n.id === note.id ? updated : n));
      return { json: { note: updated } };
    });
    api.reply("POST", /^\/api\/memory\/notes\/[^/]+\/proposal/, (req) => {
      const body = req.jsonBody;
      const approve =
        body !== null &&
        typeof body === "object" &&
        "decision" in body &&
        body.decision === "approve";
      const updated: MemoryNote = {
        ...proposal,
        lifecycle: approve ? "active" : "archived",
        revision: 2,
      };
      notes = notes.map((note) => (note.id === proposal.id ? updated : note));
      return { json: { note: updated } };
    });
    api.reply(
      "POST",
      /^\/api\/memory\/notes\/[^/]+\/(archive|reviewed)/,
      (req) => {
        const id = req.pathname.split("/").at(-2);
        const note = notes.find((item) => item.id === id);
        if (!note) return { status: 404, json: { error: "Note not found" } };
        const updated: MemoryNote = {
          ...note,
          lifecycle: req.pathname.endsWith("/archive")
            ? "archived"
            : note.lifecycle,
          reviewAfter: null,
          revision: note.revision + 1,
        };
        notes = notes.map((item) => (item.id === id ? updated : item));
        return { json: { note: updated, statusReLease: null } };
      },
    );
    api.reply("POST", /^\/api\/memory\/notes\/candidate\/promote/, () => {
      const promoted: MemoryNote = {
        ...candidate,
        id: "promoted",
        scope: "project",
        sessionName: null,
        sessionCreatedAt: null,
        supersedesId: candidate.id,
      };
      const superseded: MemoryNote = {
        ...candidate,
        lifecycle: "archived",
        revision: 2,
        supersededById: promoted.id,
      };
      notes = [
        ...notes.filter((note) => note.id !== candidate.id),
        superseded,
        promoted,
      ];
      return { json: { promoted, superseded } };
    });
    api.reply("GET", "/api/memory/index", {
      json: {
        block: {
          kind: "full",
          since: null,
          text: "<memory-index>\n- project:persisted-state — Verify persisted state after saving a note\n</memory-index>",
          bytes: 111,
          budget: { bytes: 20480, hooks: 120 },
          omitted: 0,
          total: 1,
          withheld: { reviewDue: 1, expired: 0, proposed: 1 },
          entries: [],
        },
      },
    });
    if (context.name === "Loading") api.pending("GET", "/api/memory/notes");
    if (context.name === "Error")
      api.reply("GET", "/api/memory/notes", {
        status: 503,
        json: { error: "Memory unavailable" },
      });
    return () => api.restore();
  },
} satisfies Meta<typeof MemoryLibraryPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Detail: Story = { args: { initialNoteId: "lesson" } };
export const Proposals: Story = {
  args: { initialQueue: "proposed", initialNoteId: "proposal" },
};
export const PromotionCandidates: Story = {
  args: { initialQueue: "candidates" },
};
export const ReviewDue: Story = { args: { initialQueue: "review" } };
export const Empty: Story = {};
export const Loading: Story = {};
export const Error: Story = {};
export const Conflict: Story = { args: { initialNoteId: "lesson" } };
export const ChoosePreviewSubject: Story = { args: { initialView: "index" } };
export const IndexPreview: Story = {
  args: { initialView: "index", conversationId: "preview" },
};
export const Mobile: Story = {
  args: { initialQueue: "proposed", initialNoteId: "proposal" },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
