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

  it("renders the project and session breadcrumbs as switcher triggers with decoded labels", () => {
    renderWithQuery(
      <LoadingSessionView
        projectName="my-proj"
        sessionName="sess-1"
        decodedProjectName="my proj"
      />,
    );
    // The flagged segments upgrade to dropdown switchers (navigation happens
    // on selection — encoding is covered by NavSwitchers.test.tsx); the root
    // stays a plain link.
    expect(screen.getByRole("button", { name: "my proj" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sess-1" })).toBeInTheDocument();
    expect(
      screen.getByText("projects").closest("a")?.getAttribute("href"),
    ).toBe("/projects");
  });
});
