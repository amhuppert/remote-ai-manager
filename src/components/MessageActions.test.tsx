// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import MessageActions from "./MessageActions";
import {
  buildArtifactDetail,
  buildArtifactListItem,
} from "./context-artifacts/fixtures";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import { findMessageRefs } from "@/lib/conversations/ref-parser";
import { messageRefAttrsSchema } from "@/lib/conversations/schemas";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const LIST_URL =
  "/api/projects/p1/sessions/s1/conversations/c1/context-artifacts";
const DETAIL_URL = `${LIST_URL}/art-1`;

const toolContent: MessageContentBlock[] = [
  { type: "text", text: "ran the suite" },
  { type: "tool_use", name: "Bash" },
];
const shortTextContent: MessageContentBlock[] = [
  { type: "text", text: "short answer" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

/**
 * Routes list/create/detail calls like the real artifact endpoints. The list
 * is stateful — a POST makes subsequent GETs serve the pending row — and the
 * POST reply is delayed so the immediate optimistic state is observable while
 * the request is still in flight.
 */
function routeFetch(listRows: ContextArtifactListItem[]) {
  let rows = listRows;
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === LIST_URL && method === "GET") return jsonResponse(rows);
    if (url === LIST_URL && method === "POST") {
      rows = [buildArtifactListItem({ status: "pending" })];
      await new Promise((resolve) => setTimeout(resolve, 40));
      return jsonResponse({ artifactId: "art-1", status: "pending" }, 202);
    }
    if (url === DETAIL_URL && method === "GET") {
      return jsonResponse(buildArtifactDetail());
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
}

function postCalls(): unknown[][] {
  return fetchSpy.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

const messageRefMeta = {
  conversationName: "Refactor parser",
  timestamp: "2026-07-06T12:00:00Z",
  model: "opus",
};

function renderActions(
  props: Partial<React.ComponentProps<typeof MessageActions>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MessageActions
        messageIndex={3}
        content={toolContent}
        role="assistant"
        compactionTarget={target}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("MessageActions compaction action", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders no compaction action without a compactionTarget", () => {
    routeFetch([]);
    renderActions({ compactionTarget: undefined });
    expect(
      screen.queryByRole("button", { name: "Compact message" }),
    ).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders no compaction action for messages that fail the gate", () => {
    routeFetch([]);
    renderActions({ role: "user" });
    expect(
      screen.queryByRole("button", { name: "Compact message" }),
    ).not.toBeInTheDocument();

    renderActions({ content: shortTextContent });
    expect(
      screen.queryByRole("button", { name: "Compact message" }),
    ).not.toBeInTheDocument();
  });

  it("offers Compact message when no artifact exists and flips to a visible pending state immediately on click", async () => {
    routeFetch([]);
    renderActions();
    const button = await screen.findByRole("button", {
      name: "Compact message",
    });
    fireEvent.click(button);

    // Optimistic pending row → spinner + disabled before any server reply.
    const pending = await screen.findByRole("button", { name: "Compacting…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const body = JSON.parse(
      String((postCalls()[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "message_compaction",
      messageIndex: 3,
      mode: "create_or_refresh",
    });
  });

  it("shows a disabled spinner action while the artifact is pending", async () => {
    routeFetch([buildArtifactListItem({ status: "pending" })]);
    renderActions();
    const button = await screen.findByRole("button", { name: "Compacting…" });
    expect(button).toBeDisabled();
  });

  it("toggles the inline viewer for a complete artifact", async () => {
    routeFetch([buildArtifactListItem()]);
    renderActions();
    const button = await screen.findByRole("button", {
      name: "View compacted message",
    });
    fireEvent.click(button);
    expect(
      await screen.findByText(/Single tool-heavy assistant turn/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Hide compacted message" }),
    );
    expect(
      screen.queryByText(/Single tool-heavy assistant turn/),
    ).not.toBeInTheDocument();
  });

  it("offers retry for a failed artifact and re-posts on click", async () => {
    routeFetch([buildArtifactListItem({ status: "failed", error: "boom" })]);
    renderActions();
    const button = await screen.findByRole("button", {
      name: "Compaction failed — retry",
    });
    fireEvent.click(button);
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });

  it("refreshes with force from the open viewer", async () => {
    routeFetch([buildArtifactListItem()]);
    renderActions();
    fireEvent.click(
      await screen.findByRole("button", { name: "View compacted message" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const body = JSON.parse(
      String((postCalls()[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "message_compaction",
      messageIndex: 3,
      mode: "create_or_refresh",
      force: true,
    });
  });
});

describe("MessageActions copy-reference action", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hides the action without a compactionTarget or messageRef", () => {
    routeFetch([]);
    renderActions({ compactionTarget: undefined, messageRef: messageRefMeta });
    expect(
      screen.queryByRole("button", { name: "Copy message reference" }),
    ).not.toBeInTheDocument();

    renderActions({ messageRef: undefined });
    expect(
      screen.queryByRole("button", { name: "Copy message reference" }),
    ).not.toBeInTheDocument();
  });

  it("copies a message-ref XML tag with compacted=false when no artifact exists", async () => {
    routeFetch([]);
    renderActions({ messageRef: messageRefMeta });
    fireEvent.click(
      screen.getByRole("button", { name: "Copy message reference" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const xml = writeText.mock.calls[0]![0];
    const refs = findMessageRefs(xml);
    expect(refs).toHaveLength(1);
    const attrs = messageRefAttrsSchema.parse(refs[0]!.attrs);
    expect(attrs["project-name"]).toBe("p1");
    expect(attrs["session-name"]).toBe("s1");
    expect(attrs["conversation-id"]).toBe("c1");
    expect(attrs["conversation-name"]).toBe("Refactor parser");
    expect(attrs["message-index"]).toBe("3");
    expect(attrs.role).toBe("assistant");
    expect(attrs.timestamp).toBe("2026-07-06T12:00:00Z");
    expect(attrs.model).toBe("opus");
    expect(attrs.compacted).toBe("false");
    expect(attrs["compaction-command"]).toBeUndefined();
    expect(attrs["read-command"]).toBe("cctl conversation read c1 --message 3");
  });

  it("advertises a complete message compaction with its cctl command", async () => {
    routeFetch([buildArtifactListItem()]);
    renderActions({ messageRef: messageRefMeta });
    // The artifact list has loaded once the Compact action flips to viewer mode.
    await screen.findByRole("button", { name: "View compacted message" });

    fireEvent.click(
      screen.getByRole("button", { name: "Copy message reference" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const attrs = messageRefAttrsSchema.parse(
      findMessageRefs(writeText.mock.calls[0]![0])[0]!.attrs,
    );
    expect(attrs.compacted).toBe("true");
    expect(attrs["compact-artifact-id"]).toBe("art-1");
    expect(attrs["compact-created-at"]).toBe("2026-07-05T10:30:00.000Z");
    expect(attrs["compaction-command"]).toBe(
      "cctl conversation compaction get c1 --message 3 --json",
    );
  });

  it("ignores pending or failed artifacts when advertising compaction", async () => {
    routeFetch([buildArtifactListItem({ status: "failed", error: "boom" })]);
    renderActions({ messageRef: messageRefMeta });
    await screen.findByRole("button", { name: "Compaction failed — retry" });

    fireEvent.click(
      screen.getByRole("button", { name: "Copy message reference" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const attrs = messageRefAttrsSchema.parse(
      findMessageRefs(writeText.mock.calls[0]![0])[0]!.attrs,
    );
    expect(attrs.compacted).toBe("false");
    expect(attrs["compact-artifact-id"]).toBeUndefined();
  });

  it("shows the action for user messages that offer no Compact action", async () => {
    routeFetch([]);
    renderActions({ role: "user", messageRef: messageRefMeta });
    fireEvent.click(
      screen.getByRole("button", { name: "Copy message reference" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const attrs = messageRefAttrsSchema.parse(
      findMessageRefs(writeText.mock.calls[0]![0])[0]!.attrs,
    );
    expect(attrs.role).toBe("user");
  });
});
