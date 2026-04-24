// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotificationListener from "./NotificationListener";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/query-keys";

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
});
