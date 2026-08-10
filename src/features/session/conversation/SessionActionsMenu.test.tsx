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

  it("binds each action item to its matching consumer callback", async () => {
    const user = userEvent.setup();
    const onPush = vi.fn();
    const onRebase = vi.fn();
    const onDelete = vi.fn();
    const onCompactConversation = vi.fn();
    const onViewArtifact = vi.fn();
    const onRefreshArtifact = vi.fn();
    const onCopyReference = vi.fn();
    const props = {
      ...defaultLayoutProps(),
      targetBranch: "main",
      onPush,
      onRebase,
      onDelete,
      onCompactConversation,
      onViewArtifact,
      onRefreshArtifact,
      onCopyReference,
    };
    const { rerender } = render(
      <SessionActionsMenu {...props} compaction={{ kind: "failed" }} />,
    );

    const selectItem = async (name: RegExp): Promise<void> => {
      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(screen.getByRole("menuitem", { name }));
    };

    for (const [name, callback] of [
      [/push branch/i, onPush],
      [/rebase on main/i, onRebase],
      [/compact conversation/i, onCompactConversation],
      [/view context artifact/i, onViewArtifact],
      [/copy reference/i, onCopyReference],
      [/delete session/i, onDelete],
    ] as const) {
      await selectItem(name);
      expect(callback).toHaveBeenCalledOnce();
    }

    rerender(
      <SessionActionsMenu
        {...props}
        compaction={{ kind: "stale", behind: 1 }}
      />,
    );
    await selectItem(/refresh context artifact/i);
    expect(onRefreshArtifact).toHaveBeenCalledOnce();
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
});

describe("SessionActionsMenu — compaction actions", () => {
  function renderWithCompaction(
    state: import("./compaction-chip-state").CompactionChipState,
  ) {
    return render(
      <SessionActionsMenu
        {...defaultLayoutProps()}
        targetBranch="main"
        onDelete={vi.fn()}
        compaction={state}
        onCompactConversation={vi.fn()}
        onViewArtifact={vi.fn()}
        onRefreshArtifact={vi.fn()}
        onCopyReference={vi.fn()}
      />,
    );
  }

  async function openMenu() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /actions/i }));
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
    renderWithCompaction({ kind: "fresh" });
    await openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /refresh context artifact/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /view context artifact/i }),
    ).toBeInTheDocument();
  });

  it("stale: offers View and Refresh with the behind count", async () => {
    renderWithCompaction({ kind: "stale", behind: 5 });
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /view context artifact/i }),
    ).toBeInTheDocument();
    const refresh = screen.getByRole("menuitem", {
      name: /refresh context artifact/i,
    });
    expect(refresh.textContent).toMatch(/behind 5/i);
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
});
