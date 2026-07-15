import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { reconnectReconcile } from "./sse-reconnect";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import { collaborationKeys } from "../workflows/query-keys";
import { devServerKeys } from "../dev-server/query-keys";
import { notificationKeys } from "../notifications/query-keys";
import { sessionKeys } from "../sessions/query-keys";
import { projectConversationKeys } from "../project-conversations-client/query-keys";
import { normalizeTicketListFilters } from "../tickets/list-filters";
import { beginTicketMutation } from "../tickets/mutation-coordinator";
import { ticketKeys } from "../tickets/query-keys";

type StampedMessage = {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
  timestamp: string | null;
  seq: number;
};

function makeMsg(seq: number, text: string): StampedMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: null,
    seq,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("reconnectReconcile", () => {
  it("appends new entries returned by the since endpoint to each cached messages query", async () => {
    const client = makeClient();
    const keyA = conversationKeys.messages("proj", "sess", "conv-a");
    const keyB = conversationKeys.messages("proj", "sess", "conv-b");
    client.setQueryData(keyA, [makeMsg(0, "a0"), makeMsg(1, "a1")]);
    client.setQueryData(keyB, [makeMsg(0, "b0")]);

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("conv-a") && url.includes("messages?since=1")) {
        return jsonResponse([makeMsg(2, "a2")]);
      }
      if (url.includes("conv-b") && url.includes("messages?since=0")) {
        return jsonResponse([makeMsg(1, "b1"), makeMsg(2, "b2")]);
      }
      if (url === "/api/jobs") {
        return jsonResponse({ jobs: [] });
      }
      return jsonResponse({ error: "unexpected" }, false);
    });

    const reconcileJobs = vi.fn();

    await reconnectReconcile(client, reconcileJobs, fetchFn);

    expect(client.getQueryData(keyA)).toEqual([
      makeMsg(0, "a0"),
      makeMsg(1, "a1"),
      makeMsg(2, "a2"),
    ]);
    expect(client.getQueryData(keyB)).toEqual([
      makeMsg(0, "b0"),
      makeMsg(1, "b1"),
      makeMsg(2, "b2"),
    ]);
    expect(reconcileJobs).toHaveBeenCalledWith([]);
  });

  it("uses since=0 when a cached messages array is empty", async () => {
    const client = makeClient();
    const key = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(key, []);

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("messages?since=0")) {
        return jsonResponse([makeMsg(0, "first")]);
      }
      if (url === "/api/jobs") return jsonResponse({ jobs: [] });
      return jsonResponse({ error: "unexpected" }, false);
    });

    await reconnectReconcile(client, vi.fn(), fetchFn);

    expect(client.getQueryData(key)).toEqual([makeMsg(0, "first")]);
  });

  it("marks per-session details and per-feature caches stale after reconciling", async () => {
    const client = makeClient();
    const detailA = sessionKeys.detail("proj", "sess-a");
    const detailB = sessionKeys.detail("proj", "sess-b");
    client.setQueryData(detailA, { sessionName: "sess-a" });
    client.setQueryData(detailB, { sessionName: "sess-b" });
    client.setQueryData(conversationKeys.active(), {
      conversations: [],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
    });
    client.setQueryData(collaborationKeys.list("proj", "sess-a"), []);
    client.setQueryData(notificationKeys.list(), []);
    client.setQueryData(devServerKeys.list("proj", "sess-a"), []);
    client.setQueryData(mcpConfigKeys.project("proj"), {});
    client.setQueryData(
      mcpToolsKeys.inventory("proj", "sess-a", "conv-a", "calc"),
      {},
    );
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const ticketDetailKey = ticketKeys.detail("proj", 7);
    const ticketSessionLinksKey = ticketKeys.sessionLinks("proj");
    client.setQueryData(ticketListKey, []);
    client.setQueryData(ticketDetailKey, { id: "ticket-7" });
    client.setQueryData(ticketSessionLinksKey, {});

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/jobs") return jsonResponse({ jobs: [] });
      return jsonResponse([]);
    });

    await reconnectReconcile(client, vi.fn(), fetchFn);

    expect(client.getQueryState(detailA)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(conversationKeys.active())?.isInvalidated).toBe(
      true,
    );
    expect(
      client.getQueryState(collaborationKeys.list("proj", "sess-a"))
        ?.isInvalidated,
    ).toBe(true);
    expect(client.getQueryState(notificationKeys.list())?.isInvalidated).toBe(
      true,
    );
    expect(
      client.getQueryState(devServerKeys.list("proj", "sess-a"))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(mcpConfigKeys.project("proj"))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(
        mcpToolsKeys.inventory("proj", "sess-a", "conv-a", "calc"),
      )?.isInvalidated,
    ).toBe(true);
    expect(client.getQueryState(ticketListKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(ticketDetailKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(ticketSessionLinksKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("defers ticket refetches until a pending optimistic mutation settles", async () => {
    const client = makeClient();
    const listKey = ticketKeys.list(normalizeTicketListFilters({}));
    const detailKey = ticketKeys.detail("proj", 7);
    client.setQueryData(listKey, []);
    client.setQueryData(detailKey, { id: "ticket-7" });
    const release = await beginTicketMutation(client, "proj", 7);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/jobs") return jsonResponse({ jobs: [] });
      return jsonResponse([]);
    });

    await reconnectReconcile(client, vi.fn(), fetchFn);

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);

    release();

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it("marks mounted project-conversation list and message caches stale after reconciling", async () => {
    const client = makeClient();
    const listKey = projectConversationKeys.list("proj");
    const messagesKey = projectConversationKeys.messages("proj", "pc-1");
    client.setQueryData(listKey, []);
    client.setQueryData(messagesKey, [makeMsg(0, "cached")]);

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/jobs") return jsonResponse({ jobs: [] });
      return jsonResponse([]);
    });

    await reconnectReconcile(client, vi.fn(), fetchFn);

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
  });

  it("calls reconcileJobs with the jobs array returned by /api/jobs", async () => {
    const client = makeClient();
    const jobs = [{ jobId: "job-1", status: "running" }];

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/jobs") return jsonResponse({ jobs });
      return jsonResponse([]);
    });
    const reconcileJobs = vi.fn();

    await reconnectReconcile(client, reconcileJobs, fetchFn);

    expect(reconcileJobs).toHaveBeenCalledWith(jobs);
  });

  it("tolerates a failing fetch without throwing", async () => {
    const client = makeClient();
    const key = conversationKeys.messages("proj", "sess", "conv-1");
    client.setQueryData(key, [makeMsg(0, "a")]);

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network down"));

    await expect(
      reconnectReconcile(client, vi.fn(), fetchFn),
    ).resolves.toBeUndefined();

    expect(client.getQueryData(key)).toEqual([makeMsg(0, "a")]);
  });
});
