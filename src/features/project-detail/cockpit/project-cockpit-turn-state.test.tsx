// @vitest-environment jsdom
//
// Project cockpit turn-state isolation (R3.1, R3.2). These drive the REAL
// cockpit — tab strip, composer, transcript — with an injected fetch, so what
// is asserted is what a user sees on each conversation's tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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
import type { ProjectConversationCreation } from "@/lib/project-conversations-client/mutations";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

/** A closed conversation the list reports, recording no creating submission. */
const CREATED_BY_NOBODY_CLOSED: ProjectConversationCreation = {
  conversationId: "c-closed",
  creationRequestId: null,
};

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * A response the test settles by hand. The resolver is captured through an
 * array so the executor's assignment needs no definite-assignment assertion.
 */
function deferredResponse(): {
  promise: Promise<Response>;
  resolve(value: Response): void;
} {
  const resolvers: Array<(value: Response) => void> = [];
  const promise = new Promise<Response>((resolve) => {
    resolvers.push(resolve);
  });
  const resolve = resolvers[0];
  if (resolve === undefined) {
    throw new Error("Promise executor did not run synchronously");
  }
  return { promise, resolve };
}

/**
 * An SSE response the test feeds one frame at a time, so the cockpit can be
 * observed mid-turn rather than only after it settles.
 */
function scriptedStream(): {
  response: Response;
  push(frame: string): Promise<void>;
  close(): Promise<void>;
} {
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.push(controller);
    },
  });
  const controller = controllers[0];
  if (controller === undefined) {
    throw new Error("stream start did not run synchronously");
  }
  const enc = new TextEncoder();
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: async (frame: string) => {
      await act(async () => {
        controller.enqueue(enc.encode(frame));
      });
    },
    close: async () => {
      await act(async () => {
        controller.close();
      });
    },
  };
}

const DONE_FRAME = "event: done\ndata: {}\n\n";
const textFrame = (text: string) =>
  `event: content\ndata: {"type":"text","text":"${text}"}\n\n`;
const conversationFrame = (id: string) =>
  `event: conversation\ndata: {"conversationId":"${id}"}\n\n`;

/** The assistant text the transcript row renderer would read for a tab. */
function assistantText(conversationId: string): string[] {
  return (
    useSessionDetailStore
      .getState()
      .inFlight[conversationId]?.optimisticMessages.filter(
        (m) => m.role === "assistant",
      )
      .flatMap((m) =>
        m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      ) ?? []
  );
}

/** The optimistic user prompt the transcript row renderer would read for a tab. */
function userText(conversationId: string): string[] {
  return (
    useSessionDetailStore
      .getState()
      .inFlight[conversationId]?.optimisticMessages.filter(
        (m) => m.role === "user",
      )
      .flatMap((m) =>
        m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      ) ?? []
  );
}

/** Fetch stub: prompt POSTs are routed per test; everything else is inert. */
function promptFetch(
  route: (url: string, init?: RequestInit) => Promise<Response> | null,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const routed = route(url, init);
    if (routed) return routed;
    return jsonResponse({ available: false });
  }) as typeof fetch;
}

/** The submission token a create-and-send request body carries. */
function creationRequestIdOf(init?: RequestInit): string {
  const parsed: unknown = JSON.parse(String(init?.body ?? "null"));
  const token =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { creationRequestId?: unknown }).creationRequestId
      : undefined;
  if (typeof token !== "string" || token === "") {
    throw new Error("create-and-send request carried no creationRequestId");
  }
  return token;
}

function seededClient(conversationIds: string[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const id of conversationIds) {
    client.setQueryData(projectConversationKeys.messages("proj", id), []);
  }
  return client;
}

