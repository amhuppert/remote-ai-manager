// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SessionsList from "./SessionsList";
import type { SessionState } from "@/types";

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

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn();
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const makeSessions = (count: number): SessionState[] =>
  Array.from({ length: count }, (_, i) => ({
    sessionName: `session-${i + 1}`,
    worktreePath: `/project/.worktrees/session-${i + 1}`,
    branchName: `csm/session-${i + 1}`,
    claudeSessionId: null,
    transcriptPath: null,
    status: i === 0 ? ("running" as const) : ("ready" as const),
    createdAt: now,
    lastActivityAt: now,
    promptCount: i * 3,
    archived: false,
  }));

// ===========================================================================
// 6.4 – SessionsList (Req 2.1–2.5, 3.1, 3.3)
// ===========================================================================

describe("SessionsList", () => {
  it("renders table with session rows (Req 2.1, 2.2)", () => {
    const sessions = makeSessions(3);
    render(
      <SessionsList projectName="my-project" initialSessions={sessions} />,
    );
    expect(screen.getByText("session-1")).toBeDefined();
    expect(screen.getByText("session-2")).toBeDefined();
    expect(screen.getByText("session-3")).toBeDefined();
  });

  it("renders empty state when no sessions (Req 2.5)", () => {
    render(<SessionsList projectName="my-project" initialSessions={[]} />);
    expect(screen.getByText("No sessions yet")).toBeDefined();
    expect(
      screen.getByText(
        "Create a session to start working with Claude in this project.",
      ),
    ).toBeDefined();
  });

  it("renders branch names in table (Req 2.2)", () => {
    const sessions = makeSessions(2);
    render(
      <SessionsList projectName="my-project" initialSessions={sessions} />,
    );
    expect(screen.getByText("csm/session-1")).toBeDefined();
    expect(screen.getByText("csm/session-2")).toBeDefined();
  });

  it("renders status badges (Req 2.3)", () => {
    const sessions = makeSessions(2);
    const { container } = render(
      <SessionsList projectName="my-project" initialSessions={sessions} />,
    );
    const badges = container.querySelectorAll(".session-status");
    expect(badges.length).toBe(2);
    // First session is "running", second is "ready"
    expect(badges[0]!.textContent).toContain("running");
    expect(badges[1]!.textContent).toContain("ready");
  });

  it("renders prompt counts in table (Req 2.2)", () => {
    const sessions = makeSessions(3);
    render(
      <SessionsList projectName="my-project" initialSessions={sessions} />,
    );
    // promptCount: 0, 3, 6
    expect(screen.getByText("0")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("6")).toBeDefined();
  });

  it("links session name to detail page (Req 2.4)", () => {
    const sessions = makeSessions(1);
    render(
      <SessionsList projectName="my-project" initialSessions={sessions} />,
    );
    const link = screen.getByText("session-1").closest("a");
    expect(link?.getAttribute("href")).toBe("/projects/my-project/session-1");
  });

  it("renders New Session button (Req 3.1)", () => {
    render(<SessionsList projectName="my-project" initialSessions={[]} />);
    expect(screen.getByText("New Session")).toBeDefined();
  });

  it("opens CreateSessionModal on New Session click (Req 3.1)", () => {
    render(<SessionsList projectName="my-project" initialSessions={[]} />);
    fireEvent.click(screen.getByText("New Session"));
    // Modal should now be visible — it renders "New Session" title
    expect(screen.getByText("Session Name")).toBeDefined();
  });

  it("shows delete confirmation on Delete button click (Req 3.3)", () => {
    const sessions = makeSessions(1);
    render(
      <SessionsList projectName="my-project" initialSessions={sessions} />,
    );
    fireEvent.click(screen.getByText("Delete"));
    // ConfirmDialog should appear with message
    expect(screen.getByText("Delete Session")).toBeDefined();
  });
});
