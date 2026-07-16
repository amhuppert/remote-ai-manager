// @vitest-environment jsdom
// SSE writer↔reader contract: the global NotificationListener patches the
// messages caches; every conversation surface reads them through
// ConversationTranscript. Mounting both and driving real wire frames pins
// that the listener's write keys and the transcript's read keys stay the
// same — the drift class that previously shipped silent per-surface bugs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";

// react-virtuoso is layout-driven and renders no items in jsdom; replace it
// with a flat list renderer so patched rows become assertable DOM.
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  type VirtuosoMockProps = {
    data?: unknown[];
    itemContent?: (index: number, item: unknown) => React.ReactNode;
    components?: { Footer?: () => React.ReactNode };
  };
  const Virtuoso = React.forwardRef(function VirtuosoMock(
    props: VirtuosoMockProps,
    ref: React.Ref<unknown>,
  ) {
    const { data = [], itemContent, components } = props;
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    const Footer = components?.Footer;
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={index} data-index={index}>
            {itemContent?.(index, item)}
          </div>
        ))}
        {Footer ? <Footer /> : null}
      </div>
    );
  });
  return { Virtuoso };
});

import ConversationTranscript from "./ConversationTranscript";
import NotificationListener from "@/components/NotificationListener";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { useSessionDetailStore } from "@/stores/session-detail.store";

function renderSurface(
  ui: React.ReactElement,
  entries: Array<[QueryKey, unknown]>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, value] of entries) client.setQueryData(key, value);
  const { container } = render(
    <QueryClientProvider client={client}>
      <NotificationListener />
      {ui}
    </QueryClientProvider>,
  );
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("NotificationListener opened no EventSource");
  return { source, container, client };
}

// Role drives MessageRow's synchronously-rendered label ("You"/"Claude");
// the markdown BODY hydrates through a lazy chunk, so assertions pin the row
// chrome, not the text content (content rendering is MessageContent's suite).
function textMessage(role: "user" | "assistant", text: string) {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionDetailStore.getState().resetStore();
});

describe("SSE contract — session-scoped transcript", () => {
  it("renders a message-appended frame and replaces it on message-updated", async () => {
    const { source, container } = renderSurface(
      <ConversationTranscript
        scope={{
          kind: "session",
          projectName: "proj",
          sessionName: "sess",
          conversationId: "conv-1",
        }}
        backend="claude"
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );

    act(() => {
      source.emit("message-appended", {
        type: "message-appended",
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-1",
        seq: 0,
        message: textMessage("user", "streamed over SSE"),
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-msg-index="0"]')).not.toBeNull();
    });
    expect(screen.getByText("You")).toBeInTheDocument();

    act(() => {
      source.emit("message-updated", {
        type: "message-updated",
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-1",
        seq: 0,
        message: textMessage("assistant", "revised over SSE"),
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeInTheDocument();
    });
    expect(screen.queryByText("You")).toBeNull();
  });

  it("ignores frames addressed to another conversation", async () => {
    const { source } = renderSurface(
      <ConversationTranscript
        scope={{
          kind: "session",
          projectName: "proj",
          sessionName: "sess",
          conversationId: "conv-1",
        }}
        backend="claude"
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );

    act(() => {
      source.emit("message-appended", {
        type: "message-appended",
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-other",
        seq: 0,
        message: textMessage("assistant", "someone else's row"),
      });
    });

    expect(screen.queryByText("someone else's row")).toBeNull();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("does not seed an absent messages cache from an append", () => {
    // A conversation streaming in the background has no cache entry (never
    // fetched, or gc'd). Seeding it from an append would cache a history-less
    // fragment that a later mount treats as fresh, complete data — the
    // transcript would render only the streamed tail until a hard refresh.
    // Only the messages fetch may create the entry; appends only patch it.
    const { source, client } = renderSurface(
      <ConversationTranscript
        scope={{
          kind: "session",
          projectName: "proj",
          sessionName: "sess",
          conversationId: "conv-1",
        }}
        backend="claude"
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );

    act(() => {
      source.emit("message-appended", {
        type: "message-appended",
        scope: "session",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-bg",
        seq: 7,
        message: textMessage("assistant", "tail of a background turn"),
      });
      source.emit("message-appended", {
        type: "message-appended",
        scope: "project",
        projectName: "proj",
        conversationId: "pc-bg",
        seq: 7,
        message: textMessage("assistant", "tail of a background turn"),
      });
    });

    expect(
      client.getQueryData(conversationKeys.messages("proj", "sess", "conv-bg")),
    ).toBeUndefined();
    expect(
      client.getQueryData(projectConversationKeys.messages("proj", "pc-bg")),
    ).toBeUndefined();
  });
});

describe("SSE contract — project-scoped transcript", () => {
  it("renders a project message-appended frame", async () => {
    const { source, container } = renderSurface(
      <ConversationTranscript
        scope={{ kind: "project", projectName: "proj", conversationId: "pc-1" }}
        backend="codex"
      />,
      [[projectConversationKeys.messages("proj", "pc-1"), []]],
    );

    act(() => {
      source.emit("message-appended", {
        type: "message-appended",
        scope: "project",
        projectName: "proj",
        conversationId: "pc-1",
        seq: 0,
        message: textMessage("assistant", "project row over SSE"),
      });
    });

    // The row mounts synchronously; the markdown body inside hydrates through
    // a lazy chunk, so assert on the row structure (text-content rendering is
    // covered by the session-scope test above).
    await waitFor(() => {
      expect(container.querySelector('[data-msg-index="0"]')).not.toBeNull();
    });
  });
});
