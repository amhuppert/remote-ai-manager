// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ConversationTabs, { type ConversationTabItem } from "./ConversationTabs";

const tabs: ConversationTabItem[] = [
  { id: "a", name: "Alpha", unread: false, agent: "claude", status: "running" },
  { id: "b", name: "Beta", unread: true, agent: "claude", status: "new" },
  { id: "c", name: "Gamma", unread: true, agent: "codex", status: "awaiting" },
];

afterEach(cleanup);

describe("ConversationTabs", () => {
  it("marks the active tab and renders one tab per open conversation", () => {
    render(
      <ConversationTabs
        tabs={tabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    expect(alpha).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("shows an unread dot only on non-active unread tabs", () => {
    render(
      <ConversationTabs
        tabs={tabs}
        activeTabId="c"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    // Beta is non-active + unread → dot; Gamma is active → no dot even though unread.
    const beta = screen.getByRole("tab", { name: /Beta/ });
    const gamma = screen.getByRole("tab", { name: /Gamma/ });
    expect(beta.querySelector(".plc-tab-unread")).not.toBeNull();
    expect(gamma.querySelector(".plc-tab-unread")).toBeNull();
  });

  it("renders a per-tab status indicator reflecting the turn status", () => {
    render(
      <ConversationTabs
        tabs={tabs}
        activeTabId="b"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    // Running tab → cyan status dot; awaiting tab → amber; 'new' tab → none.
    const alpha = screen.getByRole("tab", { name: /Alpha/ }); // running
    const beta = screen.getByRole("tab", { name: /Beta/ }); // new
    const gamma = screen.getByRole("tab", { name: /Gamma/ }); // awaiting
    expect(alpha.querySelector(".status-dot.cyan")).not.toBeNull();
    expect(gamma.querySelector(".status-dot.amber")).not.toBeNull();
    expect(beta.querySelector(".status-dot")).toBeNull();
  });

  it("selects a tab on click", () => {
    const onSelect = vi.fn();
    render(
      <ConversationTabs
        tabs={tabs}
        activeTabId="a"
        onSelect={onSelect}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Beta/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("closes a tab without selecting it", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <ConversationTabs
        tabs={tabs}
        activeTabId="a"
        onSelect={onSelect}
        onClose={onClose}
        onNewChat={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Beta" }));
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("creates a new chat via the + New chat affordance", () => {
    const onNewChat = vi.fn();
    render(
      <ConversationTabs
        tabs={tabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});
