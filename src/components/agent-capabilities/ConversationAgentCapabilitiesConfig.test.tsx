// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import ConversationAgentCapabilitiesConfig from "./ConversationAgentCapabilitiesConfig";

vi.mock("./AgentCapabilityPanelContainer", () => ({
  AgentCapabilityPanelContainer: ({
    cascadeKind,
    layerOptions,
    initialScope,
    onOpenPlugin,
    initialSearch,
  }: {
    cascadeKind: string;
    layerOptions: readonly { label: string; scope: { level: string } }[];
    initialScope?: { level: string };
    onOpenPlugin?: (pluginId: string, backend: "claude" | "codex") => void;
    initialSearch?: string;
  }) => (
    <section data-testid={`capability-panel-${cascadeKind}`}>
      <span>{cascadeKind}</span>
      <span data-testid={`capability-layers-${cascadeKind}`}>
        {layerOptions.map((option) => option.scope.level).join("|")}
      </span>
      <span data-testid={`capability-initial-${cascadeKind}`}>
        {initialScope?.level}
      </span>
      <span data-testid={`capability-search-${cascadeKind}`}>
        {initialSearch}
      </span>
      {cascadeKind === "claude-skills" ? (
        <button
          type="button"
          onClick={() => onOpenPlugin?.("git-guardrails", "claude")}
        >
          Open linked plugin
        </button>
      ) : null}
    </section>
  ),
}));

vi.mock("./McpCapabilityPanelContainer", () => ({
  McpCapabilityPanelContainer: ({
    layerOptions,
    selectedScope,
  }: {
    layerOptions: readonly { label: string; scope: { level: string } }[];
    selectedScope: { level: string };
  }) => (
    <section data-testid="capability-panel-mcp">
      <span>mcp</span>
      <span data-testid="capability-layers-mcp">
        {layerOptions.map((option) => option.scope.level).join("|")}
      </span>
      <span data-testid="capability-initial-mcp">{selectedScope.level}</span>
    </section>
  ),
}));

describe("ConversationAgentCapabilitiesConfig", () => {
  it("opens the unified capability configurator in a right drawer", () => {
    render(
      <ConversationAgentCapabilitiesConfig
        projectName="remote-ai-manager"
        sessionName="configurable-capabilities"
        conversationId="conv-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Agent capability configuration",
      }),
    );

    const drawer = screen.getByRole("dialog", {
      name: "Agent capabilities configuration",
    });
    expect(
      screen.getByTestId("agent-capabilities-drawer-overlay"),
    ).toBeInTheDocument();

    expect(
      within(drawer).getByTestId("capability-panel-mcp"),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByTestId("capability-layers-mcp"),
    ).toHaveTextContent("global|project|session|conversation");
    expect(
      within(drawer).getByTestId("capability-initial-mcp"),
    ).toHaveTextContent("conversation");

    // Radix Tabs wiring: the MCP trigger is the selected tab and the visible
    // panel is its linked role=tabpanel.
    const mcpTab = within(drawer).getByRole("tab", { name: "MCP Servers" });
    expect(mcpTab).toHaveAttribute("aria-selected", "true");
    expect(within(drawer).getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      mcpTab.id,
    );

    // Radix Tabs activate on mousedown/focus, not a bare synthetic click.
    fireEvent.mouseDown(
      within(drawer).getAllByRole("tab", { name: "Skills" })[0]!,
    );
    expect(
      within(drawer).getByTestId("capability-panel-claude-skills"),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByTestId("capability-layers-claude-skills"),
    ).toHaveTextContent("global|project|session|conversation");
    expect(
      within(drawer).getByTestId("capability-initial-claude-skills"),
    ).toHaveTextContent("conversation");

    fireEvent.click(
      within(drawer).getByRole("button", { name: "Open linked plugin" }),
    );
    expect(
      within(drawer).getByTestId("capability-panel-claude-plugins"),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByTestId("capability-search-claude-plugins"),
    ).toHaveTextContent("git-guardrails");

    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "Agents" }));
    expect(
      within(drawer).getByTestId("capability-panel-claude-agents"),
    ).toBeInTheDocument();

    fireEvent.mouseDown(
      within(drawer).getAllByRole("tab", { name: "Plugins" })[0]!,
    );
    expect(
      within(drawer).getByTestId("capability-panel-claude-plugins"),
    ).toBeInTheDocument();

    fireEvent.mouseDown(
      within(drawer).getAllByRole("tab", { name: "Skills" })[1]!,
    );
    expect(
      within(drawer).getByTestId("capability-panel-codex-skills"),
    ).toBeInTheDocument();

    fireEvent.mouseDown(
      within(drawer).getAllByRole("tab", { name: "Plugins" })[1]!,
    );
    expect(
      within(drawer).getByTestId("capability-panel-codex-plugins"),
    ).toBeInTheDocument();

    for (const cascadeKind of ["codex-plugins"] as const) {
      expect(
        within(drawer).getByTestId(`capability-layers-${cascadeKind}`),
      ).toHaveTextContent("global|project|session|conversation");
      expect(
        within(drawer).getByTestId(`capability-initial-${cascadeKind}`),
      ).toHaveTextContent("conversation");
    }
  });
});
