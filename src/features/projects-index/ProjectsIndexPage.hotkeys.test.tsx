// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { projectKeys } from "@/lib/projects/query-keys";
import { configKeys } from "@/lib/config/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { notificationKeys } from "@/lib/notifications/query-keys";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import ProjectsIndexPage from "./ProjectsIndexPage";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);

describe("ProjectsIndexPage hotkeys", () => {
  it("focuses and selects project search with /", () => {
    const client = createTestQueryClient();
    client.setQueryData(projectKeys.list(), [
      {
        name: "command-center",
        path: "/repos/command-center",
        activeSessions: 1,
        hasRunningSession: false,
      },
    ]);
    client.setQueryData(projectKeys.preferences(), {
      archived: [],
      pinned: [],
    });
    client.setQueryData(configKeys.all, { baseDir: "/repos" });
    client.setQueryData(conversationKeys.active(), {
      conversations: [],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
      specExecutions: [],
    });
    client.setQueryData(notificationKeys.list(), {
      notifications: [],
      total: 0,
      unreadCount: 0,
    });

    renderWithQuery(
      <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
        <ProjectsIndexPage />
      </HotkeyProvider>,
      client,
    );
    const search = screen.getByRole("searchbox", {
      name: "Search projects",
    });
    fireEvent.change(search, { target: { value: "command" } });
    search.blur();

    fireEvent.keyDown(document, { key: "/", code: "Slash" });

    expect(search).toHaveFocus();
    expect((search as HTMLInputElement).selectionStart).toBe(0);
    expect((search as HTMLInputElement).selectionEnd).toBe(7);
  });
});
