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
import GlobalHotkeyHelp from "@/components/GlobalHotkeyHelp";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { resolveProjectComposerSubmit } from "../composer/UnifiedComposer";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type {
  PublicConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { loadGeneratedCursorModelCatalog } from "@/lib/agent-backends/cursor/model-catalog";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedModelOptions(client, "proj");
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function seedModelOptions(client: QueryClient, projectName: string): void {
  const catalogs = {
    claude: getStaticBackendModelCatalog("claude"),
    codex: getStaticBackendModelCatalog("codex"),
    cursor: loadGeneratedCursorModelCatalog(),
  };
  client.setQueryData(
    backendCatalogKeys.projectModelOptions(projectName),
    (["claude", "codex", "cursor"] as const).map((backend) => ({
      backend,
      models: [],
      defaultModelId: BACKEND_DEFAULTS[backend].modelId,
      source: "catalog" as const,
      modelCatalog: catalogs[backend],
      defaultSelection: BACKEND_DEFAULTS[backend],
      diagnostics: [],
    })),
  );
}

function withHotkeys(ui: React.ReactElement) {
  return (
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      {withClient(ui)}
    </HotkeyProvider>
  );
}

function withHotkeyLauncher(ui: React.ReactElement) {
  return (
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      {withClient(ui)}
      <GlobalHotkeyHelp />
    </HotkeyProvider>
  );
}

function pressSequence(...strokes: [key: string, code: string][]) {
  for (const [key, code] of strokes) {
    fireEvent.keyDown(document, { key, code });
  }
}

function pastePlainText(target: HTMLElement, text: string) {
  fireEvent.paste(target, {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

function openCommandLauncherFromPrompt(prompt: HTMLElement) {
  prompt.focus();
  fireEvent.keyDown(prompt, {
    key: ";",
    code: "Semicolon",
    ctrlKey: true,
  });
  fireEvent.keyUp(prompt, {
    key: ";",
    code: "Semicolon",
    ctrlKey: true,
  });
  fireEvent.keyUp(prompt, {
    key: "Control",
    code: "ControlLeft",
  });
  fireEvent.keyDown(prompt, { key: ".", code: "Period" });
}

function runCloseTabFromLauncher() {
  const search = screen.getByRole("combobox", {
    name: "Search commands",
  });
  fireEvent.change(search, {
    target: { value: "Close conversation tab" },
  });
  fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
}

function makeConversation(
  id: string,
  o: Partial<PublicConversationState> = {},
): PublicConversationState {
  return {
    redactedProfileSnapshot: null,
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
    owner: null,
    turnGeneration: 0,
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
  creationMode: "normal",
  tddEnabled: true,
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
  useToastStoreForTesting.setState({ toasts: [] });
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
  openConversations: PublicConversationState[];
}) {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  return (
    <ProjectCockpit
      conversationCreations={openConversations.map((c) => ({
        conversationId: c.id,
        creationRequestId: null,
      }))}
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

describe("project page: conversation working-set keyboard navigation", () => {
  it("activates by position and cycles with wrapping only in the conversations view", async () => {
    render(
      withHotkeys(
        <PageHarness
          openConversations={[
            makeConversation("alpha"),
            makeConversation("beta"),
            makeConversation("gamma"),
          ]}
        />,
      ),
    );
    showConversationsView();

    const alpha = await screen.findByRole("tab", { name: /alpha/ });
    const beta = screen.getByRole("tab", { name: /beta/ });
    const gamma = screen.getByRole("tab", { name: /gamma/ });
    expect(alpha).toHaveAttribute("aria-selected", "true");

    pressSequence(["g", "KeyG"], ["2", "Digit2"]);
    expect(beta).toHaveAttribute("aria-selected", "true");

    pressSequence(["g", "KeyG"], ["j", "KeyJ"]);
    expect(gamma).toHaveAttribute("aria-selected", "true");
    pressSequence(["g", "KeyG"], ["j", "KeyJ"]);
    expect(alpha).toHaveAttribute("aria-selected", "true");
    pressSequence(["g", "KeyG"], ["k", "KeyK"]);
    expect(gamma).toHaveAttribute("aria-selected", "true");

    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Project view" })).getByRole(
        "tab",
        { name: /Sessions/ },
      ),
    );
    pressSequence(["g", "KeyG"], ["1", "Digit1"]);
    showConversationsView();
    expect(screen.getByRole("tab", { name: /gamma/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches project views with V S and V C", () => {
    render(
      withHotkeys(
        <PageHarness openConversations={[makeConversation("alpha")]} />,
      ),
    );

    pressSequence(["v", "KeyV"], ["c", "KeyC"]);
    expect(
      within(screen.getByRole("tablist", { name: "Project view" })).getByRole(
        "tab",
        { name: /Conversations/ },
      ),
    ).toHaveAttribute("aria-selected", "true");

    pressSequence(["v", "KeyV"], ["s", "KeyS"]);
    expect(
      within(screen.getByRole("tablist", { name: "Project view" })).getByRole(
        "tab",
        { name: /Sessions/ },
      ),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("toggles the embedded conversations rail with B", () => {
    const { container } = render(
      withHotkeys(
        <PageHarness openConversations={[makeConversation("alpha")]} />,
      ),
    );
    showConversationsView();
    const cockpit = container.querySelector(
      "[data-rail-collapsed]",
    ) as HTMLElement;
    expect(cockpit).toHaveAttribute("data-rail-collapsed", "false");

    fireEvent.keyDown(document, { key: "b", code: "KeyB" });
    expect(cockpit).toHaveAttribute("data-rail-collapsed", "true");
  });
});

describe("project page: conversation-scoped drafts and close", () => {
  it("restores each conversation's draft when switching tabs", async () => {
    render(
      withClient(
        <PageHarness
          openConversations={[
            makeConversation("alpha"),
            makeConversation("beta"),
          ]}
        />,
      ),
    );
    showConversationsView();
    const editor = (await screen.findByTestId("prompt-input")) as HTMLElement;
    pastePlainText(editor, "alpha draft");
    expect(editor).toHaveTextContent("alpha draft");

    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    const betaEditor = await screen.findByTestId("prompt-input");
    expect(betaEditor).toHaveTextContent("");
    pastePlainText(betaEditor, "beta draft");

    fireEvent.click(screen.getByRole("tab", { name: /alpha/ }));
    expect(await screen.findByTestId("prompt-input")).toHaveTextContent(
      "alpha draft",
    );
    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    expect(await screen.findByTestId("prompt-input")).toHaveTextContent(
      "beta draft",
    );
  });

  it("asks before closing a dirty tab and keeps its draft when cancelled", async () => {
    render(
      withClient(
        <PageHarness openConversations={[makeConversation("alpha")]} />,
      ),
    );
    showConversationsView();
    pastePlainText(await screen.findByTestId("prompt-input"), "keep me");

    fireEvent.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(
      screen.getByRole("alertdialog", {
        name: "Discard draft and close tab?",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("tab", { name: /alpha/ })).toBeInTheDocument();
    expect(await screen.findByTestId("prompt-input")).toHaveTextContent(
      "keep me",
    );
  });

  it("closes the active clean tab with X and selects its previous neighbor", async () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/open") ? { ok: true } : { available: false },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    render(
      withHotkeys(
        <PageHarness
          openConversations={[
            makeConversation("alpha"),
            makeConversation("beta"),
            makeConversation("gamma"),
          ]}
        />,
      ),
    );
    showConversationsView();
    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    const editor = await screen.findByTestId("prompt-input");
    editor.focus();
    fireEvent.keyDown(editor, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(editor, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(editor, {
      key: "Control",
      code: "ControlLeft",
    });
    fireEvent.keyDown(editor, { key: "x", code: "KeyX" });

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /beta/ })).toBeNull(),
    );
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByTestId("prompt-input")).toHaveFocus(),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/proj/conversations/beta/open",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ open: false }),
      }),
    );
  });

  it("focuses the replacement prompt after launcher-invoked clean close", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/open") ? { ok: true } : { available: false },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    render(
      withHotkeyLauncher(
        <PageHarness
          openConversations={[
            makeConversation("alpha"),
            makeConversation("beta"),
          ]}
        />,
      ),
    );
    showConversationsView();
    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    openCommandLauncherFromPrompt(await screen.findByTestId("prompt-input"));
    runCloseTabFromLauncher();

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /beta/ })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("prompt-input")).toHaveFocus(),
    );
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("focuses the replacement prompt after confirming launcher-invoked dirty close", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/open") ? { ok: true } : { available: false },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    render(
      withHotkeyLauncher(
        <PageHarness
          openConversations={[
            makeConversation("alpha"),
            makeConversation("beta"),
          ]}
        />,
      ),
    );
    showConversationsView();
    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    const editor = await screen.findByTestId("prompt-input");
    pastePlainText(editor, "unsent draft");
    openCommandLauncherFromPrompt(editor);
    runCloseTabFromLauncher();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Discard draft and close",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /beta/ })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("prompt-input")).toHaveFocus(),
    );
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("restores exact ordering, focus, and draft when close persistence fails", async () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/open")) throw new Error("network unavailable");
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    render(
      withHotkeys(
        <PageHarness
          openConversations={[
            makeConversation("alpha"),
            makeConversation("beta"),
            makeConversation("gamma"),
          ]}
        />,
      ),
    );
    showConversationsView();
    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    const editor = await screen.findByTestId("prompt-input");
    pastePlainText(editor, "unsent draft");
    editor.focus();
    fireEvent.keyDown(editor, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(editor, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(editor, {
      key: "Control",
      code: "ControlLeft",
    });
    fireEvent.keyDown(editor, { key: "x", code: "KeyX" });
    fireEvent.click(
      screen.getByRole("button", { name: "Discard draft and close" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /beta/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    const tabs = screen.getAllByRole("tab", {
      name: /alpha|beta|gamma/,
    });
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expect.stringContaining("alpha"),
      expect.stringContaining("beta"),
      expect.stringContaining("gamma"),
    ]);
    const restoredEditor = await screen.findByTestId("prompt-input");
    expect(restoredEditor).toHaveTextContent("unsent draft");
    await waitFor(() => expect(restoredEditor).toHaveFocus());
    expect(useToastStoreForTesting.getState().toasts.at(-1)?.message).toBe(
      "Couldn’t close conversation. The tab and draft were restored.",
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
      conversationCreations: [
        { conversationId: conv.id, creationRequestId: null },
      ],
      sessions: [runningSession],
      archivedCount: 0,
      tokens: [],
      onTokensChange: vi.fn(),
      onRunCommand: vi.fn(),
      selectedBackend: backend,
      onSelectedBackendChange,
      backendDefaults: BACKEND_DEFAULTS,
      rail: <div data-testid="rail-stub" />,
    });
    const { rerender } = render(
      withClient(<ProjectCockpit {...props("claude")} />),
    );
    showConversationsView();
    // Pre-init: the backend toggle is interactive, not the locked badge.
    // The transcript region also carries data-backend, so target the toggle's
    // BUTTON specifically.
    expect(document.querySelector(".backend-toggle-badge")).toBeNull();
    const codexBtn = document.querySelector('button[data-backend="codex"]');
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn!);
    expect(onSelectedBackendChange).toHaveBeenCalledWith("codex");

    // A conversation surface offers every registered conversation backend —
    // including one the facet-gated task/workflow/collaboration pickers refuse
    // (spec R15.1).
    const cursorBtn = document.querySelector('button[data-backend="cursor"]');
    if (!(cursorBtn instanceof HTMLButtonElement)) {
      throw new Error("no cursor backend toggle button");
    }
    expect(cursorBtn.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(cursorBtn);
    expect(onSelectedBackendChange).toHaveBeenCalledWith("cursor");

    // When the page reflects the new selection, the composer recolors to Codex
    // (the composer value tracks the pre-init selection, not the conv's backend).
    rerender(withClient(<ProjectCockpit {...props("codex")} />));
    expect(
      document.querySelector('button[data-backend="codex"]')?.className,
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
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
      {
        role: "assistant",
        content: [],
        timestamp: "2026-01-01T00:00:01Z",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
      {
        role: "user",
        content: [],
        timestamp: "2026-01-01T00:00:02Z",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
      {
        role: "assistant",
        content: [],
        timestamp: "2026-01-01T00:00:03Z",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
    ];

    expect(selectLastUserTurnAgentSettings(messages)).toEqual({
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    });
  });

  it("restores the active Codex conversation's speed from its last user turn", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    seedModelOptions(client, "proj");
    const conversation = makeConversation("c1", {
      agentBackend: "codex",
      promptCount: 2,
    });
    client.setQueryData(
      projectConversationKeys.messages("proj", conversation.id),
      [
        {
          role: "user",
          content: [],
          timestamp: "2026-01-01T00:00:00Z",
          modelSelection: {
            modelId: "gpt-5.6-sol",
            parameters: { reasoning: "ultra", fast: "false" },
          },
        },
      ] satisfies TranscriptMessage[],
    );

    render(
      <QueryClientProvider client={client}>
        <ProjectCockpit
          projectName="proj"
          openConversations={[conversation]}
          conversationCreations={[
            { conversationId: conversation.id, creationRequestId: null },
          ]}
          sessions={[runningSession]}
          archivedCount={0}
          tokens={[]}
          onTokensChange={vi.fn()}
          onRunCommand={vi.fn()}
          selectedBackend="codex"
          onSelectedBackendChange={vi.fn()}
          backendDefaults={BACKEND_DEFAULTS}
          rail={<div data-testid="rail-stub" />}
        />
      </QueryClientProvider>,
    );
    showConversationsView();

    fireEvent.click(screen.getByRole("button", { name: "Model options" }));
    expect(screen.getByRole("switch", { name: "Fast mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
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
        modelSelection: {
          modelId: "claude-sonnet-4-5-20250929",
          parameters: { effort: "high" },
        },
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
        modelSelection: {
          modelId: "claude-sonnet-4-5-20250929",
          parameters: { effort: "high" },
        },
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
