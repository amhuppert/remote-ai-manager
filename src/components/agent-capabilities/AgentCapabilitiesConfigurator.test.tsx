// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

// Minimal layer set — enough to mount the grouped tablist. The data-fetching
// panel containers sit in their pending state (no fetch resolves in jsdom),
// which is irrelevant to the tablist roving-focus behaviour under test.
const layerOptions: readonly AgentCapabilityLayerOption[] = [
  { label: "Global", scope: { level: "global" } },
];

function renderConfigurator() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentCapabilitiesConfigurator layerOptions={layerOptions} />
    </QueryClientProvider>,
  );
}

describe("AgentCapabilitiesConfigurator roving focus", () => {
  it("ArrowRight moves DOM focus + selection to the adjacent tab, skipping group labels, and swaps the visible panel", async () => {
    const user = userEvent.setup();
    renderConfigurator();

    // The Shared/Claude/Codex group labels are non-interactive <span>s
    // interleaved between triggers; Radix only registers role=tab elements in
    // the roving sequence, so arrow nav steps trigger → trigger across them.
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "MCP Servers",
      "Skills",
      "Agents",
      "Plugins",
      "Skills",
      "Plugins",
    ]);

    const mcpTab = screen.getByRole("tab", { name: "MCP Servers" });
    const claudeSkillsTab = tabs[1]!; // first "Skills" — Claude group
    expect(mcpTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      mcpTab.id,
    );

    // Roving focus: the selected tab is the only one in the tab sequence.
    mcpTab.focus();
    expect(mcpTab).toHaveFocus();

    await user.keyboard("{ArrowRight}");

    // Adjacent trigger gains DOM focus (the group-label span between the two
    // groups is not focusable) and auto-activates.
    expect(claudeSkillsTab).toHaveFocus();
    expect(claudeSkillsTab).toHaveAttribute("aria-selected", "true");
    expect(mcpTab).toHaveAttribute("aria-selected", "false");
    // The visible panel swaps to the newly-activated tab's panel.
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      claudeSkillsTab.id,
    );
  });

  it("ArrowLeft moves DOM focus + selection back to the previous tab and restores its panel", async () => {
    const user = userEvent.setup();
    renderConfigurator();

    const tabs = screen.getAllByRole("tab");
    const mcpTab = tabs[0]!;
    const claudeSkillsTab = tabs[1]!;

    claudeSkillsTab.focus();
    await user.keyboard("{ArrowLeft}");

    expect(mcpTab).toHaveFocus();
    expect(mcpTab).toHaveAttribute("aria-selected", "true");
    expect(claudeSkillsTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      mcpTab.id,
    );
  });
});
