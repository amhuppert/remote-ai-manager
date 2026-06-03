// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import UnifiedComposer, { type UnifiedComposerProps } from "./UnifiedComposer";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";

function makeConversation(
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "plc-1",
    scope: "project",
    name: "chat",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
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
  sessionName: "s1",
  worktreePath: "/tmp/s1",
  branchName: "csm/s1",
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

function renderComposer(overrides: Partial<UnifiedComposerProps> = {}) {
  const props: UnifiedComposerProps = {
    projectName: "proj",
    activeConversationId: "plc-1",
    activeConversation: makeConversation(),
    agentBackend: "claude",
    onAgentChange: vi.fn(),
    tokens: [],
    onTokensChange: vi.fn(),
    sessions: [runningSession],
    archivedCount: 0,
    onSendPrompt: vi.fn(),
    onRunCommand: vi.fn(),
    busy: false,
    ...overrides,
  };
  render(<UnifiedComposer {...props} />);
  return props;
}

function field(): HTMLTextAreaElement {
  return screen.getByLabelText("Project composer") as HTMLTextAreaElement;
}

beforeEach(() => {
  // useVoiceRecorder pings /api/voice/health on mount.
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

describe("UnifiedComposer mode routing", () => {
  it("chat: Enter sends the prompt to the active conversation", () => {
    const props = renderComposer();
    const ta = field();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "fix the bug" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(props.onSendPrompt).toHaveBeenCalledTimes(1);
    expect(props.onSendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "fix the bug", backend: "claude" }),
    );
  });

  it("chat: Shift+Enter does not send (inserts a newline)", () => {
    const props = renderComposer();
    const ta = field();
    fireEvent.change(ta, { target: { value: "line one" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(props.onSendPrompt).not.toHaveBeenCalled();
  });

  it("command: Enter runs the highlighted command and clears the field", () => {
    const props = renderComposer();
    const ta = field();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "/" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(props.onRunCommand).toHaveBeenCalledWith("new");
    expect(props.onSendPrompt).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });

  it("filter: applying a suggestion adds a token via onTokensChange", () => {
    const props = renderComposer();
    const ta = field();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "is:running" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(props.onTokensChange).toHaveBeenCalledTimes(1);
    const next = (props.onTokensChange as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(next.some((t: { cat: string }) => t.cat === "status")).toBe(true);
    expect(props.onSendPrompt).not.toHaveBeenCalled();
  });
});

describe("UnifiedComposer mode chip", () => {
  it("shows the chat chip with the agent name for prose", () => {
    renderComposer();
    fireEvent.change(field(), { target: { value: "hello" } });
    expect(screen.getByLabelText("Chat mode — Claude")).toBeInTheDocument();
  });

  it("shows the command chip for a leading slash", () => {
    renderComposer();
    fireEvent.change(field(), { target: { value: "/cap" } });
    expect(screen.getByLabelText("Command mode")).toBeInTheDocument();
  });

  it("shows the filter chip for a key:value", () => {
    renderComposer();
    fireEvent.change(field(), { target: { value: "is:" } });
    expect(screen.getByLabelText("Filter mode")).toBeInTheDocument();
  });
});

describe("UnifiedComposer field recolor", () => {
  it("exposes data-focused/data-mode/data-agent on the field root so the field recolors", () => {
    renderComposer({ agentBackend: "codex" });
    const root = document.querySelector(".plc-uc")!;
    // Unfocused initially.
    expect(root.getAttribute("data-focused")).toBe("false");
    const ta = field();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(root.getAttribute("data-focused")).toBe("true");
    expect(root.getAttribute("data-mode")).toBe("chat");
    expect(root.getAttribute("data-agent")).toBe("codex");
    // Command mode recolors via data-mode.
    fireEvent.change(ta, { target: { value: "/new" } });
    expect(root.getAttribute("data-mode")).toBe("command");
    // Filter mode recolors via data-mode.
    fireEvent.change(ta, { target: { value: "is:" } });
    expect(root.getAttribute("data-mode")).toBe("filter");
  });
});

describe("UnifiedComposer backend lock", () => {
  it("allows selecting the backend before the conversation is initialized", () => {
    const props = renderComposer({
      activeConversation: makeConversation({ promptCount: 0 }),
    });
    const codexBtn = document.querySelector('[data-backend="codex"]');
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn!);
    expect(props.onAgentChange).toHaveBeenCalledWith("codex");
  });

  it("presents the backend as fixed once the conversation is initialized", () => {
    renderComposer({
      activeConversation: makeConversation({ promptCount: 3 }),
    });
    expect(document.querySelector(".backend-toggle-badge")).not.toBeNull();
    expect(document.querySelector('[data-backend="codex"]')).toBeNull();
  });
});
