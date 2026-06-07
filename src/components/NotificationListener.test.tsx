// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotificationListener from "./NotificationListener";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import { agentCapabilityKeys } from "@/lib/agent-capabilities/query-keys";
import { collaborationKeys } from "@/lib/workflows/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";

vi.mock("@/stores/notification.store", () => ({
  useAddOrUpdateJob: () => vi.fn(),
  useReconcileJobs: () => vi.fn(),
  useEnqueueToast: () => vi.fn(),
  useEnqueueInputToast: () => vi.fn(),
  useEnqueuePromptErrorToast: () => vi.fn(),
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

describe("NotificationListener", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
