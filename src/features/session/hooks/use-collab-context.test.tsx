// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test/component-mocks";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  toPublicConversationState,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";
import { useCollabContext } from "./use-collab-context";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", parameters: { effort: "high" } },
  codex: {
    modelId: "gpt-5.4",
    parameters: { reasoning: "high", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

// Built through the production factory and projected by the production
// projector, so the hook sees the exact shape a real conversation reaches it as.
function conversationOn(backend: AgentBackendId): PublicConversationState {
  return toPublicConversationState(
    makeConversationState({ id: "conv-1", agentBackend: backend }),
  );
}

function renderCollabContext(activeConversation: PublicConversationState) {
  const client = createTestQueryClient();
  return renderHook(
    () =>
      useCollabContext({
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv-1",
        collaborationListQuery: { data: [] },
        activeConversation,
        rawMessages: [],
        openDocById: vi.fn(),
        backendDefaults: BACKEND_DEFAULTS,
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

describe("useCollabContext originating agent", () => {
  it("reports the conversation's own backend when it can collaborate", () => {
    expect(
      renderCollabContext(conversationOn("claude")).result.current
        .originatingCollabAgent,
    ).toBe("claude");
    expect(
      renderCollabContext(conversationOn("codex")).result.current
        .originatingCollabAgent,
    ).toBe("codex");
  });

  // Null is the signal PromptComposer gates the /collab row on. Reporting a
  // backend the conversation is not running would show the row with the wrong
  // agent named, and send a start request that adopts that backend onto the
  // conversation (spec R15.1, charter no-silent-substitution).
  it("reports no originating agent for a conversation Collaboration Mode does not run", () => {
    expect(
      renderCollabContext(conversationOn("cursor")).result.current
        .originatingCollabAgent,
    ).toBeNull();
  });
});
