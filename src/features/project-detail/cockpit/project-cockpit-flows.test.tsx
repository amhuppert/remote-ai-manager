// @vitest-environment jsdom
//
// End-to-end project-page flow coverage (Req 2.x, 4.7, 5.4, 6.2, 8.1, 8.2).
// The project's testing approach is deterministic jsdom integration (there is no
// committed Playwright suite); the foundation is mocked via seeded React Query
// state + injected fetch rather than a live server. These drive the REAL cockpit
// components through the documented flows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import ProjectCockpit from "./ProjectCockpit";
import SessionsPanel from "./SessionsPanel";
import { resolveProjectComposerSubmit } from "../composer/UnifiedComposer";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function makeConversation(
  id: string,
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    id,
    scope: "project",
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
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    ...o,
  };
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
  creationMode: "fast",
  tddEnabled: true,
  objective: null,
  derivedStatus: "running",
  promptCount: 1,
  derivedLastActivityAt: "2026-01-01T00:00:00Z",
  collabContribution: null,
  hasActiveGraphWorkflow: false,
};

beforeEach(() => {
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
  _useCockpitViewStore.getState()._reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Mirrors ProjectDetailView: the cockpit shell (rail + composer) is always
 * mounted; the open-conversation list only decides whether the pane shows tabs
 * or the empty create-a-conversation composer. */
function PageHarness({
  openConversations,
}: {
  openConversations: ConversationState[];
}) {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  return (
    <ProjectCockpit
      projectName="proj"
      sessions={[runningSession]}
      archivedCount={0}
      tokens={tokens}
      onTokensChange={setTokens}
      onRunCommand={vi.fn()}
      selectedBackend={backend}
      onSelectedBackendChange={setBackend}
      openConversations={openConversations}
      rail={<div data-testid="rail-stub" />}
    />
  );
}

function showConversationsView() {
  const viewTabs = screen.getByRole("tablist", { name: "Project view" });
  fireEvent.click(within(viewTabs).getByRole("tab", { name: /Conversations/ }));
}

describe("project page: empty ↔ populated cockpit transition", () => {
  it("defaults to the sessions view and toggles to the conversation workspace", async () => {
    render(
      withClient(
        <PageHarness openConversations={[makeConversation("planning")]} />,
      ),
    );

    const viewTabs = screen.getByRole("tablist", { name: "Project view" });
    const sessionsTab = within(viewTabs).getByRole("tab", {
      name: /Sessions/,
    });
    const conversationsTab = within(viewTabs).getByRole("tab", {
      name: /Conversations/,
    });
    // Captured while the sessions view is the default (visible); the reference
    // stays valid after switching so its later hidden state can be asserted.
    const sessionsPanel = screen.getByRole("tabpanel", { name: "Sessions" });

    expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    expect(conversationsTab).toHaveAttribute("aria-selected", "false");
    expect(sessionsPanel).toBeVisible();
    // The rail (and the conversation workspace it lives in) is only mounted in
    // the conversations view.
    expect(screen.queryByTestId("rail-stub")).toBeNull();

    fireEvent.click(conversationsTab);

    await waitFor(() =>
      expect(document.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(sessionsTab).toHaveAttribute("aria-selected", "false");
    expect(conversationsTab).toHaveAttribute("aria-selected", "true");
    expect(sessionsPanel).not.toBeVisible();
    expect(
      screen.getByRole("tabpanel", { name: "Conversations" }),
    ).toBeVisible();
    expect(screen.getByTestId("rail-stub")).toBeVisible();
  });

  it("keeps the rail and composer mounted with zero open conversations (no tabs), then shows the tab strip once one is open", async () => {
    const { rerender } = render(
      withClient(<PageHarness openConversations={[]} />),
    );
    showConversationsView();
    // Empty cockpit: the rail and composer are present; no conversation tabs.
    expect(screen.getByTestId("rail-stub")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(screen.queryByRole("tablist", { name: "Conversations" })).toBeNull();

    // The foundation reports the first open conversation → tab strip appears.
    rerender(
      withClient(<PageHarness openConversations={[makeConversation("c1")]} />),
    );
    expect(
      screen.getByRole("tablist", { name: "Conversations" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("rail-stub")).toBeInTheDocument();
  });

  it("keeps the rail and composer mounted (and drops the tab strip) when the last open conversation closes", async () => {
    const { rerender } = render(
      withClient(<PageHarness openConversations={[makeConversation("c1")]} />),
    );
    showConversationsView();
    expect(
      screen.getByRole("tablist", { name: "Conversations" }),
    ).toBeInTheDocument();

    rerender(withClient(<PageHarness openConversations={[]} />));
    expect(screen.queryByRole("tablist", { name: "Conversations" })).toBeNull();
    // The rail stays reachable — the whole point of always mounting the shell.
    expect(screen.getByTestId("rail-stub")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".prompt-input-area")).not.toBeNull(),
    );
  });
});

describe("project page: pre-init backend selection in the cockpit", () => {
  it("lets an uninitialized tab pick the backend and the composer follows the selection", () => {
    const onSelectedBackendChange = vi.fn();
    const conv = makeConversation("c1", {
      promptCount: 0,
      agentBackend: "claude",
    });
    const props = (backend: AgentBackendId) => ({
      projectName: "proj",
      openConversations: [conv],
      sessions: [runningSession],
      archivedCount: 0,
      tokens: [],
      onTokensChange: vi.fn(),
      onRunCommand: vi.fn(),
      selectedBackend: backend,
      onSelectedBackendChange,
      rail: <div data-testid="rail-stub" />,
    });
    const { rerender } = render(
      withClient(<ProjectCockpit {...props("claude")} />),
    );
    showConversationsView();
    // Pre-init: the backend toggle is interactive, not the locked badge.
    expect(document.querySelector(".backend-toggle-badge")).toBeNull();
    const codexBtn = document.querySelector('[data-backend="codex"]');
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn!);
    expect(onSelectedBackendChange).toHaveBeenCalledWith("codex");

    // When the page reflects the new selection, the composer recolors to Codex
    // (the composer value tracks the pre-init selection, not the conv's backend).
    rerender(withClient(<ProjectCockpit {...props("codex")} />));
    expect(
      document.querySelector('[data-backend="codex"]')?.className,
    ).toContain("active");
  });
});

describe("project page: per-conversation model memory", () => {
  it("derives the remembered controls from the last user turn in the active conversation", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [],
        timestamp: "2026-01-01T00:00:00Z",
        model: "opus",
        effort: "high",
      },
      {
        role: "assistant",
        content: [],
        timestamp: "2026-01-01T00:00:01Z",
        model: "opus",
        effort: "high",
      },
      {
        role: "user",
        content: [],
        timestamp: "2026-01-01T00:00:02Z",
        model: "sonnet",
        effort: "medium",
      },
      {
        role: "assistant",
        content: [],
        timestamp: "2026-01-01T00:00:03Z",
        model: "sonnet",
        effort: "medium",
      },
    ];

    expect(selectLastUserTurnAgentSettings(messages)).toEqual({
      modelId: "sonnet",
      effort: "medium",
    });
  });
});

describe("project page: command palette", () => {
  it("keeps slash-command routing at the project adapter boundary", () => {
    expect(
      resolveProjectComposerSubmit({
        draft: "/workflow-builder",
        pendingImages: [],
        tokens: [],
        backend: "claude",
        modelId: "claude-sonnet-4-5-20250929",
        effort: "high",
        effortSupported: true,
      }),
    ).toEqual({ kind: "command", id: "workflow-builder" });
  });
});

describe("project page: shared filter state", () => {
  it("a filter routed by the composer appears as a chip in the sessions panel", () => {
    function FilterHarness() {
      const [tokens, setTokens] = useState<FilterToken[]>([]);
      const nextTokens = resolveProjectComposerSubmit({
        draft: "is:running",
        pendingImages: [],
        tokens,
        backend: "claude",
        modelId: "claude-sonnet-4-5-20250929",
        effort: "high",
        effortSupported: true,
      });
      return (
        <>
          <button
            type="button"
            onClick={() => {
              if (nextTokens.kind === "tokens") setTokens(nextTokens.tokens);
            }}
          >
            Apply composer filter
          </button>
          <SessionsPanel
            projectName="proj"
            sessions={[runningSession]}
            tokens={tokens}
            onTokensChange={setTokens}
          />
        </>
      );
    }
    render(withClient(<FilterHarness />));
    fireEvent.click(screen.getByText("Apply composer filter"));
    // The shared token surfaces as a chip in the sessions panel.
    expect(screen.getByText("is:running")).toBeInTheDocument();
  });
});
