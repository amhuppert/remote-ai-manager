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

describe("ProjectCard", () => {
  // =========================================================================
  // 6.3 – ProjectCard (Req 1.2–1.4)
  // =========================================================================

  it("displays project name, path, and session count (Req 1.2)", () => {
    render(
      <ProjectCard
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

  it("shows active badge when sessions exist (Req 1.4)", () => {
    const { container } = render(
      <ProjectCard
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
    expect(badge?.textContent).toContain("2 active");
  });

  it("shows idle badge when no sessions (Req 1.4)", () => {
    const { container } = render(
      <ProjectCard
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
});
