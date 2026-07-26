// @vitest-environment jsdom
//
// Conversation-local project drafts (R3.3). These drive the REAL cockpit and
// its real composer with an injected fetch, so what is asserted is the draft a
// user sees on each conversation's tab — text and image attachments alike — and
// the request that makes the draft outlive the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import ProjectCockpit from "./ProjectCockpit";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { useProjectConversationsQuery } from "@/lib/project-conversations-client/queries";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", effort: "medium" },
  codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
};

function makeConversation(
  id: string,
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    id,
    scope: "project",
    name: id,
    transcriptPath: null,
    status: "new",
    promptCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    ...o,
  };
}

const runningSession: SessionListItem = {
  sessionName: "auth",
  worktreePath: "/tmp/auth",
  branchName: "csm/auth",
  targetBranch: "main",
  parentSessionName: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "normal",
  tddEnabled: true,
  derivedStatus: "running",
  promptCount: 1,
  derivedLastActivityAt: "2026-01-01T00:00:00Z",
  collabContribution: null,
  hasActiveGraphWorkflow: false,
};

interface RecordedRequest {
  url: string;
  body: unknown;
}

/** Fetch stub recording every write; reads answer inert. */
function recordingFetch(recorded: RecordedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method !== undefined && init.method !== "GET") {
      recorded.push({
        url,
        body: JSON.parse(String(init.body ?? "null")) as unknown,
      });
      return new Response(JSON.stringify({ ok: true, updated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ available: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function seededClient(conversations: ConversationState[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const conversation of conversations) {
    client.setQueryData(
      projectConversationKeys.messages("proj", conversation.id),
      [],
    );
  }
  client.setQueryData(projectConversationKeys.list("proj"), conversations);
  return client;
}

/**
 * Sources the cockpit's conversations from the query the real project page uses,
 * rather than from a fixed array. A draft is persisted onto the conversation
 * record, so the cache is the surface a re-selected tab reads it back from —
 * a harness that pinned the prop would assert against state the app never sees.
 */
function PageHarness() {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  const conversationsQuery = useProjectConversationsQuery("proj");
  const openConversations = conversationsQuery.data ?? [];
  return (
    <ProjectCockpit
      conversationCreations={openConversations.map((c) => ({
        conversationId: c.id,
        creationRequestId: null,
      }))}
      projectName="proj"
      sessions={[runningSession]}
      archivedCount={0}
      tokens={tokens}
      onTokensChange={setTokens}
      onRunCommand={vi.fn()}
      selectedBackend={backend}
      onSelectedBackendChange={setBackend}
      backendDefaults={BACKEND_DEFAULTS}
      openConversations={openConversations}
      rail={<div data-testid="rail-stub" />}
    />
  );
}

function showConversationsView() {
  const viewTabs = screen.getByRole("tablist", { name: "Project view" });
  fireEvent.click(within(viewTabs).getByRole("tab", { name: /Conversations/ }));
}

function selectTab(name: string) {
  const tabs = screen.getByRole("tablist", { name: "Conversations" });
  fireEvent.click(within(tabs).getByRole("tab", { name: new RegExp(name) }));
}

/**
 * Tiptap attaches its EditorView in an async effect, so the `.ProseMirror` node
 * appears a tick after render.
 */
async function editorNode(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const node = document.querySelector(
        ".prompt-editor__content .ProseMirror",
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    },
    { timeout: 5000 },
  );
}

/** A plain-text paste is how a JSDOM test gets content into Tiptap. */
async function typeDraft(text: string) {
  const editor = await editorNode();
  fireEvent.paste(editor, {
    clipboardData: {
      items: [],
      files: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  await waitFor(() => expect(editor.textContent).toContain(text));
}

async function draftText(): Promise<string> {
  return (await editorNode()).textContent ?? "";
}

/** Attach an image through the composer's real hidden file input. */
async function attachImage(fileName: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"][accept*="image"]',
  );
  expect(input).not.toBeNull();
  const file = new File(["image-bytes"], fileName, { type: "image/png" });
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByAltText(fileName)).toBeTruthy());
}

beforeEach(() => {
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
  // jsdom implements neither object-URL method; the attachment hook mints a
  // preview URL for every file it accepts.
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
  _useCockpitViewStore.getState()._reset();
  useSessionDetailStore.getState().resetStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionDetailStore.getState().resetStore();
});

describe("project cockpit: conversation-local drafts (R3.3)", () => {
  it("does not carry a draft to another conversation's tab", async () => {
    vi.stubGlobal("fetch", recordingFetch([]));
    const conversations = [makeConversation("c1"), makeConversation("c2")];

    render(
      <QueryClientProvider client={seededClient(conversations)}>
        <PageHarness />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeDraft("draft meant for c1");

    selectTab("c2");
    await waitFor(async () =>
      expect(await draftText()).not.toContain("draft meant for c1"),
    );
  });

  it("restores the draft when its own tab is selected again", async () => {
    vi.stubGlobal("fetch", recordingFetch([]));
    const conversations = [makeConversation("c1"), makeConversation("c2")];

    render(
      <QueryClientProvider client={seededClient(conversations)}>
        <PageHarness />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeDraft("draft meant for c1");
    selectTab("c2");
    await waitFor(async () =>
      expect(await draftText()).not.toContain("draft meant for c1"),
    );

    selectTab("c1");
    await waitFor(async () =>
      expect(await draftText()).toContain("draft meant for c1"),
    );
  });

  it("does not carry an image attachment to another conversation's tab", async () => {
    vi.stubGlobal("fetch", recordingFetch([]));
    const conversations = [makeConversation("c1"), makeConversation("c2")];

    render(
      <QueryClientProvider client={seededClient(conversations)}>
        <PageHarness />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await attachImage("for-c1.png");

    selectTab("c2");
    await waitFor(() =>
      expect(screen.queryByAltText("for-c1.png")).toBeNull(),
    );

    selectTab("c1");
    await waitFor(() => expect(screen.getByAltText("for-c1.png")).toBeTruthy());
  });

  it("persists the draft to the conversation's project pending-prompt route", async () => {
    const recorded: RecordedRequest[] = [];
    vi.stubGlobal("fetch", recordingFetch(recorded));
    const conversations = [makeConversation("c1"), makeConversation("c2")];

    render(
      <QueryClientProvider client={seededClient(conversations)}>
        <PageHarness />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeDraft("survive the reload");
    // Switching tabs flushes the debounced save, so the assertion needs no
    // timer control — and the URL proves the sentinel never reaches a URL.
    selectTab("c2");

    await waitFor(() =>
      expect(
        recorded.filter((r) =>
          r.url.endsWith("/api/projects/proj/conversations/c1/pending-prompt"),
        ),
      ).toEqual([
        {
          url: "/api/projects/proj/conversations/c1/pending-prompt",
          body: { text: "survive the reload" },
        },
      ]),
    );
  });

  it("hydrates a persisted draft on mount, the way a page reload delivers it", async () => {
    vi.stubGlobal("fetch", recordingFetch([]));
    const conversations = [
      makeConversation("c1", { pendingPromptText: "written before reload" }),
      makeConversation("c2"),
    ];

    render(
      <QueryClientProvider client={seededClient(conversations)}>
        <PageHarness />
      </QueryClientProvider>,
    );
    showConversationsView();
    selectTab("c1");

    await waitFor(async () =>
      expect(await draftText()).toContain("written before reload"),
    );
  });
});
