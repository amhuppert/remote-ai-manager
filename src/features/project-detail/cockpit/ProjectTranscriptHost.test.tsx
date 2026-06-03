// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import ProjectTranscriptHost from "./ProjectTranscriptHost";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

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

afterEach(cleanup);

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
    const { container } = renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
      />,
      [[projectConversationKeys.messages("proj", "c1"), messages]],
    );
    expect(screen.queryByText("No messages yet")).toBeNull();
    expect(container.querySelector(".plc-transcript")).not.toBeNull();
  });

  it("shows a working indicator instead of the empty state while running with no messages", () => {
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
        status="running"
      />,
      [[projectConversationKeys.messages("proj", "c1"), []]],
    );
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("shows an awaiting indicator when waiting for input with no messages", () => {
    renderSeeded(
      <ProjectTranscriptHost
        projectName="proj"
        conversationId="c1"
        selectedBackend="claude"
        status="waiting_for_input"
      />,
      [[projectConversationKeys.messages("proj", "c1"), []]],
    );
    expect(screen.getByText("Awaiting your input")).toBeInTheDocument();
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
});
