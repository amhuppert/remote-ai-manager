// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ProjectCard from "./ProjectCard";

// Shared mocks
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const defaultProps = {
  archived: false,
  finished: false,
  pinned: false,
  menuOpen: false,
  onMenuOpenChange: vi.fn(),
  onArchive: vi.fn(),
  onPin: vi.fn(),
  onDelete: vi.fn(),
};

describe("ProjectCard", () => {
  // =========================================================================
  // 6.3 – ProjectCard (Req 1.2–1.4)
  //
  // Behavioral coverage only. The Tailwind migration deleted the legacy
  // `.project-card` / `.cc-badge` class-structure assertions per requirement
  // 5.1; per-state badge appearance is now exercised by the parity stories
  // (ProjectCard.stories.tsx / ProjectCard.stories.test.tsx).
  // =========================================================================

  it("displays project name, path, and session count (Req 1.2)", () => {
    render(
      <ProjectCard
        {...defaultProps}
        project={{
          name: "my-project",
          path: "/home/user/projects/my-project",
          activeSessions: 3,
          hasRunningSession: false,
        }}
      />,
    );
    expect(screen.getByText("my-project")).toBeInTheDocument();
    expect(
      screen.getByText("/home/user/projects/my-project"),
    ).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("links to /projects/[name] (Req 1.3)", () => {
    const { container } = render(
      <ProjectCard
        {...defaultProps}
        project={{
          name: "my-project",
          path: "/path",
          activeSessions: 0,
          hasRunningSession: false,
        }}
      />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/projects/my-project");
  });

  it("renders context menu trigger button (Req 12.1)", () => {
    render(
      <ProjectCard
        {...defaultProps}
        project={{
          name: "proj",
          path: "/path",
          activeSessions: 0,
          hasRunningSession: false,
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Project actions" }),
    ).toBeInTheDocument();
  });
});
