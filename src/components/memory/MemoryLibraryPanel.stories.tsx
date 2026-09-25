import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
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

const longNote: MemoryNote = {
  ...base,
  id: "long",
  slug: "graph-workflow-shared-docs-revert-between-turns-under-concurrent-lane-writes",
  indexMode: "always",
  hook: "A registered graph-workflow shared doc can silently revert to an earlier revision between agent turns when two lanes write it concurrently; re-read the doc at the start of every turn and never trust the copy from the previous turn.",
  body: Array.from(
    { length: 12 },
    (_, index) =>
      `Step ${index + 1}: re-read the shared document, compare its revision with the one the lane last wrote, and stop if they differ.`,
  ).join("\n"),
  statusNote: {
    text: "Still reproducing on the lane runner after the last engine change; recheck once the join fix merges.",
    updatedAt: "2026-09-04T00:00:00.000Z",
    reviewAfter: "2026-09-20T00:00:00.000Z",
  },
  revision: 4,
  updatedAt: "2026-09-07T12:00:00.000Z",
};

const libraryNotes: MemoryNote[] = [
  longNote,
  {
    ...base,
    id: "validation",
    slug: "session-validation-wrapper",
    hook: "Session validation runs the registered checkout’s scripts with the session worktree as cwd; wrapper edits are only exercised after merging.",
    indexMode: "always",
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  {
    ...base,
    id: "schema",
    slug: "build-opens-live-db",
    hook: "Next.js builds open the live database. A schema version raised on main can break an older branch at an unrelated route.",
    indexMode: "always",
    updatedAt: "2026-09-06T22:00:00.000Z",
  },
  {
    ...base,
    id: "dev-server",
    slug: "verify-session-server",
    kind: "procedure",
    hook: "Run cctl dev ensure before browser verification and use the URL returned for this session.",
    updatedAt: "2026-09-06T20:00:00.000Z",
  },
  {
    ...base,
    id: "style",
    slug: "prefer-early-returns",
    scope: "global",
    projectPath: null,
    kind: "preference",
    createdBy: "user",
    hook: "Prefer early returns to nested conditionals so the main path stays easy to read.",
    updatedAt: "2026-09-06T18:00:00.000Z",
  },
  {
    ...base,
    id: "env",
    slug: "macos-process-environment",
    hook: "macOS ps -E flattens environment records; use sysctl KERN_PROCARGS2 when exact values matter.",
    indexMode: "search-only",
    updatedAt: "2026-09-06T15:00:00.000Z",
  },
  {
    ...base,
    id: "query",
    slug: "query-survives-remount",
    hook: "Mount-time query mutations can lose their result on remount and stay pending. Use a query for data the view needs to retain.",
    updatedAt: "2026-09-06T12:00:00.000Z",
  },
  {
    ...base,
    id: "tests",
    slug: "require-matched-tests",
    kind: "procedure",
    hook: "Use --require-match when citing a scoped test pass; a successful run can otherwise contain no matching tests.",
    updatedAt: "2026-09-05T20:00:00.000Z",
  },
  {
    ...base,
    id: "focus",
    slug: "store-driven-dialog-focus",
    hook: "Store-opened dialogs need an explicit return target when the trigger blurs before the focus scope mounts.",
    updatedAt: "2026-09-05T10:00:00.000Z",
  },
];

/** Per-story fixture behavior for the note-update route. */
type PatchBehavior = "persist" | "pending" | "error" | "conflict";

function patchBehaviorOf(parameters: Record<string, unknown>): PatchBehavior {
  const value = parameters["memoryPatch"];
  return value === "pending" || value === "error" || value === "conflict"
    ? value
    : "persist";
}

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
      <div
        className="flex h-screen min-h-0 flex-col gap-lg bg-bg-void p-xl max-768:p-md"
        style={args.layout === "compact" ? { maxWidth: 420 } : undefined}
      >
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
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
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
      context.name === "Empty"
        ? []
        : [base, proposal, candidate, due, ...libraryNotes];
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
    api.reply("GET", /^\/api\/memory\/notes\/[^/]+\/revisions/, (req) => ({
      json: {
        revisions: req.pathname.includes("/long/")
          ? [3, 2, 1].map((revision) => ({
              id: `long-rev-${revision}`,
              memoryId: longNote.id,
              revision,
              snapshot: { ...longNote, revision },
              origin: revision === 1 ? "create" : "edit",
              baseRevision: revision === 1 ? null : revision - 1,
              restoredFromRevision: null,
              authorKind: "agent",
              authorConversationId: null,
              createdAt: `2026-09-0${revision}T00:00:00.000Z`,
            }))
          : [],
      },
    }));
    const patchBehavior = patchBehaviorOf(context.parameters);
    api.reply("PATCH", /^\/api\/memory\/notes\//, (req) => {
      const note = notes.find((note) => req.pathname.endsWith(`/${note.id}`));
      if (!note) return { status: 404, json: { error: "Note not found" } };
      if (patchBehavior === "error")
        return {
          status: 503,
          json: { error: "The memory store is temporarily unavailable." },
        };
      if (context.name === "Conflict" || patchBehavior === "conflict")
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
    if (patchBehavior === "pending")
      api.pending("PATCH", /^\/api\/memory\/notes\//);
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
type StoryContext = Parameters<NonNullable<Story["play"]>>[0];

/** The page, including portalled menus, listboxes, and dialogs. */
function page(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body);
}

async function chooseMode(
  canvasElement: HTMLElement,
  label: "Always" | "Auto" | "Search only",
) {
  const group = await page(canvasElement).findByRole("radiogroup", {
    name: "Index inclusion",
  });
  await userEvent.click(within(group).getByRole("radio", { name: label }));
}

async function saveModeChange({ canvasElement }: StoryContext) {
  await chooseMode(canvasElement, "Always");
  await userEvent.click(
    page(canvasElement).getByRole("button", { name: "Save note" }),
  );
}

async function openHelp({ canvasElement }: StoryContext) {
  const body = page(canvasElement);
  await userEvent.click(
    await body.findByRole("button", { name: "How memory works" }),
  );
  const dialog = await body.findByRole("dialog", { name: "How memory works" });
  // The dialog animates in from transparent.
  await waitFor(() => expect(dialog).toBeVisible());
}

export const Default: Story = {};
export const Detail: Story = { args: { initialNoteId: "lesson" } };
export const DetailAlways: Story = { args: { initialNoteId: "validation" } };
export const DetailSearchOnly: Story = { args: { initialNoteId: "env" } };
export const ModeDirty: Story = {
  args: { initialNoteId: "lesson" },
  play: async ({ canvasElement }) => {
    await chooseMode(canvasElement, "Search only");
    await expect(
      page(canvasElement).getByRole("button", { name: "Save note" }),
    ).toBeEnabled();
  },
};
export const Saving: Story = {
  args: { initialNoteId: "lesson" },
  parameters: { memoryPatch: "pending" },
  play: async (context) => {
    await saveModeChange(context);
    await expect(
      await page(context.canvasElement).findByText("Saving…"),
    ).toBeVisible();
  },
};
export const SaveError: Story = {
  args: { initialNoteId: "lesson" },
  parameters: { memoryPatch: "error" },
  play: async (context) => {
    await saveModeChange(context);
    await expect(
      await page(context.canvasElement).findByRole("alert"),
    ).toHaveTextContent("temporarily unavailable");
  },
};
export const ModeFilteredEmpty: Story = {
  play: async ({ canvasElement }) => {
    const body = page(canvasElement);
    await userEvent.click(
      await body.findByRole("combobox", { name: "Index inclusion" }),
    );
    await userEvent.click(
      await body.findByRole("option", { name: "Search only" }),
    );
    await userEvent.type(body.getByRole("searchbox"), "no note says this");
    await expect(await body.findByText("No matching memories")).toBeVisible();
  },
};
export const Proposals: Story = {
  args: { initialQueue: "proposed", initialNoteId: "proposal" },
};
export const PromotionCandidates: Story = {
  args: { initialQueue: "candidates" },
};
export const ReviewDue: Story = { args: { initialQueue: "review" } };
export const NeedsAttention: Story = { args: { initialQueue: "attention" } };
export const Compact: Story = { args: { layout: "compact" } };
export const Empty: Story = {};
export const Loading: Story = {};
export const Error: Story = {};
export const Conflict: Story = {
  args: { initialNoteId: "lesson" },
  play: async (context) => {
    await saveModeChange(context);
    await expect(
      await page(context.canvasElement).findByRole("alert"),
    ).toHaveTextContent("revision 2");
  },
};
export const ChoosePreviewSubject: Story = { args: { initialView: "index" } };
export const IndexPreview: Story = {
  args: { initialView: "index", conversationId: "preview" },
};
export const IndexPreviewLimits: Story = {
  args: { initialView: "index", conversationId: "preview" },
  play: async ({ canvasElement }) => {
    const body = page(canvasElement);
    await userEvent.click(
      await body.findByRole("button", { name: "Preview limits" }),
    );
    await waitFor(() =>
      expect(body.getByTestId("memory-index-preview-boundary")).toBeVisible(),
    );
  },
};
export const Mobile: Story = {
  args: { initialQueue: "proposed", initialNoteId: "proposal" },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const MobileLibrary: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const LongDetail: Story = { args: { initialNoteId: "long" } };
export const MemoryHelp: Story = { play: openHelp };
export const MemoryHelpMobile: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: openHelp,
};
export const MemoryHelpDirtyEditor: Story = {
  args: { initialNoteId: "lesson" },
  play: async (context) => {
    const body = page(context.canvasElement);
    await chooseMode(context.canvasElement, "Always");
    await openHelp(context);
    await userEvent.click(
      body.getByRole("button", { name: "Close memory help" }),
    );
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
    const group = body.getByRole("radiogroup", { name: "Index inclusion" });
    await expect(
      within(group).getByRole("radio", { name: "Always" }),
    ).toBeChecked();
    await expect(body.getByText("Unsaved changes")).toBeVisible();
  },
};
