// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotificationListener from "./NotificationListener";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import { agentCapabilityKeys } from "@/lib/agent-capabilities/query-keys";
import {
  collaborationKeys,
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
} from "@/lib/workflows/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

const notificationStoreMocks = vi.hoisted(() => ({
  addOrUpdateJob: vi.fn(),
  reconcileJobs: vi.fn(),
  enqueueToast: vi.fn(),
  enqueueInputToast: vi.fn(),
  enqueuePromptErrorToast: vi.fn(),
}));

vi.mock("@/stores/notification.store", () => ({
  useAddOrUpdateJob: () => notificationStoreMocks.addOrUpdateJob,
  useReconcileJobs: () => notificationStoreMocks.reconcileJobs,
  useEnqueueToast: () => notificationStoreMocks.enqueueToast,
  useEnqueueInputToast: () => notificationStoreMocks.enqueueInputToast,
  useEnqueuePromptErrorToast: () =>
    notificationStoreMocks.enqueuePromptErrorToast,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;

  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((entry) => entry !== listener),
    );
  }

  close() {}

  emit(type: string, data: unknown) {
    const listeners = this.listeners.get(type) ?? [];
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

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
    machineSnapshot: null,
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

  it("invalidates affected capability queries on override update events", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("agent-capabilities-updated", {
      type: "agent-capabilities-updated",
      level: "session",
      projectName: "proj",
      sessionName: "sess",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:a"],
      effectiveHash: "hash-2",
      invalidationHints: {
        level: "session",
        projectName: "proj",
        sessionName: "sess",
        cascadeKind: "claude-skills",
        itemIds: ["skill:a"],
        effectiveHash: "hash-2",
      },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: agentCapabilityKeys.session("proj", "sess", "claude-skills"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        "agent-capabilities",
        "conversation",
        "proj",
        "claude-skills",
        "sess",
      ],
    });
  });

  it("invalidates project-conversation capability queries on override update events without the sentinel", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("agent-capabilities-updated", {
      type: "agent-capabilities-updated",
      level: "conversation",
      projectName: "proj",
      conversationScope: "project",
      conversationId: "plc-1",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:a"],
      effectiveHash: "hash-2",
      invalidationHints: {
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "plc-1",
        cascadeKind: "claude-skills",
        itemIds: ["skill:a"],
        effectiveHash: "hash-2",
      },
    });

    const expectedKey = [
      "agent-capabilities",
      "conversation",
      "proj",
      "claude-skills",
      "project",
      "plc-1",
    ];
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: expectedKey,
      }),
    );
    expect(expectedKey).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });

  it("invalidates affected capability queries on discovery refresh events", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.emit("agent-capabilities-discovery-updated", {
      type: "agent-capabilities-discovery-updated",
      level: "conversation",
      projectName: "proj",
      conversationScope: "session",
      sessionName: "sess",
      conversationId: "conv",
      cascadeKind: "claude-skills",
      backend: "claude",
      refreshedAt: "2026-05-18T12:00:00.000Z",
      sourceSignature: "sig",
      invalidationHints: {
        level: "conversation",
        projectName: "proj",
        conversationScope: "session",
        sessionName: "sess",
        conversationId: "conv",
        cascadeKind: "claude-skills",
        refreshDiscovery: true,
        sourceSignature: "sig",
      },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: agentCapabilityKeys.conversation(
          "proj",
          "sess",
          "conv",
          "claude-skills",
        ),
      }),
    );
  });

  it("refetches canonical capability state after EventSource reconnect", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) {
      throw new Error("expected EventSource instance");
    }

    es.onerror?.call(es as unknown as EventSource, new Event("error"));
    es.onopen?.call(es as unknown as EventSource, new Event("open"));

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: agentCapabilityKeys.all,
      }),
    );
  });

  it("invalidates collaboration + session queries on scoped-status events with scope=collaboration", async () => {
    const client = makeClient();
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
      status: "paused",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "proj",
      sessionName: "sess",
      payload: { kind: "paused_for_user_input" },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: collaborationKeys.all,
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.all,
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
        machineSnapshot: null,
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

  it("renames the matching entry in the cached list on conversation-renamed", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("proj", "sess");
    client.setQueryData(listKey, [
      { id: "conv-1", name: null, archived: false },
      { id: "conv-2", name: "keep", archived: false },
    ]);

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("conversation-renamed", {
      type: "conversation-renamed",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      name: "renamed",
    });

    await waitFor(() => {
      const cached =
        client.getQueryData<Array<{ id: string; name: string | null }>>(
          listKey,
        );
      expect(cached?.find((c) => c.id === "conv-1")?.name).toBe("renamed");
      expect(cached?.find((c) => c.id === "conv-2")?.name).toBe("keep");
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
      queryKey: projectConversationKeys.openCount("proj"),
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
      conversation: makeProjectConversation({ id: "pc-2" }),
    });

    await waitFor(() => {
      const cached = client.getQueryData<Array<{ id: string }>>(listKey);
      expect(cached?.map((c) => c.id)).toEqual(["pc-1", "pc-2"]);
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: listKey });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectConversationKeys.openCount("proj"),
    });
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
      queryKey: projectConversationKeys.openCount("proj"),
    });
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
      queryKey: projectConversationKeys.openCount("proj"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("refreshes project caches on project ask-question events", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("ask-question", {
      type: "ask-question",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      questionId: "q1",
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }],
        },
      ],
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
      queryKey: projectConversationKeys.openCount("proj"),
    });
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

  it("refreshes the pending-queue and active caches on message-queue-updated without touching the messages cache", async () => {
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

    es.emit("message-queue-updated", {
      type: "message-queue-updated",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      message: {
        id: "q-1",
        content: [{ type: "text", text: "follow up" }],
        status: "delivered",
        enqueuedAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:01.000Z",
        deliveredAt: "2026-04-28T00:00:01.000Z",
        cancelledAt: null,
        failedAt: null,
        error: null,
      },
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: sessionKeys.detail("proj", "sess"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: messagesKey,
    });
    const cached = client.getQueryData<Array<{ seq: number }>>(messagesKey);
    expect(cached?.length).toBe(1);
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

  it("invalidates the execution detail and event log on graph-workflow-task-status", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    es.emit("graph-workflow-task-status", {
      type: "graph-workflow-task-status",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-7",
      taskId: "task-1",
      contextId: "ctx-1",
      status: "completed",
      source: "agent",
      order: 1,
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: graphWorkflowEventsKeys.list("proj", "sess", "exec-7"),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: graphWorkflowExecutionKeys.detail("proj", "sess"),
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

  it("falls back to the context id in the browser notification body when the approval-pending context has no title", async () => {
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
      contextTitle: null,
      conversationId: "conv-1",
      requestedAt: "2026-06-10T00:00:00.000Z",
    });

    await waitFor(() =>
      expect(FakeBrowserNotification.instances).toHaveLength(1),
    );
    expect(FakeBrowserNotification.instances[0]).toMatchObject({
      options: { body: "ctx-1 passed validators — review to continue" },
    });
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

  it("ignores malformed approval events without invalidating caches", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    invalidateQueries.mockClear();

    // Missing required fields (conversationId / decision): both must be ignored.
    es.emit("graph-workflow-approval-pending", {
      type: "graph-workflow-approval-pending",
      projectName: "proj",
      sessionName: "sess",
    });
    es.emit("graph-workflow-approval-resolved", {
      type: "graph-workflow-approval-resolved",
      projectName: "proj",
      sessionName: "sess",
    });

    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(notificationStoreMocks.enqueueInputToast).not.toHaveBeenCalled();
  });

  it("ignores malformed queue events without throwing or mutating caches", async () => {
    const client = makeClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    renderWithClient(client);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected EventSource instance");

    invalidateQueries.mockClear();

    // Missing required `conversationId`/`text` (message-queued) and
    // `message`/`conversationId` (message-queue-updated): both must be ignored.
    es.emit("message-queued", {
      type: "message-queued",
      projectName: "proj",
      sessionName: "sess",
    });
    es.emit("message-queue-updated", {
      type: "message-queue-updated",
      projectName: "proj",
      sessionName: "sess",
    });

    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj", "sess"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });
});
