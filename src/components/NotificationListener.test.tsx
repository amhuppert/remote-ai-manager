// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotificationListener from "./NotificationListener";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import {
  collaborationKeys,
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
} from "@/lib/workflows/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { notificationKeys } from "@/lib/notifications/query-keys";
import type {
  JobNotification,
  NotificationsResponse,
} from "@/lib/notifications/schemas";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { contextArtifactKeys } from "@/lib/context-artifacts/query-keys";
import { markdownDocumentKeys } from "@/lib/documents/query-keys";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { PendingQueuedMessageStatus } from "@/lib/conversations/message-queue-schemas";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";
import { normalizeTicketListFilters } from "@/lib/tickets/list-filters";
import { ticketKeys } from "@/lib/tickets/query-keys";

const notificationStoreMocks = vi.hoisted(() => ({
  addOrUpdateJob: vi.fn(),
  reconcileJobs: vi.fn(),
  enqueueToast: vi.fn(),
  enqueueInputToast: vi.fn(),
  enqueuePromptErrorToast: vi.fn(),
  enqueueMergeDonePrompt: vi.fn(),
}));

vi.mock("@/stores/notification.store", () => ({
  useAddOrUpdateJob: () => notificationStoreMocks.addOrUpdateJob,
  useReconcileJobs: () => notificationStoreMocks.reconcileJobs,
  useEnqueueToast: () => notificationStoreMocks.enqueueToast,
  useEnqueueInputToast: () => notificationStoreMocks.enqueueInputToast,
  useEnqueuePromptErrorToast: () =>
    notificationStoreMocks.enqueuePromptErrorToast,
  useEnqueueMergeDonePrompt: () =>
    notificationStoreMocks.enqueueMergeDonePrompt,
}));

class FakeBrowserNotification {
  static instances: FakeBrowserNotification[] = [];
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();

  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null = null;
  closed = false;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeBrowserNotification.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWithClient(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <NotificationListener />
    </QueryClientProvider>,
  );
}

function stubHiddenDocument(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

function stubBrowserNotifications(permission: NotificationPermission) {
  FakeBrowserNotification.instances = [];
  FakeBrowserNotification.permission = permission;
  FakeBrowserNotification.requestPermission = vi.fn(() =>
    Promise.resolve(permission),
  );
  vi.stubGlobal("Notification", FakeBrowserNotification);
}

/** A durable queue row as the `message-queue-updated` wire payload carries it. */
function queuedMessageView(id: string, status: PendingQueuedMessageStatus) {
  return {
    id,
    content: [{ type: "text", text: "follow up" }],
    status,
    enqueuedAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:01.000Z",
    deliveredAt: status === "delivered" ? "2026-04-28T00:00:01.000Z" : null,
    cancelledAt: status === "cancelled" ? "2026-04-28T00:00:01.000Z" : null,
    failedAt: status === "failed" ? "2026-04-28T00:00:01.000Z" : null,
    error: null,
  };
}

/** The pending rows this client would still render for a conversation. */
function optimisticQueueFor(conversationId: string) {
  return (
    useSessionDetailStore.getState().inFlight[conversationId]
      ?.optimisticQueue ?? []
  );
}

function makeProjectConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "pc-1",
    scope: "project",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 0,
    createdAt: "2026-04-28T00:00:00.000Z",
    lastActivityAt: "2026-04-28T00:00:00.000Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    spawnedSessionIds: [],
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    ...overrides,
  };
}

