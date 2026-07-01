// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import McpServerCard from "./McpServerCard";
import type { McpServerView } from "./types";

function baseServer(
  overrides: Partial<McpServerView> & { id: string },
): McpServerView {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    sourceFile: overrides.sourceFile ?? "/home/alex/.config/cc/.mcp.json",
    scope: overrides.scope ?? "global",
    enabled: overrides.enabled ?? true,
    status: overrides.status ?? { kind: "inherited", from: "session" },
    pending: overrides.pending,
    runtimeError: overrides.runtimeError,
    toolDiscovery: overrides.toolDiscovery ?? {
      kind: "loaded",
      tools: [
        {
          name: "browser_click",
          enabled: true,
          status: { kind: "inherited", from: "session" },
        },
      ],
    },
  };
}

describe("McpServerCard — tool toggles", () => {
  it("keeps the per-tool toggle interactive on an inherited-but-enabled server row so auto-promotion can fire", () => {
    const onToggleTool = vi.fn();
    const server = baseServer({
      id: "playwright",
      enabled: true,
      status: { kind: "inherited", from: "session" },
    });
    const { container } = render(
      <McpServerCard
        viewLevel="conversation"
        server={server}
        actions={{ onToggleTool }}
        defaultOpen
      />,
    );
    const toolToggle = container.querySelector(
      'button[aria-label="Disable tool browser_click"]',
    ) as HTMLButtonElement;
    expect(toolToggle).toBeTruthy();
    expect(toolToggle.disabled).toBe(false);
    fireEvent.click(toolToggle);
    expect(onToggleTool).toHaveBeenCalledWith(
      "playwright",
      "browser_click",
      false,
    );
  });

  it("shows a busy refresh control while this server's tool refresh is pending", () => {
    const onRefreshTools = vi.fn();
    const server = baseServer({ id: "playwright" });
    const { container } = render(
      <McpServerCard
        viewLevel="conversation"
        server={server}
        actions={{ onRefreshTools, refreshingServerId: "playwright" }}
        defaultOpen
      />,
    );
    const refreshButton = container.querySelector(
      'button[aria-label="Refresh tool list"]',
    ) as HTMLButtonElement;
    expect(refreshButton).toBeTruthy();
    expect(refreshButton.disabled).toBe(true);
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    expect(refreshButton.querySelector(".animate-spin")).toBeTruthy();
    fireEvent.click(refreshButton);
    expect(onRefreshTools).not.toHaveBeenCalled();
  });

  it("keeps the refresh control idle when a different server is refreshing", () => {
    const onRefreshTools = vi.fn();
    const server = baseServer({ id: "playwright" });
    const { container } = render(
      <McpServerCard
        viewLevel="conversation"
        server={server}
        actions={{ onRefreshTools, refreshingServerId: "other-server" }}
        defaultOpen
      />,
    );
    const refreshButton = container.querySelector(
      'button[aria-label="Refresh tool list"]',
    ) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.getAttribute("aria-busy")).toBeNull();
    expect(refreshButton.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(refreshButton);
    expect(onRefreshTools).toHaveBeenCalledWith("playwright");
  });

  it("still locks tool toggles when the server is effectively off (even if inherited)", () => {
    const onToggleTool = vi.fn();
    const server = baseServer({
      id: "playwright",
      enabled: false,
      status: { kind: "inherited", from: "session" },
    });
    const { container } = render(
      <McpServerCard
        viewLevel="conversation"
        server={server}
        actions={{ onToggleTool }}
        defaultOpen
      />,
    );
    const toolToggle = container.querySelector(
      'button[aria-label="Disable tool browser_click"]',
    ) as HTMLButtonElement;
    expect(toolToggle.disabled).toBe(true);
    fireEvent.click(toolToggle);
    expect(onToggleTool).not.toHaveBeenCalled();
  });
});
