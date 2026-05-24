// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import LoadingSessionView from "@/features/session/conversation/LoadingSessionView";

// Topbar pulls in next/link, next/navigation, and query hooks.
// These are infrastructure boundaries — mirror the Topbar.test.tsx pattern.
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);
vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));
vi.mock("@/lib/notifications/queries", () => ({
  useNotificationsQuery: () => ({ data: undefined }),
}));
vi.mock("@/stores/notification.store", () => ({
  useActiveJobs: () => [],
}));

describe("LoadingSessionView", () => {
  it("renders the loading empty state", () => {
    renderWithQuery(
      <LoadingSessionView
        projectName="my-proj"
        sessionName="sess-1"
        decodedProjectName="my proj"
      />,
    );
    expect(screen.getByText("Loading session...")).toBeInTheDocument();
  });

  it("renders breadcrumbs with projects, decoded project name, and session name", () => {
    renderWithQuery(
      <LoadingSessionView
        projectName="my-proj"
        sessionName="sess-1"
        decodedProjectName="my proj"
      />,
    );
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("my proj")).toBeInTheDocument();
    expect(screen.getByText("sess-1")).toBeInTheDocument();
  });

  it("URL-encodes the project name in the breadcrumb href but shows the decoded label", () => {
    renderWithQuery(
      <LoadingSessionView
        projectName="my-proj"
        sessionName="sess-1"
        decodedProjectName="my proj"
      />,
    );
    const decodedLink = screen.getByText("my proj").closest("a");
    expect(decodedLink?.getAttribute("href")).toBe("/projects/my-proj");

    const sessionLink = screen.getByText("sess-1").closest("a");
    expect(sessionLink?.getAttribute("href")).toBe("/projects/my-proj/sess-1");
  });
});
