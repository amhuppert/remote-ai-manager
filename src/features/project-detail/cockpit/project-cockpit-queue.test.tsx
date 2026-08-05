// @vitest-environment jsdom
//
// Project cockpit follow-up queue (R6.1, R6.2, R6.4). These drive the REAL
// cockpit — composer, transcript, queued-message chips — with an injected fetch,
// so what is asserted is the request a user's keystroke actually produces and
// what that user then sees.
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
import NotificationListener from "@/components/NotificationListener";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
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

const ts = "2026-01-01T00:00:00.000Z";

function makeConversation(
  id: string,
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    id,
    scope: "project",
    nameOrigin: "default",
    name: id,
    transcriptPath: null,
    status: "new",
    promptCount: 2,
    createdAt: ts,
    lastActivityAt: ts,
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

function pendingEntry(id: string, text: string): PendingQueuedMessage {
  return {
    id,
    content: [{ type: "text", text }],
    status: "pending",
    enqueuedAt: ts,
    updatedAt: ts,
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: null,
  };
}

const session: SessionListItem = {
  sessionName: "auth",
  worktreePath: "/tmp/auth",
  branchName: "csm/auth",
  targetBranch: "main",
  parentSessionName: null,
  createdAt: ts,
  lastActivityAt: ts,
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "normal",
  tddEnabled: true,
  derivedStatus: "running",
  promptCount: 1,
  derivedLastActivityAt: ts,
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

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Fetch stub recording every request the cockpit makes, so a test can assert
 * WHICH endpoint a submission reached — the difference between queueing a
 * follow-up and 409-ing a prompt into a busy conversation.
 */
function recordingFetch(
  route: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | null,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    // An accepted submission also clears the durable composer draft with a
    // write to `/pending-prompt` (covered by project-cockpit-drafts.test.tsx).
    // Keep those out of `requests` so the assertions below stay about the
    // delivery path — queue versus prompt — which is what this suite pins.
    if (method !== "GET" && !url.endsWith("/pending-prompt")) {
      requests.push({ url, method, body });
    }
    return route(url, init) ?? jsonResponse({ available: false });
  }) as typeof fetch;
  return { fetch: stub, requests };
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
      conversationCreations={openConversations.map((c) => ({
        conversationId: c.id,
        creationRequestId: null,
      }))}
      projectName="proj"
      sessions={[session]}
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

/** Fill the real composer and send, the way a user does. */
async function typeAndSend(text: string) {
  const editor = await editorNode();
  fireEvent.paste(editor, {
    clipboardData: {
      items: [],
      files: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  await waitFor(() => expect(sendButton()).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(sendButton());
  });
}

/** What the composer currently holds — the user's unsent text. */
async function composerText(): Promise<string> {
  return (await editorNode()).textContent ?? "";
}

/**
 * The pending queue rows the transcript projection renders for a tab. Read from
 * the store rather than the DOM because the transcript is virtualized, so jsdom
 * mounts no rows; this is the same data `useDisplayMessages` turns into pending
 * rows on screen.
 */
function pendingRows(
  conversationId: string,
): Array<{ text: string; queueId: string | null }> {
  return (
    useSessionDetailStore
      .getState()
      .inFlight[conversationId]?.optimisticQueue.map((entry) => ({
        text: entry.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join(""),
        queueId: entry.queueId,
      })) ?? []
  );
}

async function renderCockpit(openConversations: ConversationState[]) {
  const client = seededClient(openConversations.map((c) => c.id));
  render(
    <QueryClientProvider client={client}>
      {/* The live SSE spine, mounted exactly as the app mounts it, so a queue
          row's server-side lifecycle reaches this cockpit the way it does in
          production rather than through a test-only shortcut. */}
      <NotificationListener />
      <PageHarness openConversations={openConversations} />
    </QueryClientProvider>,
  );
  showConversationsView();
  return client;
}

/** Deliver a durable queue row over SSE, the way the server reports delivery. */
function emitQueueRowDelivered(conversationId: string, queueId: string) {
  const es = FakeEventSource.instances[0];
  if (!es) throw new Error("expected an EventSource for the SSE spine");
  es.emit("message-queue-updated", {
    type: "message-queue-updated",
    scope: "project",
    projectName: "proj",
    conversationId,
    message: {
      id: queueId,
      content: [{ type: "text", text: "and also update the README" }],
      status: "delivered",
      enqueuedAt: ts,
      updatedAt: ts,
      deliveredAt: ts,
      cancelledAt: null,
      failedAt: null,
      error: null,
    },
  });
}

describe("project cockpit follow-up queue", () => {
  beforeEach(() => {
    _useCockpitViewStore.setState({
      openTabIds: [],
      activeTabId: null,
      entering: false,
      workspaceView: "conversations",
      railCollapsed: false,
    });
    useSessionDetailStore.setState({ inFlight: {} });
    FakeEventSource.reset();
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("queues a follow-up instead of discarding it when the conversation is running (R6.1)", async () => {
    const { fetch: stub, requests } = recordingFetch((url) =>
      url.includes("/queue")
        ? jsonResponse({
            queued: true,
            deliveryTiming: "in_turn",
            message: pendingEntry("q-1", "and also update the README"),
          })
        : null,
    );
    vi.stubGlobal("fetch", stub);

    await renderCockpit([makeConversation("c1", { status: "running" })]);
    selectTab("c1");
    await typeAndSend("and also update the README");

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // Addressed by project + conversation: no session segment, and above all no
    // sentinel standing in for one.
    expect(requests[0]?.url).toBe("/api/projects/proj/conversations/c1/queue");
    expect(requests[0]?.url).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toMatchObject({
      text: "and also update the README",
    });

    // And the user sees it pending rather than watching their text vanish. The
    // server's queue id is adopted, which is what makes the row cancellable and
    // lets the durable row supersede it instead of double-rendering.
    await waitFor(() => {
      expect(pendingRows("c1")).toEqual([
        { text: "and also update the README", queueId: "q-1" },
      ]);
    });
    // Queued, not sent: the composer is clear because the message is recorded.
    expect(await composerText()).toBe("");
  });

  it("stops showing a follow-up as pending once the server delivers it (R6.1, R6.3)", async () => {
    const { fetch: stub } = recordingFetch((url) =>
      url.includes("/queue")
        ? jsonResponse({
            queued: true,
            deliveryTiming: "next_turn",
            message: pendingEntry("q-1", "and also update the README"),
          })
        : null,
    );
    vi.stubGlobal("fetch", stub);

    await renderCockpit([makeConversation("c1", { status: "running" })]);
    selectTab("c1");
    await typeAndSend("and also update the README");

    await waitFor(() => {
      expect(pendingRows("c1")).toEqual([
        { text: "and also update the README", queueId: "q-1" },
      ]);
    });

    // Drained into the turn: the message is now a transcript row. Anything the
    // projection still appends for it would render the same message twice —
    // once delivered, once perpetually pending.
    await act(async () => {
      emitQueueRowDelivered("c1", "q-1");
    });

    await waitFor(() => {
      expect(pendingRows("c1")).toEqual([]);
    });
  });

  it("stops showing a follow-up as pending when delivery beats the enqueue response (R6.1, R6.3)", async () => {
    // In-turn delivery (Claude) delivers the row and broadcasts it delivered
    // BEFORE the enqueue response is written, so the terminal event routinely
    // reaches this client before it has even learned the queue id.
    let releaseQueueResponse = (): void => {};
    const queueResponded = new Promise<void>((resolve) => {
      releaseQueueResponse = resolve;
    });
    const { fetch: stub } = recordingFetch((url) =>
      url.includes("/queue")
        ? queueResponded.then(() =>
            jsonResponse({
              queued: true,
              deliveryTiming: "in_turn",
              message: pendingEntry("q-1", "and also update the README"),
            }),
          )
        : null,
    );
    vi.stubGlobal("fetch", stub);

    await renderCockpit([makeConversation("c1", { status: "running" })]);
    selectTab("c1");
    await typeAndSend("and also update the README");

    await waitFor(() => {
      expect(pendingRows("c1")).toEqual([
        { text: "and also update the README", queueId: null },
      ]);
    });

    await act(async () => {
      emitQueueRowDelivered("c1", "q-1");
      releaseQueueResponse();
      await queueResponded;
    });

    await waitFor(() => {
      expect(pendingRows("c1")).toEqual([]);
    });
  });

  it("restores the composer text when the queue submission is rejected (R6.1)", async () => {
    const { fetch: stub } = recordingFetch((url) =>
      url.includes("/queue")
        ? jsonResponse(
            { error: "Conversation is not running", code: "NOT_RUNNING" },
            409,
          )
        : null,
    );
    vi.stubGlobal("fetch", stub);

    await renderCockpit([makeConversation("c1", { status: "running" })]);
    selectTab("c1");
    await typeAndSend("work I do not want to retype");

    await waitFor(async () => {
      expect(await composerText()).toContain("work I do not want to retype");
    });
  });

  it("restores the composer text when a prompt submission is rejected (R6.1)", async () => {
    const { fetch: stub } = recordingFetch((url) =>
      url.endsWith("/prompt")
        ? jsonResponse({ error: "Conversation is busy" }, 409)
        : null,
    );
    vi.stubGlobal("fetch", stub);

    await renderCockpit([makeConversation("c1", { status: "new" })]);
    selectTab("c1");
    await typeAndSend("work I do not want to retype");

    await waitFor(async () => {
      expect(await composerText()).toContain("work I do not want to retype");
    });
  });

  it("cancels a queued project message before delivery (R6.2)", async () => {
    const { fetch: stub, requests } = recordingFetch((url, init) =>
      url.includes("/queue/") && init?.method === "DELETE"
        ? jsonResponse({ cancelled: true, id: "q-1" })
        : null,
    );
    vi.stubGlobal("fetch", stub);

    await renderCockpit([
      makeConversation("c1", {
        status: "running",
        pendingQueue: [pendingEntry("q-1", "never mind this one")],
      }),
    ]);
    selectTab("c1");

    const queued = await screen.findByRole("group", {
      name: "Pending queued messages",
    });
    expect(within(queued).getByText("never mind this one")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        within(queued).getByRole("button", { name: "Cancel queued message" }),
      );
    });

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toMatchObject({
      url: "/api/projects/proj/conversations/c1/queue/q-1",
      method: "DELETE",
    });
  });

  it("serializes within one conversation only — an idle sibling still starts its own turn (R6.4)", async () => {
    const { fetch: stub, requests } = recordingFetch((url) => {
      if (url.includes("/queue")) {
        return jsonResponse({
          queued: true,
          deliveryTiming: "in_turn",
          message: pendingEntry("q-1", "follow-up for the busy one"),
        });
      }
      if (url.endsWith("/prompt")) {
        return sseResponse([
          'event: content\ndata: {"type":"text","text":"working"}\n\n',
        ]);
      }
      return null;
    });
    vi.stubGlobal("fetch", stub);

    await renderCockpit([
      makeConversation("busy", { status: "running" }),
      makeConversation("idle", { status: "new" }),
    ]);

    selectTab("busy");
    await typeAndSend("follow-up for the busy one");
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.url).toBe(
      "/api/projects/proj/conversations/busy/queue",
    );

    // The sibling is idle, so its submission is a TURN — a project-wide queue
    // would have swallowed it into the busy conversation's queue instead.
    selectTab("idle");
    await typeAndSend("start a turn here");
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.url).toBe(
      "/api/projects/proj/conversations/idle/prompt",
    );
    expect(requests[1]?.body).toMatchObject({ prompt: "start a turn here" });
  });
});
