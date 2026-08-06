// @vitest-environment jsdom
//
// R4.2: the project cockpit mounts the SHARED question panel for the active
// conversation, hydrated from that conversation's DURABLE pending-question
// fields (not from a live event that a reload would lose), and submits answers
// through the project-scoped answer route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ProjectCockpit from "./ProjectCockpit";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import {
  useProjectConversationsQuery,
  useProjectConversationCreationsQuery,
} from "@/lib/project-conversations-client/queries";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import type { FilterToken } from "../components/filter-tokens";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", effort: "medium" },
  codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
};

const PENDING_QUESTIONS = [
  {
    id: "approach",
    question: "Which approach should I take?",
    options: [
      { label: "Rewrite", recommended: false },
      {
        label: "Patch",
        recommended: false,
        description: "Smaller blast radius",
      },
    ],
    multiSelect: false,
    required: true,
    allowNote: false,
  },
];

function makeConversation(
  id: string,
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    profileSnapshot: null,
    profileLockedAt: null,
    id,
    scope: "project",
    nameOrigin: "default",
    name: id,
    transcriptPath: null,
    status: "new",
    promptCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    ...o,
  };
}

/** A conversation as the server reports it while an agent waits for an answer. */
function waitingConversation(
  id: string,
  questionId = "q_1",
): ConversationState {
  return makeConversation(id, {
    status: "waiting_for_input",
    pendingQuestionId: questionId,
    pendingQuestions: PENDING_QUESTIONS,
  });
}

const runningSession: SessionListItem = {
  sessionName: "auth",
  worktreePath: "/tmp/auth",
  branchName: "csm/auth",
  targetBranch: "main",
  parentSessionName: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "normal",
  tddEnabled: true,
  derivedStatus: "running",
  promptCount: 1,
  derivedLastActivityAt: "2026-01-01T00:00:00Z",
  collabContribution: null,
  hasActiveGraphWorkflow: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function seededClient(conversations: ConversationState[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const c of conversations) {
    client.setQueryData(projectConversationKeys.messages("proj", c.id), []);
  }
  // The cockpit's own source of server truth for its tabs.
  client.setQueryData(projectConversationKeys.list("proj"), conversations);
  return client;
}

/**
 * The cockpit as the project page mounts it: its open-conversation list comes
 * from the list QUERY, so an optimistic cache write reaches the panel exactly
 * the way it does in the running app.
 */
function PageHarness() {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  const conversationsQuery = useProjectConversationsQuery("proj");
  const creationsQuery = useProjectConversationCreationsQuery("proj");
  const openConversations = conversationsQuery.data ?? [];
  return (
    <ProjectCockpit
      conversationCreations={creationsQuery.data ?? []}
      projectName="proj"
      sessions={[runningSession]}
      archivedCount={0}
      tokens={tokens}
      onTokensChange={setTokens}
      onRunCommand={vi.fn()}
      selectedBackend={backend}
      onSelectedBackendChange={setBackend}
      backendDefaults={BACKEND_DEFAULTS}
      openConversations={openConversations}
      rail={<div data-testid="rail-stub" />}
    />
  );
}

function showConversationsView() {
  const viewTabs = screen.getByRole("tablist", { name: "Project view" });
  fireEvent.click(within(viewTabs).getByRole("tab", { name: /Conversations/ }));
}

function selectTab(name: string) {
  const tabs = screen.getByRole("tablist", { name: "Conversations" });
  fireEvent.click(within(tabs).getByRole("tab", { name: new RegExp(name) }));
}

function questionPanel(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "Agent question" });
}

describe("project cockpit question panel (R4.2)", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    _useCockpitViewStore.getState()._reset();
    useSessionDetailStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _useCockpitViewStore.getState()._reset();
    useSessionDetailStore.getState().resetStore();
  });

  function renderCockpit(conversations: ConversationState[]) {
    const client = seededClient(conversations);
    // Serve the list route with the pending batch already consumed — what the
    // server reports once the answer lands, so the settle refetch confirms the
    // optimistic clear instead of contradicting it.
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/projects/proj/conversations") {
        return jsonResponse(
          conversations.map((c) => ({
            ...c,
            status: "running",
            pendingQuestionId: null,
            pendingQuestions: null,
          })),
        );
      }
      if (url.endsWith("/messages")) return jsonResponse([]);
      return jsonResponse({ ok: true });
    });
    render(
      <QueryClientProvider client={client}>
        <PageHarness />
      </QueryClientProvider>,
    );
    showConversationsView();
    return client;
  }

  it("renders the question from the conversation's persisted fields, with no live event involved", async () => {
    // Nothing streamed here — this is what a page load finds on the server.
    renderCockpit([waitingConversation("c1")]);

    await waitFor(() => expect(questionPanel()).not.toBeNull());
    // The question text renders in both the panel's rail and its card.
    expect(
      screen.getAllByText("Which approach should I take?").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Patch")).toBeInTheDocument();
    expect(screen.getByText("Smaller blast radius")).toBeInTheDocument();
  });

  it("shows the panel only on the tab whose conversation is waiting", async () => {
    renderCockpit([
      waitingConversation("c1"),
      makeConversation("c2", { status: "running" }),
    ]);

    await waitFor(() => expect(questionPanel()).not.toBeNull());

    selectTab("c2");
    await waitFor(() => expect(questionPanel()).toBeNull());

    selectTab("c1");
    await waitFor(() => expect(questionPanel()).not.toBeNull());
  });

  it("submits the answer through the project answer route and closes the panel", async () => {
    renderCockpit([waitingConversation("c1", "q_batch")]);
    await waitFor(() => expect(questionPanel()).not.toBeNull());

    fireEvent.click(screen.getByText("Patch"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    });

    const answerCall = await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) =>
        String(c[0]).endsWith("/answer"),
      );
      expect(call).toBeDefined();
      return call;
    });

    // The PROJECT route: a project conversation has no session to address it
    // by, and a session-shaped URL would carry the internal sentinel.
    expect(String(answerCall?.[0])).toBe(
      "/api/projects/proj/conversations/c1/answer",
    );
    const body: unknown = JSON.parse(String(answerCall?.[1]?.body ?? "null"));
    expect(body).toMatchObject({
      questionId: "q_batch",
      answers: { approach: { selected: ["Patch"] } },
    });

    // Optimistically cleared, so the composer comes back on submit rather than
    // on the refetch.
    await waitFor(() => expect(questionPanel()).toBeNull());
  });

  it("replaces the composer while a question is pending, and restores it after", async () => {
    renderCockpit([waitingConversation("c1")]);

    await waitFor(() => expect(questionPanel()).not.toBeNull());
    expect(screen.queryByTestId("prompt-send")).toBeNull();

    fireEvent.click(screen.getByText("Rewrite"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("prompt-send")).not.toBeNull(),
    );
  });
});
