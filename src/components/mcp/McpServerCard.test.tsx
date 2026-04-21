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
    sourceFile: overrides.sourceFile ?? "/home/alex/.claude/settings.json",
    scope: overrides.scope ?? "user",
    backend: overrides.backend ?? "claude",
    enabled: overrides.enabled ?? true,
    status: overrides.status ?? { kind: "inherited", from: "session" },
    pending: overrides.pending,
    backendCompatibility: overrides.backendCompatibility,
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
      ".mcp-tool-row .mcp-tool-toggle",
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
      ".mcp-tool-row .mcp-tool-toggle",
    ) as HTMLButtonElement;
    expect(toolToggle.disabled).toBe(true);
    fireEvent.click(toolToggle);
    expect(onToggleTool).not.toHaveBeenCalled();
  });
});
