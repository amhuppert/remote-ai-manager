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
import { buildClipFragment } from "@/lib/notepads/capture-fragment";
import { extractCopyText } from "@/components/copy-message-text";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { useToastStoreForTesting } from "@/stores/toast.store";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const LIST_URL =
  "/api/projects/p1/sessions/s1/conversations/c1/context-artifacts";
const DETAIL_URL = `${LIST_URL}/art-1`;
const GENERATE_NAME_URL =
  "/api/projects/p1/sessions/s1/conversations/c1/generate-name";

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
    if (url === GENERATE_NAME_URL && method === "POST") {
      return jsonResponse({ name: "Generated Name" });
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

describe("MessageActions clip action", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    useSessionDetailStore.getState().resetStore();
    useToastStoreForTesting.setState({ toasts: [] });
  });
  afterEach(() => vi.unstubAllGlobals());

  const NOTEPAD_ROW = {
    id: "np-1",
    scope: "project",
    projectPath: "/repos/p1",
    projectName: "p1",
    name: "capture target",
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };

  /** Artifact routes plus the notepad listing/append the clip landing hits. */
  function routeClipFetch(artifacts: ContextArtifactListItem[]) {
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === LIST_URL && method === "GET") return jsonResponse(artifacts);
      if (url.startsWith("/api/notepads?") && method === "GET") {
        return jsonResponse({ notepads: [NOTEPAD_ROW] });
      }
      if (url === "/api/notepads/np-1/content" && method === "POST") {
        return jsonResponse({
          notepad: { ...NOTEPAD_ROW, content: "landed", revision: 2 },
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
  }

  function appendBodies(): unknown[] {
    return fetchSpy.mock.calls
      .filter((call) => String(call[0]) === "/api/notepads/np-1/content")
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
  }

  it("offers Clip under exactly the copy-reference gate", () => {
    routeClipFetch([]);
    renderActions({ compactionTarget: undefined, messageRef: messageRefMeta });
    expect(
      screen.queryByRole("button", { name: "Clip message to notepad" }),
    ).not.toBeInTheDocument();

    renderActions({ messageRef: undefined });
    expect(
      screen.queryByRole("button", { name: "Clip message to notepad" }),
    ).not.toBeInTheDocument();

    renderActions({ messageRef: messageRefMeta });
    expect(
      screen.getByRole("button", { name: "Clip message to notepad" }),
    ).toBeInTheDocument();
  });

  it("clips the full message text as a non-code fragment carrying copy-reference's exact XML", async () => {
    routeClipFetch([]);
    renderActions({ messageRef: messageRefMeta });

    // Capture the reference the Copy-reference action would produce — the
    // clip's provenance must be built from the same inputs.
    fireEvent.click(
      screen.getByRole("button", { name: "Copy message reference" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedXml = writeText.mock.calls[0]![0];

    fireEvent.click(
      screen.getByRole("button", { name: "Clip message to notepad" }),
    );
    await waitFor(() => expect(appendBodies()).toHaveLength(1));

    expect(appendBodies()[0]).toEqual({
      operation: "append",
      content: buildClipFragment({
        text: extractCopyText(toolContent),
        isCode: false,
        provenance: { kind: "ref", xml: copiedXml },
      }),
    });
  });

  it("advertises a complete compaction on the clipped reference like copy-reference does", async () => {
    routeClipFetch([buildArtifactListItem()]);
    renderActions({ messageRef: messageRefMeta });
    await screen.findByRole("button", { name: "View compacted message" });

    fireEvent.click(
      screen.getByRole("button", { name: "Clip message to notepad" }),
    );
    await waitFor(() => expect(appendBodies()).toHaveLength(1));

    const content = (appendBodies()[0] as { content: string }).content;
    const attrs = messageRefAttrsSchema.parse(
      findMessageRefs(content)[0]!.attrs,
    );
    expect(attrs.compacted).toBe("true");
    expect(attrs["compact-artifact-id"]).toBe("art-1");
  });

  it("clips nothing when the message has no copyable text", () => {
    routeClipFetch([]);
    renderActions({
      messageRef: messageRefMeta,
      content: [{ type: "tool_use", name: "Bash" }],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Clip message to notepad" }),
    );

    expect(appendBodies()).toHaveLength(0);
  });
});

// R7.1: a fork at message index 0 derives from no session, so the conversation
// it creates is a fresh one and gets the same profile selection every other
// visible creation path offers. Later indices inherit the source snapshot
// verbatim and must offer nothing to choose.
describe("MessageActions fork action", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/projects/p1/agent-profiles") {
        return jsonResponse({
          profiles: [
            {
              ref: { tier: "builtin", id: "standard-agent" },
              name: "Standard Agent",
              description: "No specialization lens.",
              revision: 1,
              recommendedFor: ["conversation"],
              tags: [],
              readOnly: true,
            },
            {
              ref: { tier: "project", id: "reviewer" },
              name: "Code Reviewer",
              description: "Reviews a diff against the repo's contract.",
              revision: 3,
              recommendedFor: ["conversation"],
              tags: [],
              readOnly: false,
            },
          ],
          diagnostics: [],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("forks a session-derived message immediately, with no profile selection", async () => {
    const onFork = vi.fn();
    renderActions({
      messageIndex: 4,
      compactionTarget: undefined,
      forkProjectName: "p1",
      onFork,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Fork conversation from this message",
      }),
    );

    expect(onFork).toHaveBeenCalledWith(4, undefined);
    expect(
      screen.queryByRole("combobox", { name: /agent profile/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the fork refusal and prevents activation", () => {
    const onFork = vi.fn();
    renderActions({
      onFork,
      compactionTarget: undefined,
      forkRefusal: {
        backend: "cursor",
        operation: "fork",
        code: "backend-fork-unsupported",
        message: "Cursor cannot fork this conversation with its history.",
      },
    });
    expect(
      screen.getByRole("button", {
        name: "Fork conversation from this message",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Cursor cannot fork this conversation with its history.",
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Fork conversation from this message",
      }),
    );
    expect(onFork).not.toHaveBeenCalled();
  });

  it("associates simultaneous fork controls with their own refusal", () => {
    for (const backend of ["cursor", "claude"] as const) {
      renderActions({
        compactionTarget: undefined,
        onFork: () => {},
        forkRefusal: {
          backend,
          operation: "fork",
          code: "backend-fork-unsupported",
          message: `${backend} fork reason`,
        },
      });
    }
    const controls = screen.getAllByRole("button", {
      name: "Fork conversation from this message",
    });
    expect(controls[0]).toHaveAccessibleDescription("cursor fork reason");
    expect(controls[1]).toHaveAccessibleDescription("claude fork reason");
  });

  it("offers a Standard-Agent-defaulted profile picker on an index-0 fork", async () => {
    const onFork = vi.fn();
    renderActions({
      messageIndex: 0,
      role: "user",
      forkRefusal: {
        backend: "cursor",
        operation: "fork",
        code: "backend-fork-unsupported",
        message: "Cursor cannot fork this conversation with its history.",
      },
      compactionTarget: undefined,
      forkProjectName: "p1",
      onFork,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Fork conversation from this message",
      }),
    );
    expect(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");
    // Opening the picker is not forking — the selection is made first.
    expect(onFork).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fork conversation" }));
    expect(onFork).toHaveBeenCalledWith(0, {
      tier: "builtin",
      id: "standard-agent",
    });
  });
});

describe("MessageActions generate-name action", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["user", "assistant"] as const)(
    "renders for a %s message when a target is present",
    async (role) => {
      routeFetch([]);
      renderActions({ role });

      expect(
        await screen.findByRole("button", {
          name: "Name conversation from this message",
        }),
      ).toBeInTheDocument();
    },
  );

  it("is absent without a target", () => {
    renderActions({ compactionTarget: undefined });

    expect(
      screen.queryByRole("button", {
        name: "Name conversation from this message",
      }),
    ).not.toBeInTheDocument();
  });

  it("POSTs the row message index", async () => {
    routeFetch([]);
    renderActions({ role: "user" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Name conversation from this message",
      }),
    );

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0]?.[0]).toBe(GENERATE_NAME_URL);
    expect(
      JSON.parse(String((postCalls()[0]?.[1] as RequestInit).body)),
    ).toEqual({ source: "message", messageIndex: 3 });
  });

  it("shows a disabled pending state while generation is in flight", async () => {
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));
    renderActions({ role: "user" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Name conversation from this message",
      }),
    );

    const pending = await screen.findByRole("button", {
      name: "Generating name…",
    });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
  });
});
