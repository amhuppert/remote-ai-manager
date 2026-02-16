// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ProjectsGridClient from "./ProjectsGridClient";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

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

const projects = [
  {
    name: "alpha",
    path: "/projects/alpha",
    activeSessions: 2,
    hasRunningSession: true,
  },
  {
    name: "beta",
    path: "/projects/beta",
    activeSessions: 0,
    hasRunningSession: false,
  },
  {
    name: "gamma",
    path: "/projects/gamma",
    activeSessions: 1,
    hasRunningSession: true,
  },
  {
    name: "delta",
    path: "/projects/delta",
    activeSessions: 0,
    hasRunningSession: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProjectsGridClient", () => {
  it("renders all non-archived projects by default", () => {
    render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.getByText("gamma")).toBeDefined();
    expect(screen.getByText("delta")).toBeDefined();
  });

  it("search filters projects by name case-insensitively (Req 9.2)", () => {
    render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "alph" } });

    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.queryByText("gamma")).toBeNull();
  });

  it("search is case-insensitive", () => {
    render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "BETA" } });

    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("shows no-results state when nothing matches (Req 9.5)", () => {
    render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(screen.getByText("No projects match")).toBeDefined();
  });

  it("status filter shows only active projects (Req 10.3)", () => {
    const { container } = render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    const activePill = container.querySelectorAll(".filter-pill")[1]!;
    fireEvent.click(activePill);

    // alpha and gamma are active (hasRunningSession = true)
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("gamma")).toBeDefined();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.queryByText("delta")).toBeNull();
  });

  it("status filter shows only idle projects", () => {
    const { container } = render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    const idlePill = container.querySelectorAll(".filter-pill")[2]!;
    fireEvent.click(idlePill);

    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.getByText("delta")).toBeDefined();
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("gamma")).toBeNull();
  });

  it("hides archived projects by default (Req 11.2)", () => {
    render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={["/projects/beta"]}
      />,
    );
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("shows archived projects when toggle enabled (Req 11.4)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={["/projects/beta"]}
      />,
    );
    const toggle = container.querySelector(".archive-toggle")!;
    fireEvent.click(toggle);

    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();
  });

  it("filter counts exclude archived projects (Req 10.4)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={["/projects/beta"]}
      />,
    );
    const pills = container.querySelectorAll(".filter-pill");
    const allCount = pills[0]!.querySelector(".filter-pill-count")!.textContent;
    // beta is archived, so only 3 non-archived
    expect(allCount).toBe("3");
  });

  it("combines search + status filter (Req 10.7)", () => {
    const { container } = render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    // Set status to "active"
    const activePill = container.querySelectorAll(".filter-pill")[1]!;
    fireEvent.click(activePill);

    // Then search for "a" — should match "alpha" (active) and "gamma" (active)
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "a" } });

    // "alpha" matches search + active, "gamma" matches active but has 'a' in name
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("gamma")).toBeDefined();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.queryByText("delta")).toBeNull();
  });

  it("archive toggle shows count of archived projects", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={["/projects/beta", "/projects/delta"]}
      />,
    );
    const toggle = container.querySelector(".archive-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain("2");
  });

  it("does not show archive toggle when no projects are archived", () => {
    const { container } = render(
      <ProjectsGridClient projects={projects} archivedPaths={[]} />,
    );
    const toggle = container.querySelector(".archive-toggle");
    expect(toggle).toBeNull();
  });
});