function PageHarness({
  openConversations,
  // Defaults to the open conversations, each recording no creating submission —
  // the ordinary case for conversations that already existed. Tests about the
  // create-and-send id source pass the creations explicitly.
  conversationCreations,
}: {
  openConversations: ConversationState[];
  conversationCreations?: ProjectConversationCreation[];
}) {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  return (
    <ProjectCockpit
      conversationCreations={
        conversationCreations ??
        openConversations.map((c) => ({
          conversationId: c.id,
          creationRequestId: null,
        }))
      }
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

function sendButton(): HTMLElement {
  return screen.getByTestId("prompt-send");
}

/**
 * Fill the real composer and send. Tiptap attaches its EditorView in an async
 * effect, so the `.ProseMirror` node appears a tick after render; a plain-text
 * paste is how a JSDOM test gets content into it.
 */
async function typeAndSend(text: string) {
  const editor = await waitFor(
    () => {
      const node = document.querySelector(
        ".prompt-editor__content .ProseMirror",
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    },
    { timeout: 5000 },
  );
  fireEvent.paste(editor, {
    clipboardData: {
      items: [],
      files: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  await waitFor(() => expect(sendButton()).not.toBeDisabled());
  fireEvent.click(sendButton());
}

/** The send button's title is the composer's visible busy state. */
function composerBusy(): boolean {
  return sendButton().getAttribute("title") !== "Send prompt";
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
  _useCockpitViewStore.getState()._reset();
  useSessionDetailStore.getState().resetStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionDetailStore.getState().resetStore();
});

describe("project cockpit: concurrent conversation turns", () => {
  it("starts a turn in a second conversation while the first is still streaming (R3.1)", async () => {
    const held = deferredResponse();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (!url.endsWith("/prompt")) return null;
        calls.push(url);
        return url.includes("/conversations/c1/prompt")
          ? held.promise
          : Promise.resolve(sseResponse([DONE_FRAME]));
      }),
    );

    render(
      <QueryClientProvider client={seededClient(["c1", "c2"])}>
        <PageHarness
          openConversations={[makeConversation("c1"), makeConversation("c2")]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeAndSend("first prompt");
    await waitFor(() =>
      expect(calls).toContain("/api/projects/proj/conversations/c1/prompt"),
    );

    // The foundation's busy check is per conversation, so a turn running in
    // `c1` must not swallow a prompt aimed at the idle `c2`.
    selectTab("c2");
    await typeAndSend("second prompt");
    await waitFor(() =>
      expect(calls).toContain("/api/projects/proj/conversations/c2/prompt"),
    );

    held.resolve(sseResponse([DONE_FRAME]));
  });

  it("shows busy on the streaming conversation's tab only (R3.2)", async () => {
    const held = deferredResponse();
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => (url.endsWith("/prompt") ? held.promise : null)),
    );

    const { container } = render(
      <QueryClientProvider client={seededClient(["c1", "c2"])}>
        <PageHarness
          openConversations={[makeConversation("c1"), makeConversation("c2")]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeAndSend("first prompt");
    await waitFor(() => expect(composerBusy()).toBe(true));
    expect(container.querySelector(".typing-indicator")).not.toBeNull();

    selectTab("c2");
    await waitFor(() => expect(composerBusy()).toBe(false));
    expect(container.querySelector(".typing-indicator")).toBeNull();

    selectTab("c1");
    await waitFor(() => expect(composerBusy()).toBe(true));

    held.resolve(sseResponse([DONE_FRAME]));
  });

  it("shows a prompt error on its own conversation's tab only (R3.2)", async () => {
    vi.stubGlobal(
      "fetch",
      promptFetch((url) =>
        url.includes("/conversations/c1/prompt")
          ? Promise.resolve(
              jsonResponse({ error: "Conversation is busy" }, 409),
            )
          : null,
      ),
    );

    render(
      <QueryClientProvider client={seededClient(["c1", "c2"])}>
        <PageHarness
          openConversations={[makeConversation("c1"), makeConversation("c2")]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeAndSend("first prompt");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Conversation is busy",
      ),
    );

    selectTab("c2");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    selectTab("c1");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Conversation is busy",
      ),
    );
  });

  it("streams assistant content onto its own conversation's transcript only (R3.2)", async () => {
    const stream = scriptedStream();
    vi.stubGlobal(
      "fetch",
      promptFetch((url) =>
        url.includes("/conversations/c1/prompt")
          ? Promise.resolve(stream.response)
          : null,
      ),
    );

    render(
      <QueryClientProvider client={seededClient(["c1", "c2"])}>
        <PageHarness
          openConversations={[makeConversation("c1"), makeConversation("c2")]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeAndSend("first prompt");
    await stream.push(textFrame("partial answer"));

    // The transcript is virtualized, so in JSDOM the keyed in-flight state is
    // what the row renderer would read.
    await waitFor(() =>
      expect(assistantText("c1")).toContain("partial answer"),
    );
    expect(assistantText("c2")).toEqual([]);

    await stream.push(DONE_FRAME);
    await stream.close();
  });

  it("keeps each conversation's optimistic prompt on its own transcript (R3.1, R3.2)", async () => {
    const held = deferredResponse();
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (!url.endsWith("/prompt")) return null;
        return url.includes("/conversations/c1/prompt")
          ? held.promise
          : Promise.resolve(sseResponse([DONE_FRAME]));
      }),
    );

    render(
      <QueryClientProvider client={seededClient(["c1", "c2"])}>
        <PageHarness
          openConversations={[makeConversation("c1"), makeConversation("c2")]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeAndSend("first prompt");
    await waitFor(() => expect(userText("c1")).toEqual(["first prompt"]));
    expect(userText("c2")).toEqual([]);

    // The prompt a user submits is attributed to the conversation they aimed it
    // at, so a second submission neither lands on the first conversation's
    // transcript nor displaces the prompt of the turn still running there.
    selectTab("c2");
    await typeAndSend("second prompt");
    await waitFor(() => expect(userText("c2")).toEqual(["second prompt"]));
    expect(userText("c1")).toEqual(["first prompt"]);

    held.resolve(sseResponse([DONE_FRAME]));
  });
});

/**
 * The create-and-send path through the real cockpit: with no tab to report on,
 * a submission's turn state lives under the provisional key it allocated, and
 * moves onto the conversation the server names for it (R3.4, R3.7, R3.8).
 */
describe("project cockpit: create-and-send provisional identity", () => {
  it("carries the turn from its provisional key onto the conversation the server names (R3.4, R3.7)", async () => {
    const stream = scriptedStream();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (!url.endsWith("/prompt")) return null;
        calls.push(url);
        return Promise.resolve(stream.response);
      }),
    );

    const client = seededClient(["c9"]);
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <PageHarness openConversations={[]} />
      </QueryClientProvider>,
    );
    showConversationsView();

    await typeAndSend("start a new chat");
    await waitFor(() => expect(calls).toEqual(["/api/projects/proj/prompt"]));
    // There is no tab yet, so the only thing this turn can be attributed to is
    // the key its submission allocated — and the composer reports from there.
    await waitFor(() => expect(composerBusy()).toBe(true));

    await stream.push(conversationFrame("c9"));
    await stream.push(textFrame("streamed reply"));

    // The turn moved onto the conversation named for it: the prompt the user
    // submitted and the reply streamed so far are on that conversation's
    // transcript, and the composer never stopped reporting the running turn.
    await waitFor(() =>
      expect(assistantText("c9")).toEqual(["streamed reply"]),
    );
    expect(userText("c9")).toEqual(["start a new chat"]);
    expect(composerBusy()).toBe(true);

    // The list catches up and the conversation gets its tab.
    rerender(
      <QueryClientProvider client={client}>
        <PageHarness openConversations={[makeConversation("c9")]} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const tabs = screen.getByRole("tablist", { name: "Conversations" });
      expect(within(tabs).getByRole("tab", { name: /c9/ })).toBeTruthy();
    });
    expect(composerBusy()).toBe(true);

    await stream.push(DONE_FRAME);
    await stream.close();
    await waitFor(() => expect(composerBusy()).toBe(false));
  });

  it("carries the turn onto the conversation the list reports for its submission, with no stream frame (R3.5, R3.7)", async () => {
    // The fallback source, through the real cockpit: the `conversation` frame
    // never arrives, and the list names the turn because the conversation the
    // server created records this submission's token.
    const stream = scriptedStream();
    let sentToken: string | null = null;
    vi.stubGlobal(
      "fetch",
      promptFetch((url, init) => {
        if (!url.endsWith("/proj/prompt")) return null;
        sentToken = creationRequestIdOf(init);
        return Promise.resolve(stream.response);
      }),
    );

    const client = seededClient(["c-listed"]);
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <PageHarness openConversations={[]} conversationCreations={[]} />
      </QueryClientProvider>,
    );
    showConversationsView();

    await typeAndSend("start a new chat");
    await waitFor(() => expect(composerBusy()).toBe(true));
    await stream.push(textFrame("streamed reply"));
    const token = sentToken;
    if (token === null) throw new Error("no create-and-send request was made");

    rerender(
      <QueryClientProvider client={client}>
        <PageHarness
          openConversations={[makeConversation("c-listed")]}
          conversationCreations={[
            { conversationId: "c-listed", creationRequestId: token },
          ]}
        />
      </QueryClientProvider>,
    );

    // The turn moved onto its conversation: the tab is there, the prompt and the
    // reply streamed before the name are on its transcript, and the composer
    // never stopped reporting the running turn.
    await waitFor(() =>
      expect(userText("c-listed")).toEqual(["start a new chat"]),
    );
    expect(assistantText("c-listed")).toEqual(["streamed reply"]);
    const tabs = screen.getByRole("tablist", { name: "Conversations" });
    expect(within(tabs).getByRole("tab", { name: /c-listed/ })).toBeTruthy();
    expect(composerBusy()).toBe(true);

    await stream.push(DONE_FRAME);
    await stream.close();
    await waitFor(() => expect(composerBusy()).toBe(false));
  });

  it("does not hand the turn a conversation that was merely reopened while the send is pending (R3.5, R3.6, R3.7)", async () => {
    // Reopening a closed conversation adds it to the open list without creating
    // anything, so it records no creating submission — and a conversation that
    // records none can never name a pending turn, however new it looks to this
    // client.
    const stream = scriptedStream();
    vi.stubGlobal(
      "fetch",
      promptFetch((url) =>
        url.endsWith("/proj/prompt") ? Promise.resolve(stream.response) : null,
      ),
    );

    const client = seededClient(["c-closed", "c-new"]);
    // `c-closed` exists but is closed: absent from the open list, present in the
    // project's complete set.
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <PageHarness
          openConversations={[]}
          conversationCreations={[CREATED_BY_NOBODY_CLOSED]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    await typeAndSend("start a new chat");
    await waitFor(() => expect(composerBusy()).toBe(true));
    await stream.push(textFrame("streamed reply"));

    // The user reopens it from the rail while the send is still unnamed.
    rerender(
      <QueryClientProvider client={client}>
        <PageHarness
          openConversations={[makeConversation("c-closed")]}
          conversationCreations={[CREATED_BY_NOBODY_CLOSED]}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const tabs = screen.getByRole("tablist", { name: "Conversations" });
      expect(within(tabs).getByRole("tab", { name: /c-closed/ })).toBeTruthy();
    });
    expect(userText("c-closed")).toEqual([]);
    expect(assistantText("c-closed")).toEqual([]);

    // The turn's own stream still names the conversation actually created for it.
    await stream.push(conversationFrame("c-new"));
    await waitFor(() =>
      expect(userText("c-new")).toEqual(["start a new chat"]),
    );
    expect(assistantText("c-new")).toEqual(["streamed reply"]);
    expect(userText("c-closed")).toEqual([]);

    await stream.push(DONE_FRAME);
    await stream.close();
  });

  it("does not hand the turn a conversation revealed when the list finishes loading (R3.5, R3.6)", async () => {
    // The cockpit reports `[]` while the conversation list query is pending, so
    // everything the resolved list then reveals is new to this client. None of it
    // records this submission, so none of it can name the turn — no baseline
    // bookkeeping required.
    const stream = scriptedStream();
    vi.stubGlobal(
      "fetch",
      promptFetch((url) =>
        url.endsWith("/proj/prompt") ? Promise.resolve(stream.response) : null,
      ),
    );

    const client = seededClient(["c-existing", "c-new"]);
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <PageHarness openConversations={[]} conversationCreations={[]} />
      </QueryClientProvider>,
    );
    showConversationsView();

    await typeAndSend("start a new chat");
    await waitFor(() => expect(composerBusy()).toBe(true));
    await stream.push(textFrame("streamed reply"));

    // The list resolves, revealing a conversation that existed all along.
    rerender(
      <QueryClientProvider client={client}>
        <PageHarness
          openConversations={[makeConversation("c-existing")]}
          conversationCreations={[
            { conversationId: "c-existing", creationRequestId: null },
          ]}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const tabs = screen.getByRole("tablist", { name: "Conversations" });
      expect(
        within(tabs).getByRole("tab", { name: /c-existing/ }),
      ).toBeTruthy();
    });
    expect(userText("c-existing")).toEqual([]);
    expect(assistantText("c-existing")).toEqual([]);

    // The turn's own stream names the conversation actually created for it.
    await stream.push(conversationFrame("c-new"));
    await waitFor(() =>
      expect(userText("c-new")).toEqual(["start a new chat"]),
    );
    expect(assistantText("c-new")).toEqual(["streamed reply"]);
    expect(userText("c-existing")).toEqual([]);

    await stream.push(DONE_FRAME);
    await stream.close();
  });

  it("shows a failure that arrived before any conversation id on the create composer, and dismissing it releases the key (R3.8)", async () => {
    vi.stubGlobal(
      "fetch",
      promptFetch((url) =>
        url.endsWith("/proj/prompt")
          ? Promise.resolve(jsonResponse({ error: "Project is busy" }, 409))
          : null,
      ),
    );

    render(
      <QueryClientProvider client={seededClient([])}>
        <PageHarness openConversations={[]} />
      </QueryClientProvider>,
    );
    showConversationsView();

    await typeAndSend("start a new chat");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Project is busy"),
    );
    expect(composerBusy()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // The key held nothing but that failure, so dismissing it leaves the
    // composer with no turn to report at all.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(composerBusy()).toBe(false);
  });
});

