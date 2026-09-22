// @vitest-environment jsdom
import * as matchers from "@testing-library/jest-dom/matchers";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { McpServerView } from "@/components/mcp/types";
import { McpCapabilityRow } from "./McpCapabilityPanelContainer";

expect.extend(matchers);

function server(configurable: boolean): McpServerView {
  return {
    id: "docs",
    name: "Docs",
    sourceFile: ".mcp.json",
    scope: "project",
    enabled: true,
    status: { kind: "inherited", from: "project" },
    pending: true,
    pendingLabel: "Applies in a new conversation",
    compatibility: {
      backends: [
        {
          backend: "claude",
          supported: true,
          toolControl: {
            configurable,
            notes: ["Tool changes apply in a new conversation."],
            applyTiming: "next-conversation",
          },
        },
      ],
    },
    toolDiscovery: {
      kind: "loaded",
      tools: [
        {
          name: "search",
          enabled: false,
          status: { kind: "disabled" },
          pending: true,
        },
      ],
    },
  };
}

describe("MCP capability row support", () => {
  it("makes unavailable transports read-only for the addressed backend", () => {
    const unavailable = server(true);
    unavailable.compatibility = {
      backends: [
        {
          backend: "codex",
          supported: false,
          reason: "This transport is unavailable.",
        },
      ],
    };
    render(
      <McpCapabilityRow
        server={unavailable}
        backend="codex"
        scopeName="Conversation"
        refreshing={false}
        expanded
        onExpand={vi.fn()}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onRefreshTools={vi.fn()}
        onToggleTool={vi.fn()}
        onResetTool={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch", { name: "Disable Docs" })).toBeDisabled();
    expect(screen.getByLabelText("Enable search")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset search" })).toBeEnabled();
  });

  it("keeps server availability and reset while making unsupported tool control read-only", () => {
    const reset = vi.fn();
    render(
      <McpCapabilityRow
        server={server(false)}
        backend="claude"
        scopeName="Conversation"
        refreshing={false}
        expanded
        onExpand={vi.fn()}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onRefreshTools={vi.fn()}
        onToggleTool={vi.fn()}
        onResetTool={reset}
      />,
    );
    expect(screen.getByRole("switch", { name: "Disable Docs" })).toBeEnabled();
    expect(screen.getByLabelText("Enable search")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset search" }));
    expect(reset).toHaveBeenCalledWith("search");
    expect(
      screen.queryByText("Tool changes apply in a new conversation."),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Information about Docs" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Tool changes apply in a new conversation.",
    );
    expect(screen.queryByText("denied")).toBeNull();
  });

  it("keeps delayed tool choices editable and reports the pending boundary", () => {
    render(
      <McpCapabilityRow
        server={server(true)}
        backend="claude"
        scopeName="Conversation"
        refreshing={false}
        expanded
        onExpand={vi.fn()}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        onRefreshTools={vi.fn()}
        onToggleTool={vi.fn()}
        onResetTool={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Enable search")).toBeEnabled();
    expect(
      screen.getByText("Applies in a new conversation"),
    ).toBeInTheDocument();
  });
});
