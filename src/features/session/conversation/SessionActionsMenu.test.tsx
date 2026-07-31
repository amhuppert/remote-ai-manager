// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SessionActionsMenu from "./SessionActionsMenu";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function defaultLayoutProps() {
  return {
    activeLayout: "split" as const,
    onLayoutChange: vi.fn(),
  };
}

describe("SessionActionsMenu", () => {
  it("does not render Commit or Merge actions but keeps Delete", async () => {
    const user = userEvent.setup();
    render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /actions/i }));

    expect(
      screen.queryByRole("menuitem", { name: /commit changes/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /merge into/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /delete session/i }),
    ).toBeInTheDocument();
  });

  it("invokes onDelete when the delete item is picked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("disables Push and Rebase when no handler is provided", async () => {
    const user = userEvent.setup();
    render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /actions/i }));
    expect(
      screen.getByRole("menuitem", { name: /push branch/i }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: /rebase on main/i }),
    ).toHaveAttribute("data-disabled");
  });

  it("invokes onRebase when the rebase item is picked", async () => {
    const user = userEvent.setup();
    const onRebase = vi.fn();
    render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={vi.fn()}
        onRebase={onRebase}
      />,
    );

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /rebase on main/i }));

    expect(onRebase).toHaveBeenCalledTimes(1);
  });
});

describe("SessionActionsMenu — layout fallback", () => {
  it("keeps every layout mode reachable and marks the active mode", async () => {
    const user = userEvent.setup();
    render(
      <SessionActionsMenu
        targetBranch="main"
        onDelete={vi.fn()}
        activeLayout="conversation"
        onLayoutChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /actions/i }));

    expect(screen.getByRole("group", { name: "Layout" })).toBeInTheDocument();
    for (const name of [
      "Split 50/50",
      "Panes (split-screen)",
      "Conversation only",
      "Right panel only",
    ]) {
      expect(screen.getByRole("menuitemradio", { name })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("menuitemradio", { name: "Conversation only" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("changes layout from the fallback menu", async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    render(
      <SessionActionsMenu
        targetBranch="main"
        onDelete={vi.fn()}
        activeLayout="conversation"
        onLayoutChange={onLayoutChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "Panes (split-screen)" }),
    );

    expect(onLayoutChange).toHaveBeenCalledWith("panes");
  });
});

describe("SessionActionsMenu — compaction actions", () => {
  function renderWithCompaction(
    state: import("./compaction-chip-state").CompactionChipState,
    handlers: {
      onCompactConversation?: () => void;
      onViewArtifact?: () => void;
      onRefreshArtifact?: () => void;
      onCopyReference?: () => void;
    } = {},
  ) {
    return render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={vi.fn()}
        compaction={state}
        onCompactConversation={handlers.onCompactConversation ?? vi.fn()}
        onViewArtifact={handlers.onViewArtifact ?? vi.fn()}
        onRefreshArtifact={handlers.onRefreshArtifact ?? vi.fn()}
        onCopyReference={handlers.onCopyReference ?? vi.fn()}
      />,
    );
  }

  async function openMenu() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /actions/i }));
    return user;
  }

  it("hides every compaction item when no compaction state is provided", async () => {
    render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={vi.fn()}
      />,
    );
    await openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /compact conversation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /copy reference/i }),
    ).not.toBeInTheDocument();
  });

  it("none: offers Compact conversation and Copy reference, no view/refresh", async () => {
    renderWithCompaction({ kind: "none" });
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /compact conversation/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /copy reference/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /view context artifact/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /refresh context artifact/i }),
    ).not.toBeInTheDocument();
  });

  it("none: Compact conversation invokes the handler", async () => {
    const onCompactConversation = vi.fn();
    renderWithCompaction({ kind: "none" }, { onCompactConversation });
    const user = await openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: /compact conversation/i }),
    );
    expect(onCompactConversation).toHaveBeenCalledTimes(1);
  });

  it("pending: shows a disabled Compacting… item instead of Compact", async () => {
    renderWithCompaction({ kind: "pending" });
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /compacting…/i }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.queryByRole("menuitem", { name: /compact conversation/i }),
    ).not.toBeInTheDocument();
  });

  it("fresh: offers View context artifact but not Refresh", async () => {
    const onViewArtifact = vi.fn();
    renderWithCompaction({ kind: "fresh" }, { onViewArtifact });
    const user = await openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /refresh context artifact/i }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: /view context artifact/i }),
    );
    expect(onViewArtifact).toHaveBeenCalledTimes(1);
  });

  it("stale: offers View and Refresh with the behind count", async () => {
    const onRefreshArtifact = vi.fn();
    renderWithCompaction({ kind: "stale", behind: 5 }, { onRefreshArtifact });
    const user = await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /view context artifact/i }),
    ).toBeInTheDocument();
    const refresh = screen.getByRole("menuitem", {
      name: /refresh context artifact/i,
    });
    expect(refresh.textContent).toMatch(/behind 5/i);
    await user.click(refresh);
    expect(onRefreshArtifact).toHaveBeenCalledTimes(1);
  });

  it("outdated: offers View and Refresh", async () => {
    renderWithCompaction({ kind: "outdated" });
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /view context artifact/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /refresh context artifact/i }),
    ).toBeInTheDocument();
  });

  it("failed: offers Compact conversation (retry) and View", async () => {
    renderWithCompaction({ kind: "failed" });
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /compact conversation/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /view context artifact/i }),
    ).toBeInTheDocument();
  });

  it("Copy reference invokes the handler", async () => {
    const onCopyReference = vi.fn();
    renderWithCompaction({ kind: "fresh" }, { onCopyReference });
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /copy reference/i }));
    expect(onCopyReference).toHaveBeenCalledTimes(1);
  });
});
