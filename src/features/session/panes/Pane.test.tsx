// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { conversationKeys } from "@/lib/conversations/query-keys";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { z } from "zod";
import type { stampedTranscriptMessageSchema } from "@/lib/conversations/queries";
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
  const utils = render(
    <QueryClientProvider client={qc}>
      <Pane
        conversation={conversation}
        active={props.active ?? false}
        onActivate={onActivate}
        onOpenFull={onOpenFull}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onActivate, onOpenFull, onClose };
}

describe("Pane", () => {
  it("renders the head: status dot, title, open-full and close controls (4.1)", () => {
    renderPane();

    expect(document.querySelector('[data-status="running"]')).not.toBeNull();
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

  it("clicking the pane body activates when not active (5.2)", () => {
    const { onActivate, container } = renderPane({ active: false });

    fireEvent.click(container.querySelector(".pane") as HTMLElement);

    expect(onActivate).toHaveBeenCalledWith(CONV_ID);
  });

  it("clicking the pane body does not re-activate when already active (5.2)", () => {
    const { onActivate, container } = renderPane({ active: true });

    fireEvent.click(container.querySelector(".pane") as HTMLElement);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("marks the active pane via data-active (5.1)", () => {
    const { container } = renderPane({ active: true });

    expect(container.querySelector('.pane[data-active="true"]')).not.toBeNull();
  });

  it("renders the meta line: status label, project/session, relative time (4.2)", () => {
    const { container } = renderPane();
    const meta = container.querySelector(".pane__meta") as HTMLElement;

    expect(meta.textContent).toContain("running");
    expect(meta.textContent).toContain(PROJECT);
    expect(meta.textContent).toContain(SESSION);
    expect(meta.textContent).toContain("ago");
  });

  it("renders the pending-question banner when waiting for input (4.3)", () => {
    const { container } = renderPane({
      conversation: baseConversation({
        status: "waiting_for_input",
        pendingQuestion: "Should I delete the file?",
      }),
    });

    const banner = container.querySelector(".pane__banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Should I delete the file?");
    expect(container.querySelector(".pane__status-line")).toBeNull();
  });

  it("renders the status line when not waiting for input (4.4)", () => {
    const { container } = renderPane({
      conversation: baseConversation({ status: "running" }),
    });

    const statusLine = container.querySelector(".pane__status-line");
    expect(statusLine).not.toBeNull();
    expect(statusLine?.textContent).toContain("Edited three files");
    expect(container.querySelector(".pane__banner")).toBeNull();
  });

  it("renders the empty state when the conversation has no messages", () => {
    const { container } = renderPane({}, []);

    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(container.querySelector(".pane__body")).toBeNull();
  });

  it("renders the full transcript body when messages are present (2/3)", () => {
    const { container } = renderPane({}, [
      textMessage(1, "first"),
      textMessage(2, "second"),
      textMessage(3, "third"),
    ]);

    // The real message-rendering section mounts; the empty/compact-tail
    // placeholders are gone (panes show the whole transcript, not a slice).
    expect(container.querySelector(".pane__body")).not.toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
    expect(container.querySelector(".pane-message")).toBeNull();
    expect(container.querySelector(".pane__tail")).toBeNull();
  });

  it("does not render a composer inside the pane (4.9)", () => {
    const { container } = renderPane();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});
