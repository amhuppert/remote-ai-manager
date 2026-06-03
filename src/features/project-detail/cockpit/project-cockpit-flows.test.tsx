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
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ProjectCockpit from "./ProjectCockpit";
import ProjectFirstRun from "./ProjectFirstRun";
import UnifiedComposer from "../composer/UnifiedComposer";
import SessionsPanel from "./SessionsPanel";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import type { ConversationState } from "@/lib/conversations/schemas";
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

/** Mirrors ProjectDetailView's first-run↔cockpit branch by open-count. */
function PageHarness({
  openConversations,
}: {
  openConversations: ConversationState[];
}) {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  const shared = {
    projectName: "proj",
    sessions: [runningSession],
    archivedCount: 0,
    tokens,
    onTokensChange: setTokens,
    onRunCommand: vi.fn(),
    selectedBackend: backend,
    onSelectedBackendChange: setBackend,
  };
  return openConversations.length > 0 ? (
    <ProjectCockpit
      {...shared}
      openConversations={openConversations}
      rail={<div data-testid="rail-stub" />}
    />
  ) : (
    <ProjectFirstRun {...shared} />
  );
}

describe("project page: first-run ↔ cockpit transition", () => {
  it("renders first-run (no tabs) with zero open conversations, then the cockpit with the entry animation once one is open", () => {
    const { container, rerender } = render(
      withClient(<PageHarness openConversations={[]} />),
    );
    // First-run: the composer is present; no conversation tabs.
    expect(screen.getByLabelText("Project composer")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();

    // The foundation reports the first open conversation → cockpit.
    rerender(
      withClient(<PageHarness openConversations={[makeConversation("c1")]} />),
    );
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByTestId("rail-stub")).toBeInTheDocument();
    // Entry animation applied on the zero→one crossing.
    expect(container.querySelector(".plc-enter")).not.toBeNull();
  });

  it("returns to first-run when the last open conversation closes", () => {
    const { rerender } = render(
      withClient(<PageHarness openConversations={[makeConversation("c1")]} />),
    );
    expect(screen.getByRole("tablist")).toBeInTheDocument();

    rerender(withClient(<PageHarness openConversations={[]} />));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByLabelText("Project composer")).toBeInTheDocument();
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
    // Pre-init: the backend toggle is interactive, not the locked badge.
    expect(document.querySelector(".backend-toggle-badge")).toBeNull();
    const codexBtn = document.querySelector('[data-backend="codex"]');
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn!);
    expect(onSelectedBackendChange).toHaveBeenCalledWith("codex");

    // When the page reflects the new selection, the composer recolors to Codex
    // (the composer value tracks the pre-init selection, not the conv's backend).
    rerender(withClient(<ProjectCockpit {...props("codex")} />));
    expect(document.querySelector(".plc-uc")?.getAttribute("data-agent")).toBe(
      "codex",
    );
  });
});

describe("project page: command palette", () => {
  it("opens the palette on `/` and runs the highlighted command", () => {
    const onRunCommand = vi.fn();
    render(
      withClient(
        <UnifiedComposer
          projectName="proj"
          activeConversationId="c1"
          activeConversation={makeConversation("c1")}
          agentBackend="claude"
          onAgentChange={vi.fn()}
          tokens={[]}
          onTokensChange={vi.fn()}
          sessions={[runningSession]}
          archivedCount={0}
          onSendPrompt={vi.fn()}
          onRunCommand={onRunCommand}
          busy={false}
        />,
      ),
    );
    const ta = screen.getByLabelText("Project composer");
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "/" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("new");
  });
});

describe("project page: shared filter state", () => {
  it("a filter typed in the composer appears as a chip in the sessions panel", () => {
    function FilterHarness() {
      const [tokens, setTokens] = useState<FilterToken[]>([]);
      return (
        <>
          <UnifiedComposer
            projectName="proj"
            activeConversationId="c1"
            activeConversation={makeConversation("c1")}
            agentBackend="claude"
            onAgentChange={vi.fn()}
            tokens={tokens}
            onTokensChange={setTokens}
            sessions={[runningSession]}
            archivedCount={0}
            onSendPrompt={vi.fn()}
            onRunCommand={vi.fn()}
            busy={false}
          />
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
    const ta = screen.getByLabelText("Project composer");
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "is:running" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    // The shared token surfaces as a chip in the sessions panel.
    expect(screen.getByText("is:running")).toBeInTheDocument();
  });
});