/**
 * Stop for a project conversation (R5.1, R5.2). A project turn executes
 * directly in the shared main worktree, so these drive the real cockpit to the
 * point where a turn is running and assert what the user can actually do about
 * it — and that doing it reaches only the conversation they aimed at.
 */
describe("project cockpit: stopping a running turn", () => {
  /** The header Stop control for the conversation on screen. */
  function stopButton(): HTMLElement | null {
    return screen.queryByRole("button", { name: "Stop agent" });
  }

  it("offers no Stop while the conversation is idle", async () => {
    vi.stubGlobal(
      "fetch",
      promptFetch(() => null),
    );

    render(
      <QueryClientProvider client={seededClient(["c1"])}>
        <PageHarness openConversations={[makeConversation("c1")]} />
      </QueryClientProvider>,
    );
    showConversationsView();
    selectTab("c1");

    expect(stopButton()).toBeNull();
  });

  it("stops the running turn through the project abort route (R5.1)", async () => {
    const stream = scriptedStream();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (url.endsWith("/prompt")) {
          posts.push(url);
          return Promise.resolve(stream.response);
        }
        if (url.endsWith("/abort")) {
          posts.push(url);
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return null;
      }),
    );

    render(
      <QueryClientProvider client={seededClient(["c1"])}>
        <PageHarness openConversations={[makeConversation("c1")]} />
      </QueryClientProvider>,
    );
    showConversationsView();
    selectTab("c1");
    await typeAndSend("long running work");
    await stream.push(textFrame("working"));

    const stop = await waitFor(() => {
      const btn = stopButton();
      expect(btn).not.toBeNull();
      return btn as HTMLElement;
    });
    fireEvent.click(stop);

    // The project addressing shape: no session segment, and no sentinel.
    await waitFor(() =>
      expect(posts).toContain("/api/projects/proj/conversations/c1/abort"),
    );
    expect(posts.join(" ")).not.toContain("/sessions/");
    expect(posts.join(" ")).not.toContain("__project__");

    // The local in-flight state settles rather than waiting on a stream the
    // aborted turn will never close.
    await waitFor(() =>
      expect(useSessionDetailStore.getState().inFlight["c1"]?.sending).toBe(
        false,
      ),
    );
    await waitFor(() => expect(composerBusy()).toBe(false));
  });

  it("leaves other project conversations' turns untouched (R5.2)", async () => {
    const first = scriptedStream();
    const second = scriptedStream();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (url.includes("/conversations/c1/prompt")) {
          return Promise.resolve(first.response);
        }
        if (url.includes("/conversations/c2/prompt")) {
          return Promise.resolve(second.response);
        }
        if (url.endsWith("/abort")) {
          posts.push(url);
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return null;
      }),
    );

    render(
      <QueryClientProvider client={seededClient(["c1", "c2"])}>
        <PageHarness
          openConversations={[makeConversation("c1"), makeConversation("c2")]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    selectTab("c1");
    await typeAndSend("first prompt");
    await first.push(textFrame("first output"));

    selectTab("c2");
    await typeAndSend("second prompt");
    await second.push(textFrame("second output"));

    // Stop is scoped to the conversation on screen, so stopping from c2's tab
    // stops c2 — and only c2.
    const stop = await waitFor(() => {
      const btn = stopButton();
      expect(btn).not.toBeNull();
      return btn as HTMLElement;
    });
    fireEvent.click(stop);

    await waitFor(() =>
      expect(posts).toEqual(["/api/projects/proj/conversations/c2/abort"]),
    );
    await waitFor(() =>
      expect(useSessionDetailStore.getState().inFlight["c2"]?.sending).toBe(
        false,
      ),
    );

    // c1's turn is still streaming: its indicator, its optimistic prompt, and
    // its streamed content all survive the stop aimed at c2.
    expect(useSessionDetailStore.getState().inFlight["c1"]?.sending).toBe(true);
    expect(assistantText("c1")).toEqual(["first output"]);
    expect(userText("c1")).toEqual(["first prompt"]);
    await first.push(textFrame("first output continues"));
    expect(assistantText("c1")).toEqual([
      "first output",
      "first output continues",
    ]);
  });

  it("settles the local turn when the server reports nothing was running (R5.2)", async () => {
    const stream = scriptedStream();
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (url.endsWith("/prompt")) return Promise.resolve(stream.response);
        // 409: the turn had already ended server-side. The user still asked to
        // stop, so the local state must not stay stuck on "sending".
        if (url.endsWith("/abort")) {
          return Promise.resolve(
            jsonResponse({ error: "No running prompt to abort" }, 409),
          );
        }
        return null;
      }),
    );

    render(
      <QueryClientProvider client={seededClient(["c1"])}>
        <PageHarness openConversations={[makeConversation("c1")]} />
      </QueryClientProvider>,
    );
    showConversationsView();
    selectTab("c1");
    await typeAndSend("work");
    await stream.push(textFrame("partial"));

    const stop = await waitFor(() => {
      const btn = stopButton();
      expect(btn).not.toBeNull();
      return btn as HTMLElement;
    });
    fireEvent.click(stop);

    await waitFor(() =>
      expect(useSessionDetailStore.getState().inFlight["c1"]?.sending).toBe(
        false,
      ),
    );
    // A user-initiated stop is not a prompt failure.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Stop for a turn this client did not start (R5.1)", async () => {
    vi.stubGlobal(
      "fetch",
      promptFetch(() => null),
    );

    render(
      <QueryClientProvider client={seededClient(["c1"])}>
        <PageHarness
          openConversations={[makeConversation("c1", { status: "running" })]}
        />
      </QueryClientProvider>,
    );
    showConversationsView();
    selectTab("c1");

    // A turn started from another tab, or recovered after a reload, is still
    // the user's to stop — server status is the second source of "running".
    expect(stopButton()).not.toBeNull();
  });
});

