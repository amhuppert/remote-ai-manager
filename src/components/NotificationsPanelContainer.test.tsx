// @vitest-environment jsdom

import { render, screen, fireEvent } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import NotificationsPanel from "./NotificationsPanel";
import { mapActiveConversationsToNotifications } from "./NotificationsPanelContainer";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function makeSessionConversation(
  overrides: Partial<Extract<ActiveConversation, { scope: "session" }>> = {},
): Extract<ActiveConversation, { scope: "session" }> {
  return {
    scope: "session",
    id: "session-convo-1",
    name: "Session rollout",
    status: "running",
    lastActivityAt: "2026-01-01T12:00:00.000Z",
    projectName: "app",
    projectPath: "/repos/app",
    sessionName: "feature-session",
    branchName: "csm/feature-session",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repos/app/.worktrees/feature-session",
    lastActivitySummary: null,
    unread: false,
    ...overrides,
  };
}

function makeProjectConversation(
  overrides: Partial<Extract<ActiveConversation, { scope: "project" }>> = {},
): Extract<ActiveConversation, { scope: "project" }> {
  return {
    scope: "project",
    id: "project-convo-1",
    name: "Project triage",
    status: "awaiting",
    lastActivityAt: "2026-01-01T12:05:00.000Z",
    projectName: "app",
    projectPath: "/repos/app",
    agentBackend: "codex",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repos/app",
    lastActivitySummary: null,
    unread: true,
    ...overrides,
  };
}

describe("mapActiveConversationsToNotifications", () => {
  it("maps project rows with main context, focus href, backend, unread state, and timestamp while preserving session rows", () => {
    const items = mapActiveConversationsToNotifications([
      makeSessionConversation(),
      makeProjectConversation(),
    ]);

    expect(items).toEqual([
      {
        type: "conversation",
        scope: "session",
        id: "session-convo-1",
        timestamp: "2026-01-01T12:00:00.000Z",
        projectName: "app",
        sessionName: "feature-session",
        name: "Session rollout",
        status: "running",
        backend: "claude",
        read: true,
      },
      {
        type: "conversation",
        scope: "project",
        id: "project-convo-1",
        timestamp: "2026-01-01T12:05:00.000Z",
        projectName: "app",
        contextLabel: "main",
        href: "/projects/app?focus=project-convo-1",
        name: "Project triage",
        status: "awaiting",
        backend: "codex",
        read: false,
      },
    ]);
  });
});

describe("NotificationsPanel project conversation rows", () => {
  it("renders project context and backend, links to project focus, and closes after navigation", () => {
    const onClose = vi.fn();

    render(
      <NotificationsPanel
        open={true}
        onClose={onClose}
        items={[
          {
            type: "conversation",
            scope: "project",
            id: "project-convo-1",
            timestamp: "2026-01-01T12:05:00.000Z",
            projectName: "app",
            contextLabel: "main",
            href: "/projects/app?focus=project-convo-1",
            name: "Project triage",
            status: "awaiting",
            backend: "codex",
            read: false,
          },
        ]}
      />,
    );

    const row = screen.getByRole("link", { name: /Project triage/i });
    expect(row).toHaveAttribute("href", "/projects/app?focus=project-convo-1");
    expect(row).not.toHaveAttribute(
      "href",
      "/projects/app/main/project-convo-1",
    );
    expect(screen.getByText("app / main")).toBeInTheDocument();
    expect(screen.getByLabelText("agent: codex")).toBeInTheDocument();
    expect(row.querySelector(".np-unread-dot")).not.toBeNull();

    row.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(row);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
