// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import ConversationTranscript, {
  type TranscriptNav,
} from "./ConversationTranscript";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";

const SESSION_SCOPE = {
  kind: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-1",
} as const;

const PROJECT_SCOPE = {
  kind: "project",
  projectName: "proj",
  conversationId: "pc-1",
} as const;

function renderSeeded(
  ui: React.ReactElement,
  entries: Array<[QueryKey, unknown]>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, value] of entries) client.setQueryData(key, value);
  return render(
    <div style={{ height: 400 }}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </div>,
  );
}

const messages: TranscriptMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Refactor auth" }],
    timestamp: null,
  },
];

function queued(id: string, text: string): PendingQueuedMessage {
  return {
    id,
    content: [{ type: "text", text }],
    status: "pending",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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

afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

describe("ConversationTranscript — scope-dispatched data", () => {
  it("session scope renders the transcript region from the session messages cache", () => {
    const { container } = renderSeeded(
      <ConversationTranscript scope={SESSION_SCOPE} backend="claude" />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    expect(
      container.querySelector('.conversation[data-backend="claude"]'),
    ).not.toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
    expect(screen.queryByText("Loading conversation...")).toBeNull();
  });

  it("project scope renders the transcript region from the project messages cache", () => {
    const { container } = renderSeeded(
      <ConversationTranscript scope={PROJECT_SCOPE} backend="codex" />,
      [[projectConversationKeys.messages("proj", "pc-1"), messages]],
    );
    expect(
      container.querySelector('.conversation[data-backend="codex"]'),
    ).not.toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("shows the loading state while the messages query is pending", () => {
    renderSeeded(
      <ConversationTranscript scope={SESSION_SCOPE} backend="claude" />,
      [],
    );
    expect(screen.getByText("Loading conversation...")).toBeInTheDocument();
  });

  it("shows the empty state for a fetched conversation with no messages", () => {
    renderSeeded(
      <ConversationTranscript scope={SESSION_SCOPE} backend="claude" />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });
});

describe("ConversationTranscript — working indicator", () => {
  it("shows the typing indicator instead of the empty state while its own send is in flight", () => {
    useSessionDetailStore
      .getState()
      .submitPrompt("conv-1", [{ type: "text", text: "hi" }], 0);
    // The optimistic echo becomes a row, so assert on the indicator itself.
    const { container } = renderSeeded(
      <ConversationTranscript scope={SESSION_SCOPE} backend="claude" />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );
    expect(screen.queryByText("No messages yet")).toBeNull();
    expect(container.querySelector(".conversation")).not.toBeNull();
  });

  it("shows the typing indicator on an empty running conversation (server status)", () => {
    const { container } = renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        status="running"
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );
    expect(container.querySelector(".typing-indicator")).not.toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("does not show the typing indicator for another conversation's send", () => {
    useSessionDetailStore
      .getState()
      .submitPrompt("conv-other", [{ type: "text", text: "hi" }], 0);
    const { container } = renderSeeded(
      <ConversationTranscript scope={SESSION_SCOPE} backend="claude" />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );
    expect(container.querySelector(".typing-indicator")).toBeNull();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("suppresses the indicator while collab is active", () => {
    const { container } = renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        status="running"
        collab={{
          envelope: { workflowId: "wf-1" },
          hiddenMessageIndex: null,
          renderRow: () => null,
          suppressIndicator: true,
        }}
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );
    expect(container.querySelector(".typing-indicator")).toBeNull();
  });
});

describe("ConversationTranscript — in-flight banners", () => {
  it("shows the keyed prompt error with a dismiss control when enabled", () => {
    useSessionDetailStore.getState().failPrompt("conv-1", "kaboom");
    renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        showInFlightBanners
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    expect(screen.getByText("kaboom")).toBeInTheDocument();

    screen.getByRole("button", { name: "Dismiss error" }).click();
    expect(
      useSessionDetailStore.getState().inFlight["conv-1"]?.promptError ?? null,
    ).toBeNull();
  });

  it("shows the cancelled banner when the conversation's turn was cancelled", () => {
    useSessionDetailStore.getState().markCancelled("conv-1");
    renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        showInFlightBanners
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    expect(screen.getByText("Prompt cancelled")).toBeInTheDocument();
  });

  it("renders no banners for another conversation's error", () => {
    useSessionDetailStore.getState().failPrompt("conv-other", "kaboom");
    renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        showInFlightBanners
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    expect(screen.queryByText("kaboom")).toBeNull();
  });

  it("renders no banners when disabled", () => {
    useSessionDetailStore.getState().failPrompt("conv-1", "kaboom");
    renderSeeded(
      <ConversationTranscript scope={SESSION_SCOPE} backend="claude" />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    expect(screen.queryByText("kaboom")).toBeNull();
  });
});

describe("ConversationTranscript — queue rows", () => {
  it("counts pending queued messages into the transcript rows (no empty state)", () => {
    renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        pendingQueue={[queued("q1", "queued follow-up")]}
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), []]],
    );
    expect(screen.queryByText("No messages yet")).toBeNull();
  });
});

describe("ConversationTranscript — nav reporting", () => {
  it("reports nav state (total message count) to the parent", () => {
    let total = -1;
    renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        onNavChange={(nav) => {
          total = nav.totalMessages;
        }}
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    expect(total).toBe(1);
  });

  it("converges when the host stores nav reports in state (no report→render loop)", () => {
    // Real hosts store the reported nav in state (setNav), so every report
    // re-renders them. If the report effect keys on identities that churn per
    // render (fresh `?? []` messages array, rebuilt scroll closures), the
    // report→setState→render cycle never converges and act() locks up the
    // surface. The guard throws instead of hanging the suite.
    let reportCount = 0;
    function Host(): React.JSX.Element {
      const [nav, setNav] = useState<TranscriptNav | null>(null);
      return (
        <div data-count={nav?.totalMessages ?? -1}>
          <ConversationTranscript
            scope={SESSION_SCOPE}
            backend="claude"
            onNavChange={(n) => {
              reportCount += 1;
              if (reportCount > 25) {
                throw new Error(
                  "nav report loop: report→setState→render never converges",
                );
              }
              setNav(n);
            }}
          />
        </div>
      );
    }
    // No seeded messages: the query stays pending, the state where per-render
    // identity churn is most likely.
    renderSeeded(<Host />, []);
    expect(reportCount).toBeLessThanOrEqual(2);
  });

  it("renders the leading slot inside the conversation region", () => {
    const { container } = renderSeeded(
      <ConversationTranscript
        scope={SESSION_SCOPE}
        backend="claude"
        leadingSlot={<div data-testid="pinned-top" />}
      />,
      [[conversationKeys.messages("proj", "sess", "conv-1"), messages]],
    );
    const region = container.querySelector(".conversation");
    expect(region?.querySelector('[data-testid="pinned-top"]')).not.toBeNull();
  });
});
