// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotificationListener from "./NotificationListener";
import {
  collaborationKeys,
  conversationKeys,
  mcpConfigKeys,
  mcpToolsKeys,
  sessionKeys,
} from "@/lib/query-keys";

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
    expect(invalidateQueries).toHaveBeenCalledWith({
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
    client.setQueryData(conversationKeys.active, {
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
    expect(invalidateQueries).toHaveBeenCalledWith({
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
});
