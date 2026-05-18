// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import ConversationAgentCapabilitiesConfig from "./ConversationAgentCapabilitiesConfig";

vi.mock("./AgentCapabilityPanelContainer", () => ({
  AgentCapabilityPanelContainer: ({
    cascadeKind,
    layerOptions,
    initialScope,
  }: {
    cascadeKind: string;
    layerOptions: readonly { label: string; scope: { level: string } }[];
    initialScope?: { level: string };
  }) => (
    <section data-testid={`capability-panel-${cascadeKind}`}>
      <span>{cascadeKind}</span>
      <span data-testid={`capability-layers-${cascadeKind}`}>
        {layerOptions.map((option) => option.scope.level).join("|")}
      </span>
      <span data-testid={`capability-initial-${cascadeKind}`}>
        {initialScope?.level}
      </span>
    </section>
  ),
}));

describe("ConversationAgentCapabilitiesConfig", () => {
  it("opens all five capability panels with global through conversation layer options", () => {
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

    const dialog = screen.getByRole("dialog", {
      name: "Agent capabilities configuration",
    });
    const expectedKinds = [
      "claude-skills",
      "claude-plugins",
      "claude-agents",
      "codex-skills",
      "codex-plugins",
    ];

    for (const cascadeKind of expectedKinds) {
      expect(
        within(dialog).getByTestId(`capability-panel-${cascadeKind}`),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByTestId(`capability-layers-${cascadeKind}`),
      ).toHaveTextContent("global|project|session|conversation");
      expect(
        within(dialog).getByTestId(`capability-initial-${cascadeKind}`),
      ).toHaveTextContent("conversation");
    }
  });
});
