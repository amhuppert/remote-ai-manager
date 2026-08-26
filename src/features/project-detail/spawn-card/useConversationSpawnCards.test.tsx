// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { useConversationSpawnCards } from "./useConversationSpawnCards";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

afterEach(cleanup);

const VALID_PROPOSAL = [
  "Here's my plan:",
  "",
  "```spawn-proposal",
  '{"sessions":[{"name":"auth","agent":"claude","mode":"normal"}]}',
  "```",
].join("\n");

function assistant(text: string): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

function Harness({
  messages,
  conversationId,
  sessions = [],
}: {
  messages: TranscriptMessage[];
  conversationId: string | null;
  sessions?: SessionListItem[];
}) {
  const { spawnCards, renderSpawnCardRow } = useConversationSpawnCards({
    projectName: "proj",
    conversationId,
    messages,
    sessions,
    backendDefaults: BACKEND_DEFAULTS,
  });
  return (
    <div>
      <span data-testid="card-count">{spawnCards.length}</span>
      {spawnCards.map((c) => (
        <div key={c.proposalId}>{renderSpawnCardRow(c)}</div>
      ))}
    </div>
  );
}

function renderHarness(props: React.ComponentProps<typeof Harness>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

describe("useConversationSpawnCards", () => {
  it("renders an inline spawn card for an agent proposal in the transcript", () => {
    renderHarness({
      conversationId: "plc-1",
      messages: [assistant(VALID_PROPOSAL)],
    });
    expect(screen.getByTestId("card-count")).toHaveTextContent("1");
    expect(screen.getByText("Proposed sessions")).toBeInTheDocument();
    // The proposed name renders; the branch is auto-derived from it (shown with
    // the "auto" chip), so "auth" appears as both the name and the branch slug.
    expect(screen.getAllByText("auth").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("auto")).toBeInTheDocument();
  });

  it("renders the non-actionable invalid state for a malformed proposal", () => {
    const bad = ["```spawn-proposal", '{"sessions":[]}', "```"].join("\n");
    renderHarness({ conversationId: "plc-1", messages: [assistant(bad)] });
    expect(screen.getByText("Invalid spawn proposal")).toBeInTheDocument();
    expect(screen.queryByText("Proposed sessions")).toBeNull();
  });

  it("emits no cards and a no-op renderer when no tab is focused", () => {
    renderHarness({
      conversationId: null,
      messages: [assistant(VALID_PROPOSAL)],
    });
    // Cards still derive from the messages, but the renderer is a no-op so the
    // card body never mounts without an owning conversation.
    expect(screen.queryByText("Proposed sessions")).toBeNull();
  });

  it("emits no cards for a transcript with no proposal", () => {
    renderHarness({
      conversationId: "plc-1",
      messages: [assistant("Just thinking out loud, no proposal here.")],
    });
    expect(screen.getByTestId("card-count")).toHaveTextContent("0");
  });
});
