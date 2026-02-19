// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SessionDetailPage from "./SessionDetailPage";
import type { SessionState, SessionDiff, TranscriptMessage } from "@/types";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock next/navigation
const routerRefreshMock = vi.fn();
const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
    push: routerPushMock,
  }),
}));

// Mock MarkdownContent to avoid pulling in react-markdown in tests
vi.mock("@/components/MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

// Mock IntersectionObserver
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
  // Mock scrollIntoView (not available in jsdom)
  Element.prototype.scrollIntoView = vi.fn();
  // Mock localStorage
  const storage: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => {
      storage[key] = val;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  });
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const baseSession: SessionState = {
  sessionName: "test-session",
  worktreePath: "/projects/repo/.worktrees/test-session",
  branchName: "csm/test-session",
  createdAt: "2024-06-15T10:00:00Z",
  lastActivityAt: "2024-06-15T12:00:00Z",
  archived: false,
  finished: false,
  conversations: [{
    id: "conv-1",
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready",

    promptCount: 5,
    createdAt: "2024-06-15T10:00:00Z",
    lastActivityAt: "2024-06-15T12:00:00Z",
    source: "csm",
    summary: null,
    archived: false,
  }],
};

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

const sampleMessages: TranscriptMessage[] = [
  { role: "user", content: "Hello Claude", timestamp: "2024-06-15T10:01:00Z" },
  {
    role: "assistant",
    content: "Hello! How can I help?",
    timestamp: "2024-06-15T10:01:05Z",
  },
  { role: "user", content: "Fix the bug", timestamp: "2024-06-15T10:02:00Z" },
];

// ===========================================================================
// 3.2 + 6.5 – SessionDetailPage rendering
// ===========================================================================

describe("SessionDetailPage", () => {
  it("renders user messages with role indicator (Req 6.1, 3.1)", () => {
    render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={sampleMessages}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    // User messages show "You", assistant shows "Claude"
    const roles = screen.getAllByText("You");
    expect(roles.length).toBe(2);
    const assistantRoles = screen.getAllByText("Claude");
    expect(assistantRoles.length).toBeGreaterThanOrEqual(1);
  });

  it("renders message content text (Req 6.1)", () => {
    render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={sampleMessages}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    expect(screen.getByText("Hello Claude")).toBeDefined();
    expect(screen.getByText("Hello! How can I help?")).toBeDefined();
    expect(screen.getByText("Fix the bug")).toBeDefined();
  });

  it("renders empty state when no messages (Req 6.2)", () => {
    render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    expect(screen.getByText("No messages yet")).toBeDefined();
    expect(
      screen.getByText("Send a prompt to start the conversation."),
    ).toBeDefined();
  });

  it("displays session info strip with branch, prompts, worktree (Req 3.2)", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    // Branch name
    const branchEls = container.querySelectorAll(".si-val");
    const branchTexts = Array.from(branchEls).map((el) => el.textContent);
    expect(branchTexts).toContain("csm/test-session");
    // Prompt count
    expect(branchTexts).toContain("5");
    // Worktree path
    expect(branchTexts).toContain("/projects/repo/.worktrees/test-session");
  });

  it("shows message counter with position / total (Req 6.3)", () => {
    render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={sampleMessages}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    expect(screen.getByText("1 / 3")).toBeDefined();
  });

  it("shows 0 / 0 counter when no messages", () => {
    render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    expect(screen.getByText("0 / 0")).toBeDefined();
  });

  it("disables prev button on first message and next on last (Req 6.4, 6.5)", () => {
    render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={sampleMessages}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const prevBtn = screen.getByTitle("Previous message");
    const nextBtn = screen.getByTitle("Next message");
    // At first message, prev should be disabled
    expect(prevBtn.hasAttribute("disabled")).toBe(true);
    // Next should not be disabled (not at last)
    expect(nextBtn.hasAttribute("disabled")).toBe(false);
  });

  it("shows typing indicator when session status is running (Req 4.4)", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={{
          ...baseSession,
          conversations: [{
            ...baseSession.conversations[0]!,
            status: "running",
          }],
        }}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const indicator = container.querySelector(".typing-indicator");
    expect(indicator).not.toBeNull();
    const dots = container.querySelector(".typing-dots");
    expect(dots).not.toBeNull();
    expect(dots?.querySelectorAll("span").length).toBe(3);
  });

  it("does not show typing indicator when session is idle", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={sampleMessages}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const indicator = container.querySelector(".typing-indicator");
    expect(indicator).toBeNull();
  });

  it("disables send button when prompt text is empty (Req 3.5)", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const sendBtn = container.querySelector(".send-btn");
    expect(sendBtn?.hasAttribute("disabled")).toBe(true);
  });

  it("renders LayoutSwitcher buttons (Req 3.4)", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const layoutBtns = container.querySelectorAll(".layout-btn");
    // 4 layout modes: conversation, default, split, diff
    expect(layoutBtns.length).toBe(4);
  });

  it("enables send button when prompt text is entered (Req 3.5)", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const textarea = container.querySelector(".prompt-textarea")!;
    fireEvent.change(textarea, { target: { value: "Hello" } });
    const sendBtn = container.querySelector(".send-btn");
    expect(sendBtn?.hasAttribute("disabled")).toBe(false);
  });

  it("prompt textarea accepts text input (Req 3.4)", () => {
    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );
    const textarea = container.querySelector(
      ".prompt-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });
    expect(textarea.value).toBe("Fix the bug");
  });

  it("adds optimistic user message on submit and clears input", async () => {
    // Mock fetch to delay resolution
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SessionDetailPage
        projectName="repo"
        session={baseSession}
        messages={[]}
        diff={emptyDiff}
        commits={[]}
      />,
    );

    const textarea = container.querySelector(
      ".prompt-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Test prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Input should be cleared immediately
    expect(textarea.value).toBe("");
    // Optimistic message should appear
    expect(screen.getByText("Test prompt")).toBeDefined();
  });
});
