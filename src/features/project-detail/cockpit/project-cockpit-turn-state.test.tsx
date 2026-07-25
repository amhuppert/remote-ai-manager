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

/** Fetch stub: prompt POSTs are routed per test; everything else is inert. */
function promptFetch(
  route: (url: string) => Promise<Response> | null,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const routed = route(url);
    if (routed) return routed;
    return jsonResponse({ available: false });
  }) as typeof fetch;
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
}: {
  openConversations: ConversationState[];
}) {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  return (
    <ProjectCockpit
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
});