/**
 * Stop then resend in the same conversation. The stopped turn is still
 * unwinding when the replacement starts, so both turns' teardown touches the
 * same key — and only the live one may own it.
 */
describe("project cockpit: stop then resend", () => {
  it("leaves the replacement turn running when the stopped turn unwinds (R5.2)", async () => {
    const stopped = scriptedStream();
    const replacement = scriptedStream();
    const promptCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      promptFetch((url) => {
        if (url.endsWith("/prompt")) {
          promptCalls.push(url);
          return Promise.resolve(
            promptCalls.length === 1 ? stopped.response : replacement.response,
          );
        }
        if (url.endsWith("/abort")) return Promise.resolve(jsonResponse({}));
        return null;
      }),
    );

    render(
      <QueryClientProvider client={seededClient(["c1"])}>
        <PageHarness openConversations={[makeConversation("c1")]} />
      </QueryClientProvider>,
    );
    showConversationsView();
    selectTab("c1");

    await typeAndSend("first attempt");
    await stopped.push(textFrame("partial"));
    fireEvent.click(
      await waitFor(() => {
        const btn = screen.queryByRole("button", { name: "Stop agent" });
        expect(btn).not.toBeNull();
        return btn as HTMLElement;
      }),
    );
    await waitFor(() => expect(composerBusy()).toBe(false));

    await typeAndSend("second attempt");
    await waitFor(() => expect(promptCalls).toHaveLength(2));
    expect(composerBusy()).toBe(true);

    // The stopped turn's connection finally closes. Its teardown must not
    // settle the key the replacement now owns.
    await stopped.close();

    expect(useSessionDetailStore.getState().inFlight["c1"]?.sending).toBe(true);
    expect(composerBusy()).toBe(true);
    await replacement.push(textFrame("replacement output"));
    expect(assistantText("c1")).toContain("replacement output");
  });
});
