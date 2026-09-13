// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { graphWorkflowExecutionKeys } from "@/lib/workflows/query-keys";
import ConversationList from "./ConversationList";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/my-app/build-hotkeys",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

function renderPage(finished = false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchInterval: false },
    },
  });
  queryClient.setQueryData(sessionKeys.detail("my-app", "build-hotkeys"), {
    sessionName: "build-hotkeys",
    worktreePath: "/repos/my-app/.worktrees/build-hotkeys",
    branchName: "csm/build-hotkeys",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-07-01T09:00:00.000Z",
    lastActivityAt: "2026-07-01T10:00:00.000Z",
    archived: false,
    finished,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  });
  queryClient.setQueryData(
    conversationKeys.list("my-app", "build-hotkeys"),
    [],
  );
  queryClient.setQueryData(conversationKeys.active(), {
    conversations: [],
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  });
  queryClient.setQueryData(
    graphWorkflowExecutionKeys.detail("my-app", "build-hotkeys"),
    null,
  );
  const dispatcher = createHotkeyDispatcher();
  render(
    <HotkeyProvider dispatcher={dispatcher}>
      <QueryClientProvider client={queryClient}>
        <ConversationList projectName="my-app" sessionName="build-hotkeys" />
      </QueryClientProvider>
    </HotkeyProvider>,
  );
  return dispatcher;
}

beforeEach(() => {
  routerPush.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConversationList hotkeys", () => {
  it.each([false, true])(
    "creates and opens a conversation with C C (merged=%s)",
    async (finished) => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          expect(init?.method).toBe("POST");
          return Response.json({
            id: "created-conversation",
            scope: "session",
            name: null,
            transcriptPath: null,
            status: "new",
            promptCount: 0,
            createdAt: "2026-07-27T12:00:00.000Z",
            lastActivityAt: "2026-07-27T12:00:00.000Z",
            source: "cc",
            summary: null,
            archived: false,
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: null,
            pendingQuestionId: null,
            pendingQuestions: null,
            pendingPromptText: null,
            forkedFrom: null,
            role: null,
            activeTurnSource: null,
            contextTokens: null,
            contextWindowMax: null,
            debugMode: null,
            agentBackend: "claude",
            backendRef: null,
            unread: false,
            pendingQueue: [],
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      renderPage(finished);

      fireEvent.keyDown(document, { key: "c" });
      fireEvent.keyDown(document, { key: "c" });

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([, init]) => init?.method?.toUpperCase() === "POST",
          ),
        ).toHaveLength(1);
        expect(routerPush).toHaveBeenCalledWith(
          "/conversations?c=created-conversation",
        );
      });
    },
  );

  it("keeps new conversation available for a merged session", () => {
    const dispatcher = renderPage(true);

    expect(
      dispatcher
        .getCommands()
        .find((command) => command.definition.id === "newConversation")
        ?.available,
    ).toBe(true);
  });
});
