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
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
    );
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.getByText("gamma")).toBeDefined();
    expect(screen.getByText("delta")).toBeDefined();
  });

  it("search filters projects by name case-insensitively (Req 9.2)", () => {
    render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
    );
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "alph" } });

    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.queryByText("gamma")).toBeNull();
  });

  it("search is case-insensitive", () => {
    render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
    );
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "BETA" } });

    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("shows no-results state when nothing matches (Req 9.5)", () => {
    render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
    );
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(screen.getByText("No projects match")).toBeDefined();
  });

  it("status filter shows only active projects (Req 10.3)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
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
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
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
        pinnedPaths={[]}
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
        pinnedPaths={[]}
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
        pinnedPaths={[]}
      />,
    );
    const pills = container.querySelectorAll(".filter-pill");
    const allCount = pills[0]!.querySelector(".filter-pill-count")!.textContent;
    // beta is archived, so only 3 non-archived
    expect(allCount).toBe("3");
  });

  it("combines search + status filter (Req 10.7)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
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
        pinnedPaths={[]}
      />,
    );
    const toggle = container.querySelector(".archive-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain("2");
  });

  it("does not show archive toggle when no projects are archived", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
    );
    const toggle = container.querySelector(".archive-toggle");
    expect(toggle).toBeNull();
  });
});

describe("ProjectsGridClient — pinned section", () => {
  it("shows pinned section when projects are pinned (Req 14.1)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={["/projects/alpha"]}
      />,
    );
    const section = container.querySelector(".pinned-section");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("Pinned");
    expect(section!.textContent).toContain("alpha");
  });

  it("hides pinned section when no projects are pinned (Req 14.6)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={[]}
      />,
    );
    const section = container.querySelector(".pinned-section");
    expect(section).toBeNull();
  });

  it("pinned projects do not appear in the main grid (Req 14.5)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={["/projects/alpha"]}
      />,
    );
    // "alpha" should only appear in the pinned section, not the main grid
    const grids = container.querySelectorAll(".projects-grid");
    // First grid is inside .pinned-section, second is the main grid
    expect(grids.length).toBe(2);
    const mainGrid = grids[1]!;
    expect(mainGrid.textContent).not.toContain("alpha");
    expect(mainGrid.textContent).toContain("beta");
  });

  it("pinned section remains visible regardless of search query (Req 14.4)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={["/projects/alpha"]}
      />,
    );
    // Search for something that doesn't match "alpha"
    const input = screen.getByPlaceholderText("Search projects...");
    fireEvent.change(input, { target: { value: "delta" } });

    const section = container.querySelector(".pinned-section");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("alpha");
  });

  it("pinned section remains visible regardless of status filter (Req 14.4)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={["/projects/beta"]}
      />,
    );
    // Set filter to "active" — beta is idle, but should still show in pinned
    const activePill = container.querySelectorAll(".filter-pill")[1]!;
    fireEvent.click(activePill);

    const section = container.querySelector(".pinned-section");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("beta");
  });

  it("hides pinned section when all pinned are archived and archive toggle off (Req 14.7)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={["/projects/alpha"]}
        pinnedPaths={["/projects/alpha"]}
      />,
    );
    // alpha is both pinned and archived, archive toggle is off by default
    const section = container.querySelector(".pinned-section");
    expect(section).toBeNull();
  });

  it("shows pinned archived project when archive toggle is on", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={["/projects/alpha"]}
        pinnedPaths={["/projects/alpha"]}
      />,
    );
    // Enable archive toggle
    const toggle = container.querySelector(".archive-toggle")!;
    fireEvent.click(toggle);

    const section = container.querySelector(".pinned-section");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("alpha");
  });

  it("pin/unpin context menu item toggles based on pin state (Req 13.1, 13.4)", () => {
    const { container } = render(
      <ProjectsGridClient
        projects={projects}
        archivedPaths={[]}
        pinnedPaths={["/projects/alpha"]}
      />,
    );
    // Find menu buttons - pinned section card should have "Unpin Project"
    const menuBtns = container.querySelectorAll(".card-menu-btn");
    // Click the first menu button (alpha in pinned section)
    fireEvent.click(menuBtns[0]!);

    const dropdownItems = container.querySelectorAll(".card-dropdown-item");
    expect(dropdownItems[0]!.textContent).toBe("Unpin Project");

    // Click second menu button (beta in main grid — not pinned)
    fireEvent.click(menuBtns[1]!);
    const allDropdowns = container.querySelectorAll(
      ".card-dropdown.open .card-dropdown-item",
    );
    // The open dropdown should show "Pin Project" for non-pinned
    // Since only one menu open at a time, check all visible items
    const visibleItems = container.querySelectorAll(".card-dropdown-item");
    // beta's first item should be "Pin Project"
    const betaItems = Array.from(visibleItems).slice(2); // skip alpha's items
    expect(betaItems[0]!.textContent).toBe("Pin Project");
  });
});
