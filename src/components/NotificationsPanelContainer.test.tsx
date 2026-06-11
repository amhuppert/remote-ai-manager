// @vitest-environment jsdom

import { render, screen, fireEvent } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import NotificationsPanel from "./NotificationsPanel";
import {
  mapActiveConversationsToNotifications,
  mapPersistedNotificationsToNotifications,
} from "./NotificationsPanelContainer";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import type {
  JobNotification,
  ProjectConversationNotification,
} from "@/lib/notifications/schemas";

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
    pendingApproval: null,
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
    pendingApproval: null,
    open: overrides.open ?? true,
    ...overrides,
  };
}

function makeJobNotification(
  overrides: Partial<JobNotification> = {},
): JobNotification {
  return {
    id: "notification-1",
    source: "job",
    type: "merge-completed",
    title: "Merge completed",
    message: "Merged",
    read: false,
    projectName: "app",
    sessionName: "feature-session",
    branchName: "csm/feature-session",
    jobId: "job-1",
    jobType: "merge",
    createdAt: "2026-06-07 12:00:00",
    ...overrides,
  };
}

function makeProjectConversationNotification(
  overrides: Partial<ProjectConversationNotification> = {},
): ProjectConversationNotification {
  return {
    id: "plc-notification-1",
    source: "project-conversation",
    type: "project-conversation-ready",
    title: "Agent finished",
    message: "Project conversation is ready",
    read: false,
    projectName: "app",
    conversationId: "project-convo-1",
    conversationName: "Project triage",
    status: "awaiting",
    createdAt: "2026-06-07 12:00:00",
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

describe("mapPersistedNotificationsToNotifications", () => {
  it("maps job-variant persisted notifications for merge, commit, resolve-conflicts, ready-to-land, and discarded rows", () => {
    const items = mapPersistedNotificationsToNotifications([
      makeJobNotification({
        id: "merge",
        type: "merge-completed",
        jobType: "merge",
        mergeHash: "merge123",
      }),
      makeJobNotification({
        id: "commit",
        type: "commit-completed",
        jobType: "commit",
        commitHash: "commit123",
      }),
      makeJobNotification({
        id: "resolve",
        type: "resolve-completed",
        jobType: "resolve-conflicts",
        mergeHash: "resolve123",
      }),
      makeJobNotification({
        id: "ready",
        type: "merge-ready-to-land",
        jobType: "merge",
      }),
      makeJobNotification({
        id: "discarded",
        type: "merge-discarded",
        jobType: "merge",
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        id: "merge",
        type: "merge",
        status: "success",
        mergeHash: "merge123",
      }),
      expect.objectContaining({
        id: "commit",
        type: "commit",
        status: "success",
        commitHash: "commit123",
      }),
      expect.objectContaining({
        id: "resolve",
        type: "resolve-conflicts",
        status: "success",
        mergeHash: "resolve123",
      }),
      expect.objectContaining({
        id: "ready",
        type: "merge",
        status: "ready-to-land",
      }),
      expect.objectContaining({
        id: "discarded",
        type: "merge",
        status: "discarded",
      }),
    ]);
  });

  it("maps project-conversation notifications as persisted project conversation activity rows", () => {
    const items = mapPersistedNotificationsToNotifications([
      makeProjectConversationNotification(),
      makeProjectConversationNotification({
        id: "plc-failed",
        type: "project-conversation-failed",
        title: "Agent failed",
        message: "Project conversation failed",
        read: true,
        conversationId: "project-convo-2",
        conversationName: null,
        status: "failed",
        errorMessage: "boom",
      }),
    ]);

    expect(items).toEqual([
      {
        type: "conversation",
        scope: "project",
        id: "plc-notification-1",
        timestamp: "2026-06-07 12:00:00",
        projectName: "app",
        contextLabel: "main",
        href: "/projects/app?focus=project-convo-1",
        name: "Project triage",
        status: "awaiting",
        read: false,
        persisted: true,
      },
      {
        type: "conversation",
        scope: "project",
        id: "plc-failed",
        timestamp: "2026-06-07 12:00:00",
        projectName: "app",
        contextLabel: "main",
        href: "/projects/app?focus=project-convo-2",
        name: "project-convo-2",
        status: "failed",
        read: true,
        persisted: true,
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

  it("marks persisted project-conversation notifications read before focus navigation and supports dismiss", () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => calls.push("close"));
    const onMarkAsRead = vi.fn((id: string) => calls.push(`read:${id}`));
    const onDismiss = vi.fn();

    render(
      <NotificationsPanel
        open={true}
        onClose={onClose}
        onMarkAsRead={onMarkAsRead}
        onDismiss={onDismiss}
        items={[
          {
            type: "conversation",
            scope: "project",
            id: "plc-notification-1",
            timestamp: "2026-06-07 12:00:00",
            projectName: "app",
            contextLabel: "main",
            href: "/projects/app?focus=project-convo-1",
            name: "Project triage",
            status: "awaiting",
            read: false,
            persisted: true,
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
    row.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(row);

    expect(calls).toEqual(["read:plc-notification-1", "close"]);

    fireEvent.click(screen.getByTitle("Dismiss"));

    expect(onDismiss).toHaveBeenCalledWith("plc-notification-1");
  });
});
