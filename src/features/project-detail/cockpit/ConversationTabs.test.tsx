// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ConversationTabs, { type ConversationTabItem } from "./ConversationTabs";

const tabs: ConversationTabItem[] = [
  { id: "a", name: "Alpha", unread: false, agent: "claude", status: "running" },
  { id: "b", name: "Beta", unread: true, agent: "claude", status: "new" },
  { id: "c", name: "Gamma", unread: true, agent: "codex", status: "awaiting" },
];

// The tab strip carries the profile companion to its `+ New chat` control, and
// that reads the library through React Query.
function renderTabs(
  props: Partial<React.ComponentProps<typeof ConversationTabs>>,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConversationTabs
        tabs={tabs}
        activeTabId="a"
        projectName="my-app"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("ConversationTabs", () => {
  it("marks the active tab and renders one tab per open conversation", () => {
    renderTabs({ tabs: tabs, activeTabId: "a" });
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    expect(alpha).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("shows an unread dot only on non-active unread tabs", () => {
    renderTabs({ tabs: tabs, activeTabId: "c" });
    // Beta is non-active + unread → dot; Gamma is active → no dot even though unread.
    const beta = screen.getByRole("tab", { name: /Beta/ });
    const gamma = screen.getByRole("tab", { name: /Gamma/ });
    expect(beta.querySelector('[aria-label="Unread activity"]')).not.toBeNull();
    expect(gamma.querySelector('[aria-label="Unread activity"]')).toBeNull();
  });

  it("renders a per-tab status indicator reflecting the turn status", () => {
    renderTabs({ tabs: tabs, activeTabId: "b" });
    // Running tab → cyan status dot; awaiting tab → amber; 'new' tab → none.
    const alpha = screen.getByRole("tab", { name: /Alpha/ }); // running
    const beta = screen.getByRole("tab", { name: /Beta/ }); // new
    const gamma = screen.getByRole("tab", { name: /Gamma/ }); // awaiting
    // The StatusDot primitive exposes its tone via `data-tone`; running → cyan,
    // awaiting → amber, and the resting 'new' status renders no dot.
    expect(alpha.querySelector('[data-tone="cyan"]')).not.toBeNull();
    expect(gamma.querySelector('[data-tone="amber"]')).not.toBeNull();
    expect(beta.querySelector("[data-tone]")).toBeNull();
  });

  it("selects a tab on click", () => {
    const onSelect = vi.fn();
    renderTabs({ tabs: tabs, activeTabId: "a", onSelect: onSelect });
    fireEvent.click(screen.getByRole("tab", { name: /Beta/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("closes a tab without selecting it", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    renderTabs({
      tabs: tabs,
      activeTabId: "a",
      onSelect: onSelect,
      onClose: onClose,
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Beta" }));
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("creates a new chat via the + New chat affordance", () => {
    const onNewChat = vi.fn();
    renderTabs({ tabs: tabs, activeTabId: "a", onNewChat: onNewChat });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  // R7.1: the project-conversation creation path offers a profile picker that
  // starts on the Standard Agent, and creating without touching it still means
  // the Standard Agent rather than an absent selection.
  it("offers a Standard-Agent-defaulted profile picker beside the New chat control", async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    renderTabs({ onNewChat });

    await user.click(
      screen.getByRole("button", { name: /choose an agent profile/i }),
    );
    expect(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");

    await user.click(
      screen.getByRole("button", { name: /create conversation/i }),
    );
    expect(onNewChat).toHaveBeenCalledWith({
      tier: "builtin",
      id: "standard-agent",
    });
  });

  it("shows a busy, disabled Creating… affordance while the create mutation is pending", () => {
    const onNewChat = vi.fn();
    renderTabs({
      tabs: tabs,
      activeTabId: "a",
      onNewChat: onNewChat,
      creating: true,
    });
    const button = screen.getByRole("button", { name: "New chat" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Creating…");
    fireEvent.click(button);
    expect(onNewChat).not.toHaveBeenCalled();
  });
});
