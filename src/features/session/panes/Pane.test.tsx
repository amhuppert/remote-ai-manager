// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { z } from "zod";
import type { stampedTranscriptMessageSchema } from "@/lib/conversations/schemas";
import Pane from "./Pane";

type StampedTranscriptMessage = z.infer<typeof stampedTranscriptMessageSchema>;

const PROJECT = "proj";
const SESSION = "sess";
const CONV_ID = "conv-1";

function baseConversation(
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id: CONV_ID,
    name: "Fix the bug",
    status: "running",
    lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    projectName: PROJECT,
    projectPath: "/tmp/proj",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/tmp/proj/.worktrees/sess",
    lastActivitySummary: "Edited three files",
    unread: false,
    pendingApproval: null,
    sessionName: SESSION,
    branchName: "csm/sess",
    ...overrides,
  };
}

function textMessage(seq: number, text: string): StampedTranscriptMessage {
  return {
    seq,
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

function renderPane(
  props: {
    conversation?: SessionActiveConversation;
    active?: boolean;
    onActivate?: (id: string) => void;
    onOpenFull?: (id: string) => void;
    onClose?: (id: string) => void;
  } = {},
  messages: StampedTranscriptMessage[] | undefined = [],
) {
  const conversation = props.conversation ?? baseConversation();
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  if (messages !== undefined) {
    qc.setQueryData(
      conversationKeys.messages(
        conversation.projectName,
        conversation.sessionName,
        conversation.id,
      ),
      messages,
    );
  }
  const onActivate = props.onActivate ?? vi.fn();
  const onOpenFull = props.onOpenFull ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const onOpenConversation = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <Pane
        conversation={conversation}
        active={props.active ?? false}
        onActivate={onActivate}
        onOpenFull={onOpenFull}
        onClose={onClose}
        onOpenConversation={onOpenConversation}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onActivate, onOpenFull, onClose };
}

describe("Pane", () => {
  it("renders the head: title, open-full and close controls (4.1)", () => {
    renderPane();

    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open full" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close pane" }),
    ).toBeInTheDocument();
  });

  it("open-full calls onOpenFull and not onActivate (4.7)", () => {
    const { onOpenFull, onActivate } = renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Open full" }));

    expect(onOpenFull).toHaveBeenCalledWith(CONV_ID);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("close calls onClose and not onActivate (4.8)", () => {
    const { onClose, onActivate } = renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));

    expect(onClose).toHaveBeenCalledWith(CONV_ID);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("clicking the pane activates when not active (5.2)", () => {
    const { onActivate, container } = renderPane({ active: false });

    fireEvent.click(container.querySelector("section") as HTMLElement);

    expect(onActivate).toHaveBeenCalledWith(CONV_ID);
  });

  it("clicking the pane does not re-activate when already active (5.2)", () => {
    const { onActivate, container } = renderPane({ active: true });

    fireEvent.click(container.querySelector("section") as HTMLElement);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("renders the meta line: status label, project/session, relative time (4.2)", () => {
    const { container } = renderPane();
    const section = container.querySelector("section") as HTMLElement;

    expect(section.textContent).toContain("running");
    expect(section.textContent).toContain(PROJECT);
    expect(section.textContent).toContain(SESSION);
    expect(section.textContent).toContain("ago");
  });

  it("shows the pending-question banner instead of the status line when waiting for input (4.3)", () => {
    renderPane({
      conversation: baseConversation({
        status: "waiting_for_input",
        pendingQuestion: "Should I delete the file?",
      }),
    });

    expect(screen.getByText("Should I delete the file?")).toBeInTheDocument();
    // The status line (lastActivitySummary) is suppressed while the banner shows.
    expect(screen.queryByText("Edited three files")).toBeNull();
  });

  it("shows the status line when not waiting for input (4.4)", () => {
    renderPane({
      conversation: baseConversation({ status: "running" }),
    });

    expect(screen.getByText("Edited three files")).toBeInTheDocument();
  });

  it("renders the empty state when an idle conversation has no messages", () => {
    // `new` (not `running`): an idle conversation with no transcript shows the
    // empty placeholder. A *running* empty conversation shows the typing
    // indicator instead (see the "agent responding indicator" describe below).
    renderPane({ conversation: baseConversation({ status: "new" }) }, []);

    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("renders the full transcript body, not the empty state, when messages are present (2/3)", () => {
    const { container } = renderPane({}, [
      textMessage(1, "first"),
      textMessage(2, "second"),
      textMessage(3, "third"),
    ]);

    // The real message-rendering section mounts (the `.conversation` thread,
    // marked by data-backend), so the empty-state placeholder is gone. The rows
    // themselves are virtualized and render nothing under jsdom.
    expect(screen.queryByText("No messages yet")).toBeNull();
    expect(container.querySelector("[data-backend]")).not.toBeNull();
  });

  it("does not render a composer inside the pane (4.9)", () => {
    const { container } = renderPane();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  describe("agent responding indicator (loading state)", () => {
    beforeEach(() => useSessionDetailStore.getState().resetStore());
    afterEach(() => useSessionDetailStore.getState().resetStore());

    // The pane body is virtualized (react-virtuoso renders no items — and no
    // Footer — under jsdom), so the in-thread typing footer isn't assertable
    // here. The empty-but-running branch renders the indicator directly (not
    // through Virtuoso), mirroring ProjectTranscriptHost, so it is the
    // jsdom-observable signal that a pane surfaces agent activity.
    it("shows the typing indicator in the active pane while its agent is responding", () => {
      const { container } = renderPane(
        { active: true, conversation: baseConversation({ status: "running" }) },
        [],
      );

      expect(container.querySelector(".typing-indicator")).not.toBeNull();
      expect(screen.queryByText("No messages yet")).toBeNull();
    });

    it("shows the typing indicator in a non-active pane whose own agent is responding", () => {
      const { container } = renderPane(
        {
          active: false,
          conversation: baseConversation({ status: "running" }),
        },
        [],
      );

      expect(container.querySelector(".typing-indicator")).not.toBeNull();
      expect(screen.queryByText("No messages yet")).toBeNull();
    });

    it("does not show the typing indicator when the agent is not responding", () => {
      const { container } = renderPane(
        {
          active: true,
          conversation: baseConversation({ status: "awaiting" }),
        },
        [],
      );

      expect(container.querySelector(".typing-indicator")).toBeNull();
      expect(container.querySelector(".streaming-indicator")).toBeNull();
      expect(screen.getByText("No messages yet")).toBeInTheDocument();
    });
  });

  describe("stop control", () => {
    beforeEach(() => useSessionDetailStore.getState().resetStore());
    afterEach(() => {
      useSessionDetailStore.getState().resetStore();
      vi.restoreAllMocks();
    });

    it("shows Stop for a running conversation and posts to the abort endpoint", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));

      renderPane({ conversation: baseConversation({ status: "running" }) });

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

      await waitFor(() => {
        const urls = fetchSpy.mock.calls.map(([u]) => String(u));
        expect(
          urls.some((u) => u.endsWith(`/conversations/${CONV_ID}/abort`)),
        ).toBe(true);
      });
    });

    it("hides Stop for an idle conversation", () => {
      renderPane({ conversation: baseConversation({ status: "awaiting" }) });
      expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
    });
  });

  describe("optimistic message isolation (split-screen)", () => {
    beforeEach(() => useSessionDetailStore.getState().resetStore());
    afterEach(() => useSessionDetailStore.getState().resetStore());

    // The pane body is virtualized (react-virtuoso renders no items under
    // jsdom), so message text isn't assertable. Instead we use an empty-server
    // conversation: whether the in-flight optimistic row is merged flips the
    // pane between its "No messages yet" empty state (no rows) and the
    // transcript body (one optimistic row) — a non-virtualized DOM difference.
    it("merges the in-flight optimistic message only into its own conversation's pane", () => {
      // The shared pinned composer submitted a message to the active pane's
      // conversation; in-flight state is keyed to that conversation id.
      useSessionDetailStore
        .getState()
        .submitPrompt(
          CONV_ID,
          [{ type: "text", text: "pending to active convo" }],
          0,
        );

      // A pane showing a DIFFERENT idle conversation has no server messages
      // and must NOT inherit the other conversation's optimistic row → empty
      // state. Status is `awaiting` (not `running`) so the empty-vs-body signal
      // isolates the optimistic-merge variable from the running-pane typing
      // indicator (which would otherwise replace the empty state).
      const inactive = renderPane(
        {
          active: false,
          conversation: baseConversation({
            id: "conv-other",
            status: "awaiting",
          }),
        },
        [],
      );
      expect(screen.getByText("No messages yet")).toBeInTheDocument();
      inactive.unmount();

      // The pane showing the submitting conversation merges the optimistic
      // row, so it shows the transcript body (marked by data-backend), not the
      // empty state.
      const active = renderPane({ active: true }, []);
      expect(screen.queryByText("No messages yet")).toBeNull();
      expect(active.container.querySelector("[data-backend]")).not.toBeNull();
    });
  });
});
