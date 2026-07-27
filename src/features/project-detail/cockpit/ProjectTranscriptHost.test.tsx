// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import ProjectTranscriptHost from "./ProjectTranscriptHost";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

// The virtualized list needs browser layout measurements that jsdom cannot
// provide; the flat renderer keeps this integration test on the real row path.
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

function renderSeeded(
  ui: React.ReactElement,
  entries: Array<[QueryKey, unknown]>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, value] of entries) client.setQueryData(key, value);
  return render(
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      <div style={{ height: 400 }}>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </div>
    </HotkeyProvider>,
  );
}

const messages: TranscriptMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Refactor auth" }],
    timestamp: null,
  },
];

afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

describe("ProjectTranscriptHost", () => {
  it("shows the empty transcript state when the conversation has no messages", () => {
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
      />,
      [[projectConversationKeys.messages("proj", "c1"), []]],
    );
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("renders the transcript surface (not the empty state) when messages exist", () => {
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
      />,
      [[projectConversationKeys.messages("proj", "c1"), messages]],
    );
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("shows the shared typing indicator (not a bespoke text status) while running with no messages", () => {
    const { container } = renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
        status="running"
      />,
      [[projectConversationKeys.messages("proj", "c1"), []]],
    );
    expect(container.querySelector(".typing-indicator")).not.toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("shows the typing indicator while a send is in flight, before the server reports running", () => {
    // useSendProjectPrompt marks the conversation's keyed in-flight state on
    // submit; the host reads it directly.
    useSessionDetailStore
      .getState()
      .submitPrompt("c1", [{ type: "text", text: "hi" }], 0);
    const { container } = renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
      />,
      [[projectConversationKeys.messages("proj", "c1"), []]],
    );
    expect(container.querySelector(".typing-indicator")).not.toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("does not render an 'Awaiting your input' transcript footer (the pane-header badge conveys awaiting, matching the session page)", () => {
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
        status="waiting_for_input"
      />,
      [[projectConversationKeys.messages("proj", "c1"), [...messages]]],
    );
    expect(screen.queryByText("Awaiting your input")).toBeNull();
  });

  it("does not show the empty state when only spawn cards are present", () => {
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
        spawnCards={[
          { kind: "spawn-card", proposalId: "p1", anchorMessageIndex: 0 },
        ]}
        renderSpawnCardRow={() => <div>card</div>}
      />,
      [[projectConversationKeys.messages("proj", "c1"), []]],
    );
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("collapses and expands every thinking block in the active project transcript", () => {
    const messagesWithThinking: TranscriptMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "Inspect the project transcript path." },
          { type: "text", text: "The path is shared." },
        ],
        timestamp: null,
      },
    ];
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
      />,
      [[projectConversationKeys.messages("proj", "c1"), messagesWithThinking]],
    );

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, {
      key: "C",
      code: "KeyC",
      shiftKey: true,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(document, {
      key: "E",
      code: "KeyE",
      shiftKey: true,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
