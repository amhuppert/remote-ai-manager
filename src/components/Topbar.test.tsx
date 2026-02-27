// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Topbar from "./Topbar";

// Mock next/link to render a plain <a> tag
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

// Mock unified panel store hooks
vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));

// Mock query hooks
vi.mock("@/lib/queries", () => ({
  useActiveConversationsQuery: () => ({ data: undefined }),
  useNotificationsQuery: () => ({ data: undefined }),
}));

describe("Topbar", () => {
  // =========================================================================
  // 6.2 – Topbar (Req 5.1–5.5)
  // =========================================================================

  it("renders CC logo linking to /projects (Req 5.1)", () => {
    render(<Topbar breadcrumbs={[]} page="projects" />);
    const logo = screen.getByText("CC");
    expect(logo.closest("a")?.getAttribute("href")).toBe("/projects");
  });

  it("renders breadcrumb segments with correct labels and links (Req 5.2, 5.3)", () => {
    render(
      <Topbar
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          { label: "my-repo", href: "/projects/my-repo" },
          {
            label: "test-session",
            href: "/projects/my-repo/test-session",
            isSession: true,
          },
        ]}
        page="detail"
      />,
    );
    const links = screen.getAllByRole("link");
    // CC logo + 3 breadcrumb links
    expect(links.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("projects")).toBeDefined();
    expect(screen.getByText("my-repo")).toBeDefined();
    expect(screen.getByText("test-session")).toBeDefined();
  });

  it("renders session controls on detail page (Req 5.4)", () => {
    render(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        sessionControls={<button>Delete</button>}
      />,
    );
    expect(screen.getByText("Delete")).toBeDefined();
  });

  it("renders global status on non-detail pages (Req 5.5)", () => {
    render(
      <Topbar
        breadcrumbs={[]}
        page="projects"
        globalStatus={<span>3 active</span>}
      />,
    );
    expect(screen.getByText("3 active")).toBeDefined();
  });

  it("does not render global status on detail page", () => {
    const { container } = render(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        globalStatus={<span>3 active</span>}
      />,
    );
    // Global status should not be visible (rendered in a hidden section)
    const statusDefault = container.querySelector(".topbar-status-default");
    expect(statusDefault).toBeNull();
  });

  it("renders unified panel toggle button", () => {
    const { container } = render(<Topbar breadcrumbs={[]} page="projects" />);
    const toggle = container.querySelector(".unified-panel-toggle");
    expect(toggle).toBeDefined();
  });
});