describe("NotificationListener", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stubHiddenDocument(false);
  });

  it("registers every SSE domain on the shared connection and closes it on unmount", () => {
    const client = makeClient();
    const { unmount } = renderWithClient(client);
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");
    const close = vi.spyOn(es, "close");

    expect([...es.listeners.keys()]).toEqual(
      expect.arrayContaining([
        "conversation-status",
        "spawn-result",
        "job-status",
        "notification-created",
        "debug-mode-status",
        "dev-server-status",
        "graph-workflow-status",
        "mcp-tools-updated",
        "mcp-config-updated",
        "agent-capabilities-updated",
        "agent-capabilities-discovery-updated",
        "agent-profile-library-changed",
        "session-alignment-updated",
        "spec-changed",
        "spec-approval-changed",
        "ticket-changed",
        "context_artifact_status",
        "error",
        "open",
      ]),
    );

    unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it("invalidates MCP config queries when tools are refreshed", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("mcp-tools-updated", {
      type: "mcp-tools-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      serverKey: "calc",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: mcpConfigKeys.all,
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: mcpToolsKeys.inventory("proj", "sess", "conv-1", "calc"),
    });
  });

  it("invalidates the targeted conversation's messages on conversation-status events", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: conversationKeys.messages("proj", "sess", "conv-1"),
      }),
    );
  });

  it("projects conversation-status into the session conversation list before prompt routing reads it", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("proj", "sess");
    client.setQueryData(listKey, [
      { id: "conv-1", status: "running" },
      { id: "conv-2", status: "awaiting" },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "awaiting",
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<Array<{ id: string; status: string }>>(listKey);
      expect(cached?.find((c) => c.id === "conv-1")?.status).toBe("awaiting");
    });
    expect(
      client.getQueryData<Array<{ id: string; status: string }>>(listKey),
    ).toContainEqual({ id: "conv-2", status: "awaiting" });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: listKey });
  });

  // Regression: the compaction status chip derives `stale` at fetch time, so
  // without a turn-end invalidation it reads "Fresh" until an unrelated
  // refetch (staleTime). A conversation-status transition out of "running"
  // must refetch that conversation's artifact queries — and only that
  // conversation's.
  it("invalidates the conversation's context-artifact queries when its status transitions out of running", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    const running = {
      type: "conversation-status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      status: "running",
    };
    es.emit("conversation-status", running);
    invalidateQueries.mockClear();

    // running → running: no turn ended, no artifact refetch.
    es.emit("conversation-status", running);
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: contextArtifactKeys.conversation({
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-1",
      }),
    });

    es.emit("conversation-status", { ...running, status: "awaiting" });
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: contextArtifactKeys.conversation({
          scope: "session",
          projectName: "proj",
          sessionName: "sess",
          conversationId: "conv-1",
        }),
      }),
    );
    // An unrelated conversation's artifact queries stay untouched.
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: contextArtifactKeys.conversation({
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-other",
      }),
    });
  });

  // Regression: the asymmetric collab slice writes the final answer onto
  // the conversation transcript via `appendTranscriptEntry`. If the
  // scope=collaboration listener does not invalidate the conversation
  // messages cache, the transcript stays stale until the user manually
  // refreshes (the messages query only re-fetches while `isBusy`, which
  // can flip false before the final transcript flush).
  it("invalidates the targeted conversation's messages (scoped to workflowId via active-conversations cache) on scoped-status events with scope=collaboration so the transcript refetches without a cache-wide refetch storm", async () => {
    const client = makeClient();
    client.setQueryData(conversationKeys.active(), {
      conversations: [],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [
        {
          workflowId: "wf-collab-1",
          status: "running" as const,
          phase: "asymmetric",
          projectName: "proj",
          projectPath: "/p/proj",
          sessionName: "sess",
          conversationId: "conv-abc",
          createdAt: "2026-04-28T00:00:00.000Z",
          updatedAt: "2026-04-28T00:00:00.000Z",
        },
      ],
    });
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("scoped-status", {
      type: "scoped-status",
      scope: "collaboration",
      scopeId: "wf-collab-1",
      status: "completed",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "proj",
      sessionName: "sess",
      payload: { kind: "asymmetric_completed_final" },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: conversationKeys.messages("proj", "sess", "conv-abc"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: collaborationKeys.all,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.list("proj", "sess"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: conversationKeys.all,
    });
  });

  it("invalidates only session queries on scoped-status events with scope=workflow", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("scoped-status", {
      type: "scoped-status",
      scope: "workflow",
      scopeId: "wf-generic-7",
      status: "completed",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "proj",
      sessionName: "sess",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: sessionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.all,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: collaborationKeys.all,
    });
  });

  it("ignores scoped-status events whose scope the client does not recognize (forward-compat)", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    invalidateQueries.mockClear();

    es.emit("scoped-status", {
      type: "scoped-status",
      scope: "future-scope-not-yet-handled",
      scopeId: "x-1",
      status: "running",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "proj",
      sessionName: "sess",
    });

    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: collaborationKeys.all,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });

  it("appends to the cached messages query on message-appended without invalidating", async () => {
    const client = makeClient();
    const key = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(key, [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: null,
        seq: 0,
      },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-appended", {
      type: "message-appended",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      seq: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        timestamp: null,
      },
    });

    await waitFor(() => {
      const cached = client.getQueryData<Array<{ seq: number }>>(key);
      expect(cached?.length).toBe(2);
    });
    const cached = client.getQueryData<Array<{ seq: number }>>(key);
    expect(cached?.[1]?.seq).toBe(1);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: key });
  });

  it("invalidates the session Markdown list when an appended message contains a Markdown ref", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    renderWithClient(client);
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-appended", {
      type: "message-appended",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      seq: 2,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "docs/plan.md" },
          },
        ],
        timestamp: null,
      },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: markdownDocumentKeys.list("proj", "sess"),
      }),
    );
  });

  it("merges consecutive same-role message-appended events into the previous cache entry", async () => {
    const client = makeClient();
    const key = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(key, [
      {
        role: "user",
        content: [{ type: "text", text: "do four tool calls" }],
        timestamp: null,
        seq: 0,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
        timestamp: null,
        seq: 1,
      },
    ]);

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-appended", {
      type: "message-appended",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      seq: 2,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "Read",
            input: { path: "/x" },
          },
        ],
        timestamp: null,
      },
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<
          Array<{ seq: number; role: string; content: Array<{ id?: string }> }>
        >(key);
      // Same-role assistant entries must merge into one message so the
      // MessageContent grouping logic can collapse consecutive tool uses.
      expect(cached?.length).toBe(2);
      expect(cached?.[1]?.content.length).toBe(2);
      expect(cached?.[1]?.content[0]?.id).toBe("tu_1");
      expect(cached?.[1]?.content[1]?.id).toBe("tu_2");
      // Merged message takes the latest seq, matching server-side disk read.
      expect(cached?.[1]?.seq).toBe(2);
    });
  });

  it("uses the latest explicit settings when merging user appends and preserves them across metadata-less appends", async () => {
    const client = makeClient();
    const key = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(key, [
      {
        role: "user",
        content: [{ type: "text", text: "failed attempt" }],
        timestamp: null,
        model: "opus",
        effort: "high",
        codexFastMode: true,
        seq: 0,
      },
    ]);

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-appended", {
      type: "message-appended",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      seq: 1,
      message: {
        role: "user",
        content: [{ type: "text", text: "successful retry" }],
        timestamp: null,
        model: "gpt-5.6-luna",
        codexFastMode: false,
      },
    });

    await waitFor(() => {
      const cached = client.getQueryData<
        Array<{
          seq: number;
          content: unknown[];
          model?: string;
          effort?: string;
          codexFastMode?: boolean;
        }>
      >(key);
      expect(cached).toHaveLength(1);
      expect(cached?.[0]).toMatchObject({
        seq: 1,
        model: "gpt-5.6-luna",
        codexFastMode: false,
      });
      expect(cached?.[0]?.effort).toBeUndefined();
      expect(cached?.[0]?.content).toHaveLength(2);
    });

    es.emit("message-appended", {
      type: "message-appended",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      seq: 2,
      message: {
        role: "user",
        content: [{ type: "text", text: "queued follow-up" }],
        timestamp: null,
      },
    });

    await waitFor(() => {
      const cached = client.getQueryData<
        Array<{
          seq: number;
          content: unknown[];
          model?: string;
          effort?: string;
          codexFastMode?: boolean;
        }>
      >(key);
      expect(cached).toHaveLength(1);
      expect(cached?.[0]).toMatchObject({
        seq: 2,
        model: "gpt-5.6-luna",
        codexFastMode: false,
      });
      expect(cached?.[0]?.effort).toBeUndefined();
      expect(cached?.[0]?.content).toHaveLength(3);
    });
  });

  it("replaces the matching entry by seq on message-updated without invalidating", async () => {
    const client = makeClient();
    const key = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(key, [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: null,
        seq: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        timestamp: null,
        seq: 1,
      },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-updated", {
      type: "message-updated",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      seq: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "complete" }],
        timestamp: null,
      },
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<
          Array<{ seq: number; content: Array<{ text: string }> }>
        >(key);
      expect(cached?.[1]?.content[0]?.text).toBe("complete");
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: key });
  });

  it("appends new conversations to the list cache on conversation-created and invalidates active", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("proj", "sess");
    client.setQueryData(listKey, [
      { id: "conv-1", name: null, archived: false },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-created", {
      type: "conversation-created",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversation: {
        id: "conv-2",
        name: null,
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-04-28T00:00:00.000Z",
        lastActivityAt: "2026-04-28T00:00:00.000Z",
        source: "cc",
        summary: null,
        archived: false,
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        pendingQuestionId: null,
        pendingQuestions: null,
        pendingPromptText: null,
        forkedFrom: null,
        role: null,
        contextTokens: null,
        contextWindowMax: null,
        debugMode: null,
        agentBackend: "claude",
        backendRef: null,
      },
    });

    await waitFor(() => {
      const cached = client.getQueryData<Array<{ id: string }>>(listKey);
      expect(cached?.map((c) => c.id)).toEqual(["conv-1", "conv-2"]);
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("toggles the archived flag on the matching entry on conversation-archived", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("proj", "sess");
    client.setQueryData(listKey, [
      { id: "conv-1", name: null, archived: false },
      { id: "conv-2", name: null, archived: false },
    ]);

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-archived", {
      type: "conversation-archived",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-2",
      archived: true,
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<Array<{ id: string; archived: boolean }>>(listKey);
      expect(cached?.find((c) => c.id === "conv-2")?.archived).toBe(true);
      expect(cached?.find((c) => c.id === "conv-1")?.archived).toBe(false);
    });
  });

  it("invalidates project conversation caches on project-scoped conversation-status", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      status: "awaiting",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: projectConversationKeys.messages("proj", "pc-1"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectConversationKeys.list("proj"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });

  it("enqueues a project-scoped input toast on project conversation waiting_for_input", async () => {
    const client = makeClient();

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "project-convo-1",
      status: "waiting_for_input",
    });

    await waitFor(() =>
      expect(notificationStoreMocks.enqueueInputToast).toHaveBeenCalledWith({
        scope: "project",
        projectName: "proj",
        conversationId: "project-convo-1",
        displayContext: "main",
        href: "/projects/proj?focus=project-convo-1",
      }),
    );
  });

  it("enqueues a project-scoped prompt error toast on project conversation errors", async () => {
    const client = makeClient();

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "project-convo-1",
      status: "awaiting",
      error: "Tool failed",
    });

    await waitFor(() =>
      expect(
        notificationStoreMocks.enqueuePromptErrorToast,
      ).toHaveBeenCalledWith({
        scope: "project",
        projectName: "proj",
        conversationId: "project-convo-1",
        displayContext: "main",
        href: "/projects/proj?focus=project-convo-1",
        error: "Tool failed",
      }),
    );
  });

  it("shows a browser notification for hidden project readiness events when permission is granted", async () => {
    const client = makeClient();
    stubHiddenDocument(true);
    stubBrowserNotifications("granted");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      status: "awaiting",
    });

    await waitFor(() =>
      expect(FakeBrowserNotification.instances).toHaveLength(1),
    );
    expect(FakeBrowserNotification.instances[0]).toMatchObject({
      title: "Project conversation ready",
      options: {
        body: "proj / pc-1",
        tag: "project-conversation-ready-pc-1",
      },
    });
    expect(FakeBrowserNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("requests browser notification permission for hidden project readiness events when permission is default", async () => {
    const client = makeClient();
    stubHiddenDocument(true);
    stubBrowserNotifications("default");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      status: "awaiting",
    });

    await waitFor(() =>
      expect(FakeBrowserNotification.requestPermission).toHaveBeenCalledTimes(
        1,
      ),
    );
    expect(FakeBrowserNotification.instances).toHaveLength(0);
  });

  it("does not request permission or show a browser notification for denied project readiness events", async () => {
    const client = makeClient();
    stubHiddenDocument(true);
    stubBrowserNotifications("denied");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-status", {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      status: "awaiting",
    });

    expect(FakeBrowserNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeBrowserNotification.instances).toHaveLength(0);
  });

  it("updates project-scoped message caches on message-appended and message-updated", async () => {
    const client = makeClient();
    const key = projectConversationKeys.messages("proj", "pc-1");
    client.setQueryData(key, [
      {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        timestamp: null,
        seq: 0,
      },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-appended", {
      type: "message-appended",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      seq: 1,
      message: {
        role: "user",
        content: [{ type: "text", text: "go" }],
        timestamp: null,
      },
    });
    es.emit("message-updated", {
      type: "message-updated",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      seq: 1,
      message: {
        role: "user",
        content: [{ type: "text", text: "go now" }],
        timestamp: null,
      },
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<
          Array<{ seq: number; content: Array<{ text: string }> }>
        >(key);
      expect(cached?.[1]?.content[0]?.text).toBe("go now");
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: key });
  });

  it("refreshes project list, open count, and active data on project conversation-created", async () => {
    const client = makeClient();
    const listKey = projectConversationKeys.list("proj");
    client.setQueryData(listKey, [makeProjectConversation({ id: "pc-1" })]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-created", {
      type: "conversation-created",
      scope: "project",
      projectName: "proj",
      conversation: makeProjectConversation({
        id: "pc-2",
        creationRequestId: "req-9",
      }),
    });

    await waitFor(() => {
      const cached = client.getQueryData<Array<{ id: string }>>(listKey);
      expect(cached?.map((c) => c.id)).toEqual(["pc-1", "pc-2"]);
    });
    // The creating submission rides the event into the list cache, so a
    // create-and-send turn can recognise its own conversation the moment the
    // creation is broadcast — no refetch in between.
    expect(
      client.getQueryData<Array<{ id: string; creationRequestId?: string }>>(
        listKey,
      )?.[1]?.creationRequestId,
    ).toBe("req-9");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: listKey });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("refreshes project caches on project conversation-renamed and conversation-archived", async () => {
    const client = makeClient();
    const listKey = projectConversationKeys.list("proj");
    client.setQueryData(listKey, [
      { id: "pc-1", name: null, archived: false },
      { id: "pc-2", name: "keep", archived: false },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-renamed", {
      type: "conversation-renamed",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      name: "renamed",
    });
    es.emit("conversation-archived", {
      type: "conversation-archived",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-2",
      archived: true,
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<
          Array<{ id: string; name: string | null; archived: boolean }>
        >(listKey);
      expect(cached?.find((c) => c.id === "pc-1")?.name).toBe("renamed");
      expect(cached?.find((c) => c.id === "pc-2")?.archived).toBe(true);
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: listKey });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("refreshes project caches on project conversation-open and conversation-unread", async () => {
    const client = makeClient();
    const listKey = projectConversationKeys.list("proj");
    client.setQueryData(listKey, [
      { id: "pc-1", open: true, unread: false, archived: false },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-open", {
      type: "conversation-open",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      open: false,
    });
    es.emit("conversation-unread", {
      type: "conversation-unread",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      unread: true,
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<
          Array<{ id: string; open: boolean; unread: boolean }>
        >(listKey);
      expect(cached?.[0]?.open).toBe(false);
      expect(cached?.[0]?.unread).toBe(true);
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: listKey });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("refreshes the pending-queue and active caches on message-queued without fabricating a transcript row", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(messagesKey, [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: null,
        seq: 0,
      },
    ]);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-queued", {
      type: "message-queued",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      text: "follow up",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: sessionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    // Queue pending events must NOT fabricate a transcript cache row: the
    // messages cache is neither invalidated nor mutated.
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: messagesKey,
    });
    const cached = client.getQueryData<Array<{ seq: number }>>(messagesKey);
    expect(cached?.length).toBe(1);
  });

  it("drops the optimistic queue entry when a PROJECT queue row is delivered", async () => {
    const client = makeClient();
    useSessionDetailStore.setState({ inFlight: {} });
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("conv-1", "temp-1", [
      { type: "text", text: "follow up" },
    ]);
    store.acceptOptimisticQueueEntry("conv-1", "temp-1", "q-1");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-queue-updated", {
      type: "message-queue-updated",
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      message: queuedMessageView("q-1", "delivered"),
    });

    // Delivered: the message is now a transcript row, so leaving the optimistic
    // stand-in behind would render it a second time as still-pending.
    await waitFor(() => expect(optimisticQueueFor("conv-1")).toHaveLength(0));
  });

  it("keeps the optimistic queue entry while the row is still being delivered", async () => {
    const client = makeClient();
    useSessionDetailStore.setState({ inFlight: {} });
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("conv-1", "temp-1", [
      { type: "text", text: "follow up" },
    ]);
    store.acceptOptimisticQueueEntry("conv-1", "temp-1", "q-1");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("message-queue-updated", {
      type: "message-queue-updated",
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      message: queuedMessageView("q-1", "delivering"),
    });

    // `delivering` is not terminal: the message is still owed to the user's
    // view, so it stays pending rather than vanishing mid-flight.
    expect(optimisticQueueFor("conv-1")).toHaveLength(1);
  });

  it("refreshes the PROJECT conversation caches on a scope:project queue event", async () => {
    const client = makeClient();
    const messagesKey = projectConversationKeys.messages("proj", "conv-1");
    client.setQueryData(messagesKey, []);
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    // No `sessionName`: a project conversation's queue row is addressed by
    // project + conversation, so the event has no field for the internal
    // sentinel and the client routes on the scope instead (R6.1 / R1.3).
    es.emit("message-queued", {
      type: "message-queued",
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      text: "follow up",
    });

    // The project conversation list is where `pendingQueue` lives for the
    // cockpit, so this is what makes another client's queued row appear.
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: projectConversationKeys.list("proj"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    // A queued message is not a transcript row at project scope either.
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: messagesKey,
    });
  });

  it("invalidates the execution detail and event log (not session detail) on graph-workflow-status", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("graph-workflow-status", {
      type: "graph-workflow-status",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      workflowStatus: "running",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: graphWorkflowExecutionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: graphWorkflowEventsKeys.list("proj", "sess", "exec-1"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });

  it("enqueues an input toast and invalidates active + session detail on graph-workflow-approval-pending", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("graph-workflow-approval-pending", {
      type: "graph-workflow-approval-pending",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "ctx-1",
      contextTitle: "Build the API",
      conversationId: "conv-1",
      requestedAt: "2026-06-10T00:00:00.000Z",
    });

    await waitFor(() =>
      expect(notificationStoreMocks.enqueueInputToast).toHaveBeenCalledWith({
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-1",
        title: "Approval required",
        variant: "approval",
        contextTitle: "Build the API",
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });

  it("shows a browser notification with approval wording for hidden approval-pending events when permission is granted", async () => {
    const client = makeClient();
    stubHiddenDocument(true);
    stubBrowserNotifications("granted");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("graph-workflow-approval-pending", {
      type: "graph-workflow-approval-pending",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "ctx-1",
      contextTitle: "Build the API",
      conversationId: "conv-1",
      requestedAt: "2026-06-10T00:00:00.000Z",
    });

    await waitFor(() =>
      expect(FakeBrowserNotification.instances).toHaveLength(1),
    );
    expect(FakeBrowserNotification.instances[0]).toMatchObject({
      title: "Approval required",
      options: {
        body: "Build the API passed validators — review to continue",
        tag: "approval-conv-1",
      },
    });
    expect(FakeBrowserNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("invalidates active + session detail on graph-workflow-approval-resolved without toast or browser notification", async () => {
    const client = makeClient();
    stubHiddenDocument(true);
    stubBrowserNotifications("granted");
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("graph-workflow-approval-resolved", {
      type: "graph-workflow-approval-resolved",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "ctx-1",
      conversationId: "conv-1",
      decision: "approved",
      message: null,
      decidedAt: "2026-06-10T00:01:00.000Z",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: conversationKeys.active(),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
    expect(notificationStoreMocks.enqueueInputToast).not.toHaveBeenCalled();
    expect(FakeBrowserNotification.instances).toHaveLength(0);
    expect(FakeBrowserNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("enqueues a workflow-question toast and invalidates execution, event log, and conversation views on graph-workflow-user-input-pending", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("graph-workflow-user-input-pending", {
      type: "graph-workflow-user-input-pending",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "ctx-1",
      contextTitle: "Build the API",
      conversationId: "conv-1",
      questionBatchId: "qb-1",
      requestedAt: "2026-07-03T00:00:00.000Z",
    });

    await waitFor(() =>
      expect(notificationStoreMocks.enqueueInputToast).toHaveBeenCalledWith({
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-1",
        title: "Workflow question",
        contextTitle: "Build the API",
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: graphWorkflowExecutionKeys.detail("proj", "sess"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: graphWorkflowEventsKeys.list("proj", "sess", "exec-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });

  it("invalidates execution, event log, and conversation views on graph-workflow-user-input-resolved without a toast", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("graph-workflow-user-input-resolved", {
      type: "graph-workflow-user-input-resolved",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "ctx-1",
      conversationId: "conv-1",
      questionBatchId: "qb-1",
      resolution: "answered",
      resolvedAt: "2026-07-03T00:01:00.000Z",
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: graphWorkflowExecutionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: graphWorkflowEventsKeys.list("proj", "sess", "exec-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
    expect(notificationStoreMocks.enqueueInputToast).not.toHaveBeenCalled();
  });

  function emitAndGetSpies() {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    renderWithClient(client);
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");
    return { client, invalidateQueries, es };
  }

  it("invalidates the execution detail (not the event log) on graph-workflow-pending-halt-reason", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("graph-workflow-pending-halt-reason", {
      type: "graph-workflow-pending-halt-reason",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      pendingHaltReason: null,
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: graphWorkflowExecutionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: graphWorkflowEventsKeys.list("proj", "sess", "exec-1"),
    });
  });

  it("invalidates the project's sessions list on spawn-result", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("spawn-result", {
      type: "spawn-result",
      scope: "project",
      projectName: "proj",
      conversationId: "conv-1",
      result: {
        created: [
          {
            name: "api",
            sessionName: "api",
            branchName: "csm/api",
            initialPromptQueued: true,
          },
        ],
        failed: [{ name: "web", error: "branch exists" }],
      },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: sessionKeys.list("proj"),
      }),
    );
  });

  it("reconciles the linked ticket caches when a merge finishes the session", async () => {
    const { client, invalidateQueries, es } = emitAndGetSpies();
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const ticketDetailKey = ticketKeys.detail("proj", 7);
    const ticketLinksKey = ticketKeys.sessionLinks("proj");
    client.setQueryData(ticketListKey, []);
    client.setQueryData(ticketDetailKey, { id: "ticket-7" });
    client.setQueryData(ticketLinksKey, {
      sess: {
        ticketId: "ticket-7",
        projectName: "proj",
        number: 7,
        title: "Linked ticket",
        active: true,
        linkedAt: "2026-07-01T00:00:00.000Z",
        endedAt: null,
      },
    });
    invalidateQueries.mockClear();

    es.emit("job-status", {
      type: "job-status",
      jobType: "merge",
      status: "completed",
      projectName: "proj",
      sessionName: "sess",
      jobId: "job-1",
      branchName: "csm/sess",
      mergeHash: "abc123",
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ticketLinksKey,
      });
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ticketKeys.lists(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ticketDetailKey,
    });
  });

  function makeJobNotification(
    overrides: Partial<JobNotification> = {},
  ): JobNotification {
    return {
      id: "notif-1",
      title: "Merge completed",
      message: "sess merged into main",
      read: false,
      projectName: "proj",
      createdAt: "2026-06-10T00:00:00.000Z",
      source: "job",
      type: "merge-completed",
      sessionName: "sess",
      branchName: "csm/sess",
      jobId: "job-1",
      jobType: "merge",
      ...overrides,
    };
  }

  it("prepends a new notification into the fetched list cache without refetching", async () => {
    const { client, invalidateQueries, es } = emitAndGetSpies();
    const existing = makeJobNotification({ id: "notif-0", read: true });
    client.setQueryData(notificationKeys.list(), {
      notifications: [existing],
      total: 1,
      unreadCount: 0,
    } satisfies NotificationsResponse);
    invalidateQueries.mockClear();

    es.emit("notification-created", {
      type: "notification-created",
      notification: makeJobNotification({ id: "notif-1", read: false }),
    });

    await waitFor(() => {
      const cached = client.getQueryData<NotificationsResponse>(
        notificationKeys.list(),
      );
      expect(cached?.notifications.map((n) => n.id)).toEqual([
        "notif-1",
        "notif-0",
      ]);
      expect(cached?.total).toBe(2);
      expect(cached?.unreadCount).toBe(1);
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(notificationStoreMocks.enqueueToast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "notif-1" }),
    );
  });

  it("is idempotent when the created notification is already in the list cache", async () => {
    const { client, es } = emitAndGetSpies();
    const existing = makeJobNotification({ id: "notif-1", read: false });
    client.setQueryData(notificationKeys.list(), {
      notifications: [existing],
      total: 1,
      unreadCount: 1,
    } satisfies NotificationsResponse);

    es.emit("notification-created", {
      type: "notification-created",
      notification: makeJobNotification({ id: "notif-1", read: false }),
    });

    await waitFor(() =>
      expect(notificationStoreMocks.enqueueToast).toHaveBeenCalled(),
    );
    const cached = client.getQueryData<NotificationsResponse>(
      notificationKeys.list(),
    );
    expect(cached?.notifications).toHaveLength(1);
    expect(cached?.total).toBe(1);
    expect(cached?.unreadCount).toBe(1);
  });

  function makeContextArtifactListItem(
    overrides: Partial<ContextArtifactListItem> & { id: string },
  ): ContextArtifactListItem {
    return {
      kind: "conversation_compaction",
      scope: "session",
      projectPath: "/p/proj",
      sessionName: "sess",
      conversationId: "conv-1",
      messageId: null,
      messageIndex: null,
      coveredStartSeq: 0,
      coveredEndSeq: 42,
      sourceHash: "hash",
      status: "pending",
      error: null,
      modelProvider: "claude",
      model: "claude-sonnet-4-5",
      effort: null,
      schemaVersion: 1,
      promptVersion: "v1",
      normalizerVersion: "v1",
      createdBy: "user",
      createdByConversationId: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      stale: false,
      staleBehindMessages: 0,
      outdated: false,
      ...overrides,
    };
  }

  // The SSE event name is underscore-separated ("context_artifact_status",
  // design §9.1) unlike every other hyphenated event — this test pins the
  // exact registration string, since a hyphenated listener would silently
  // never fire.
  it("adopts the server artifact id onto a cached optimistic row on context_artifact_status pending", async () => {
    const { client, es } = emitAndGetSpies();
    const artifactTarget = {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
    } as const;
    const listKey = contextArtifactKeys.list(artifactTarget);
    client.setQueryData(listKey, [
      makeContextArtifactListItem({ id: "optimistic-1", status: "pending" }),
    ]);

    es.emit("context_artifact_status", {
      type: "context_artifact_status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      artifactId: "a-1",
      kind: "conversation_compaction",
      status: "pending",
    });

    await waitFor(() => {
      const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
      expect(cached?.map((row) => row.id)).toEqual(["a-1"]);
    });
  });

  it("falls back to invalidation when the notifications list cache is unfetched", async () => {
    const { client, invalidateQueries, es } = emitAndGetSpies();

    es.emit("notification-created", {
      type: "notification-created",
      notification: makeJobNotification(),
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: notificationKeys.list(),
      }),
    );
    expect(
      client.getQueryData<NotificationsResponse>(notificationKeys.list()),
    ).toBeUndefined();
    expect(notificationStoreMocks.enqueueToast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "notif-1" }),
    );
  });

  it("invalidates active conversations and session detail on debug-mode-status", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("debug-mode-status", {
      type: "debug-mode-status",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      active: true,
      recording: true,
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: sessionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("invalidates the notifications subtree on notification-updated", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("notification-updated", {
      type: "notification-updated",
      id: "notif-1",
      read: true,
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: notificationKeys.all,
      }),
    );
  });

  it("routes job-status events into the notification store and refetches session detail on completed merges", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();

    es.emit("job-status", {
      type: "job-status",
      jobType: "merge",
      status: "completed",
      projectName: "proj",
      sessionName: "sess",
      jobId: "job-1",
      branchName: "csm/sess",
    });

    await waitFor(() =>
      expect(notificationStoreMocks.addOrUpdateJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", status: "completed" }),
      ),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });

  it("does not refetch session detail for non-terminal job-status events", async () => {
    const { invalidateQueries, es } = emitAndGetSpies();
    invalidateQueries.mockClear();

    es.emit("job-status", {
      type: "job-status",
      jobType: "merge",
      status: "running",
      projectName: "proj",
      sessionName: "sess",
      jobId: "job-1",
      branchName: "csm/sess",
    });

    await waitFor(() =>
      expect(notificationStoreMocks.addOrUpdateJob).toHaveBeenCalled(),
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
  });
});
