// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ProjectCard from "./ProjectCard";

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

const defaultProps = {
  archived: false,
  finished: false,
  pinned: false,
  menuOpen: false,
  onMenuToggle: vi.fn(),

  onArchive: vi.fn(),
  onPin: vi.fn(),
};

describe("ProjectCard", () => {
  // =========================================================================
  // 6.3 – ProjectCard (Req 1.2–1.4)
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
    expect(screen.getByText("my-project")).toBeDefined();
    expect(screen.getByText("/home/user/projects/my-project")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
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

  it("shows active badge when a session is running (Req 1.4)", () => {
    const { container } = render(
      <ProjectCard
        {...defaultProps}
        project={{
          name: "proj",
          path: "/path",
          activeSessions: 2,
          hasRunningSession: true,
        }}
      />,
    );
    const badge = container.querySelector(".project-badge");
    expect(badge?.className).toContain("active");
    expect(badge?.textContent).toBe("running");
  });

  it("shows has-sessions badge when sessions exist but none running (Req 1.4)", () => {
    const { container } = render(
      <ProjectCard
        {...defaultProps}
        project={{
          name: "proj",
          path: "/path",
          activeSessions: 2,
          hasRunningSession: false,
        }}
      />,
    );
    const badge = container.querySelector(".project-badge");
    expect(badge?.className).toContain("has-sessions");
    expect(badge?.textContent).toBe("2 sessions");
  });

  it("shows singular session text for 1 session", () => {
    const { container } = render(
      <ProjectCard
        {...defaultProps}
        project={{
          name: "proj",
          path: "/path",
          activeSessions: 1,
          hasRunningSession: false,
        }}
      />,
    );
    const badge = container.querySelector(".project-badge");
    expect(badge?.className).toContain("has-sessions");
    expect(badge?.textContent).toBe("1 session");
  });

  it("shows idle badge when no sessions (Req 1.4)", () => {
    const { container } = render(
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
    const badge = container.querySelector(".project-badge");
    expect(badge?.className).toContain("idle");
    expect(badge?.textContent).toBe("idle");
  });

  it("shows archived badge and dashed border when archived (Req 11.6)", () => {
    const { container } = render(
      <ProjectCard
        {...defaultProps}
        archived={true}
        project={{
          name: "proj",
          path: "/path",
          activeSessions: 0,
          hasRunningSession: false,
        }}
      />,
    );
    const card = container.querySelector(".project-card");
    expect(card?.className).toContain("archived");
    const badge = container.querySelector(".project-badge");
    expect(badge?.textContent).toBe("archived");
  });

  it("renders context menu trigger button (Req 12.1)", () => {
    const { container } = render(
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
    const menuBtn = container.querySelector(".card-menu-btn");
    expect(menuBtn).toBeDefined();
  });
});
