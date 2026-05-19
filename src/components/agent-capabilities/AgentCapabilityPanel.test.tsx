// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { AgentCapabilityViewResponse } from "@/lib/schemas";

import {
  AgentCapabilityPanel,
  ClaudeSkillsPanel,
  CodexPluginsPanel,
} from "./AgentCapabilityPanel";

function baseView(
  overrides: Partial<AgentCapabilityViewResponse> = {},
): AgentCapabilityViewResponse {
  return {
    level: "conversation",
    projectName: "remote-ai-manager",
    sessionName: "capabilities",
    conversationId: "conv-1",
    cascadeKind: "claude-skills",
    backend: "claude",
    effectiveHash: "hash-rows",
    metadata: {
      cascadeKind: "claude-skills",
      backend: "claude",
      capabilityKind: "skill",
      applySemantics: "idle-live-apply",
      discoverySupport: "available",
      runtimeVisibility: "sdk-runtime",
      compositionSupport: "translator",
    },
    diagnostics: [
      {
        severity: "warning",
        code: "agent-capabilities.discovery.source-unreadable",
        message: "One skill source could not be read.",
        cascadeKind: "claude-skills",
        backend: "claude",
      },
    ],
    items: [
      {
        itemId: "reviewer",
        displayName: "Reviewer",
        backend: "claude",
        capabilityKind: "skill",
        cascadeKind: "claude-skills",
        source: { kind: "plugin", pluginId: "quality-pack" },
        nativeDefault: { enabled: true },
        ownEffectiveState: { enabled: false, originLayer: "session" },
        currentLayerValue: { enabled: false, originLayer: "conversation" },
        inheritedEffectiveState: { enabled: true, originLayer: "project" },
        effectiveState: { enabled: false, originLayer: "conversation" },
        originLayer: "conversation",
        owningPluginId: "quality-pack",
        runtimeVisibility: "runtime-visible",
        runtimeEmittable: true,
        stale: false,
        applyStatus: "staged-idle",
        diagnostics: [],
      },
      {
        itemId: "planner",
        displayName: "Planner",
        backend: "claude",
        capabilityKind: "skill",
        cascadeKind: "claude-skills",
        source: { kind: "plugin", pluginId: "planning-pack" },
        nativeDefault: { enabled: true },
        ownEffectiveState: { enabled: true, originLayer: "global" },
        inheritedEffectiveState: { enabled: true, originLayer: "global" },
        effectiveState: { enabled: false, originLayer: "project" },
        originLayer: "project",
        owningPluginId: "planning-pack",
        inheritedDisableReason: {
          pluginId: "planning-pack",
          originLayer: "project",
        },
        runtimeVisibility: "runtime-visible",
        runtimeEmittable: true,
        stale: false,
        applyStatus: "none",
        diagnostics: [
          {
            severity: "info",
            code: "agent-capabilities.parent-disabled",
            message: "Disabled by planning-pack.",
            cascadeKind: "claude-skills",
            backend: "claude",
            itemId: "planner",
          },
        ],
      },
      {
        itemId: "legacy",
        displayName: "legacy",
        backend: "claude",
        capabilityKind: "skill",
        cascadeKind: "claude-skills",
        source: { kind: "project-file", path: ".claude/skills/legacy" },
        nativeDefault: { enabled: false },
        ownEffectiveState: { enabled: true, originLayer: "session" },
        inheritedEffectiveState: { enabled: true, originLayer: "session" },
        effectiveState: { enabled: true, originLayer: "session" },
        originLayer: "session",
        runtimeVisibility: "stale",
        runtimeEmittable: false,
        stale: true,
        applyStatus: "unsupported",
        diagnostics: [],
      },
    ],
    ...overrides,
  };
}

describe("AgentCapabilityPanel", () => {
  it("renders the prototype-style cascade switcher and filter pills", () => {
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          { label: "Global", scope: { level: "global" } },
          {
            label: "Project",
            scope: { level: "project", projectName: "remote-ai-manager" },
          },
          {
            label: "Session",
            scope: {
              level: "session",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
            },
          },
          {
            label: "Conversation",
            scope: {
              level: "conversation",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
              conversationId: "conv-1",
            },
          },
        ]}
        selectedScope={{
          level: "conversation",
          projectName: "remote-ai-manager",
          sessionName: "capabilities",
          conversationId: "conv-1",
        }}
        onScopeChange={vi.fn()}
        onOpenPlugin={vi.fn()}
        onToggleItem={vi.fn()}
      />,
    );

    expect(screen.getByText("Editing at")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Global/i })).toHaveClass(
      "agent-capability-level",
    );
    expect(screen.getByRole("button", { name: /Conversation/i })).toHaveClass(
      "agent-capability-level--active",
    );
    expect(
      screen.getByRole("button", { name: "Show all" }),
    ).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show overridden" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Overridden")).toBeInTheDocument();
  });

  it("renders prototype row state without exposing raw resolver metadata", () => {
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          {
            label: "Conversation",
            scope: {
              level: "conversation",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
              conversationId: "conv-1",
            },
          },
        ]}
        selectedScope={{
          level: "conversation",
          projectName: "remote-ai-manager",
          sessionName: "capabilities",
          conversationId: "conv-1",
        }}
        onScopeChange={vi.fn()}
        onOpenPlugin={vi.fn()}
        onToggleItem={vi.fn()}
      />,
    );

    const reviewer = screen.getByTestId("capability-row-reviewer");
    expect(within(reviewer).getByText("Reviewer")).toBeInTheDocument();
    expect(
      within(reviewer).getByText("Set off at Conversation"),
    ).toBeInTheDocument();
    expect(
      within(reviewer).getByRole("button", {
        name: "Open quality-pack plugin configuration",
      }),
    ).toHaveTextContent("via quality-pack");
    expect(within(reviewer).queryByText("backend claude")).toBeNull();
    expect(within(reviewer).queryByText("native enabled")).toBeNull();
    expect(within(reviewer).queryByText("effective disabled")).toBeNull();
    expect(within(reviewer).queryByText("origin conversation")).toBeNull();
    expect(within(reviewer).queryByText("runtime visible")).toBeNull();
    expect(within(reviewer).queryByText("emittable")).toBeNull();

    const planner = screen.getByTestId("capability-row-planner");
    expect(
      within(planner).getByText("Inherits on from Global"),
    ).toBeInTheDocument();
    expect(
      within(planner).getByRole("button", {
        name: "Open planning-pack plugin configuration",
      }),
    ).toHaveTextContent("Off via plugin · planning-pack");
    expect(
      within(planner).getByRole("button", {
        name: "Open planning-pack plugin configuration",
      }),
    ).toHaveClass("agent-capability-plugin-chip--suppressed");
    expect(
      within(planner).getByRole("button", { name: "Disable Planner" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(planner).getByText("Disabled by planning-pack."),
    ).toBeInTheDocument();

    expect(
      screen.getByText("One skill source could not be read."),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("capability-row-legacy")).getAllByText("Stale")
        .length,
    ).toBeGreaterThan(0);
  });

  it("filters rows by search text and state filters", () => {
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          {
            label: "Conversation",
            scope: {
              level: "conversation",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
              conversationId: "conv-1",
            },
          },
        ]}
        selectedScope={{
          level: "conversation",
          projectName: "remote-ai-manager",
          sessionName: "capabilities",
          conversationId: "conv-1",
        }}
        onScopeChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search Claude Skills"), {
      target: { value: "plan" },
    });
    expect(screen.queryByTestId("capability-row-reviewer")).toBeNull();
    expect(screen.getByTestId("capability-row-planner")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search Claude Skills"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("Show stale"));
    expect(screen.getByTestId("capability-row-legacy")).toBeInTheDocument();
    expect(screen.queryByTestId("capability-row-reviewer")).toBeNull();
  });

  it("keeps a single visible capability row in the standard fixed-height list", () => {
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          {
            label: "Global",
            scope: { level: "global" },
          },
        ]}
        selectedScope={{ level: "global" }}
        onScopeChange={vi.fn()}
        initialSearch="planner"
      />,
    );

    const row = screen.getByTestId("capability-row-planner");
    expect(row.parentElement).toHaveClass(
      "agent-capability-panel__rows--capabilities",
    );
    expect(row.parentElement).not.toHaveClass(
      "agent-capability-panel__rows--single",
    );
    expect(screen.queryByTestId("capability-row-reviewer")).toBeNull();
  });

  it("switches edited layers without leaving the panel", () => {
    const onScopeChange = vi.fn();
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          {
            label: "Project",
            scope: { level: "project", projectName: "remote-ai-manager" },
          },
          {
            label: "Conversation",
            scope: {
              level: "conversation",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
              conversationId: "conv-1",
            },
          },
        ]}
        selectedScope={{
          level: "conversation",
          projectName: "remote-ai-manager",
          sessionName: "capabilities",
          conversationId: "conv-1",
        }}
        onScopeChange={onScopeChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Edited layer"), {
      target: { value: "project:remote-ai-manager" },
    });
    expect(onScopeChange).toHaveBeenCalledWith({
      level: "project",
      projectName: "remote-ai-manager",
    });
  });

  it("edits only the selected item through enable, disable, and reset controls", () => {
    const onToggleItem = vi.fn();
    const onResetItem = vi.fn();
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          {
            label: "Conversation",
            scope: {
              level: "conversation",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
              conversationId: "conv-1",
            },
          },
        ]}
        selectedScope={{
          level: "conversation",
          projectName: "remote-ai-manager",
          sessionName: "capabilities",
          conversationId: "conv-1",
        }}
        onScopeChange={vi.fn()}
        onToggleItem={onToggleItem}
        onResetItem={onResetItem}
      />,
    );

    const reviewer = screen.getByTestId("capability-row-reviewer");
    fireEvent.click(
      within(reviewer).getByRole("button", { name: "Enable Reviewer" }),
    );
    fireEvent.click(
      within(reviewer).getByRole("button", { name: "Reset Reviewer" }),
    );

    expect(onToggleItem).toHaveBeenCalledWith("reviewer", true);
    expect(onResetItem).toHaveBeenCalledWith("reviewer");
    expect(onToggleItem).not.toHaveBeenCalledWith(
      "planner",
      expect.any(Boolean),
    );
  });

  it("keeps stale stored intent editable while showing the stale state", () => {
    const onToggleItem = vi.fn();
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[
          {
            label: "Session",
            scope: {
              level: "session",
              projectName: "remote-ai-manager",
              sessionName: "capabilities",
            },
          },
        ]}
        selectedScope={{
          level: "session",
          projectName: "remote-ai-manager",
          sessionName: "capabilities",
        }}
        onScopeChange={vi.fn()}
        onToggleItem={onToggleItem}
      />,
    );

    const legacy = screen.getByTestId("capability-row-legacy");
    expect(within(legacy).getByText("Stale")).toBeInTheDocument();
    const disableButton = within(legacy).getByRole("button", {
      name: "Disable legacy",
    });
    expect(disableButton).not.toBeDisabled();
    fireEvent.click(disableButton);
    expect(onToggleItem).toHaveBeenCalledWith("legacy", false);
  });

  it("opens the owning plugin tab from plugin provenance chips", () => {
    const onOpenPlugin = vi.fn();
    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={baseView()}
        layerOptions={[{ label: "Global", scope: { level: "global" } }]}
        selectedScope={{ level: "global" }}
        onScopeChange={vi.fn()}
        onOpenPlugin={onOpenPlugin}
      />,
    );

    fireEvent.click(
      within(screen.getByTestId("capability-row-planner")).getByRole("button", {
        name: "Open planning-pack plugin configuration",
      }),
    );

    expect(onOpenPlugin).toHaveBeenCalledWith("planning-pack", "claude");
  });

  it("disables verification-gated Codex controls and renders diagnostics", () => {
    const onToggleItem = vi.fn();
    const codexView = baseView({
      cascadeKind: "codex-plugins",
      backend: "codex",
      metadata: {
        cascadeKind: "codex-plugins",
        backend: "codex",
        capabilityKind: "plugin",
        applySemantics: "next-turn",
        discoverySupport: "unavailable-pending-verification",
        runtimeVisibility: "unsupported",
        compositionSupport: "verification-gated",
      },
      diagnostics: [
        {
          severity: "warning",
          code: "agent-capability-runtime-verification-gated",
          message: "Codex plugin support is pending verification.",
          cascadeKind: "codex-plugins",
          backend: "codex",
        },
      ],
      items: [
        {
          itemId: "codex-plugin-a",
          displayName: "Codex Plugin A",
          backend: "codex",
          capabilityKind: "plugin",
          cascadeKind: "codex-plugins",
          source: { kind: "sdk-runtime" },
          nativeDefault: { enabled: false },
          ownEffectiveState: { enabled: false, originLayer: "native" },
          effectiveState: { enabled: false, originLayer: "native" },
          originLayer: "native",
          runtimeVisibility: "unavailable",
          runtimeEmittable: false,
          stale: false,
          applyStatus: "unsupported",
          diagnostics: [
            {
              severity: "warning",
              code: "agent-capability-runtime-verification-gated",
              message: "Runtime emission is not verified.",
              cascadeKind: "codex-plugins",
              backend: "codex",
              itemId: "codex-plugin-a",
            },
          ],
        },
      ],
    });

    render(
      <AgentCapabilityPanel
        title="Codex Plugins"
        view={codexView}
        layerOptions={[
          {
            label: "Project",
            scope: { level: "project", projectName: "remote-ai-manager" },
          },
        ]}
        selectedScope={{ level: "project", projectName: "remote-ai-manager" }}
        onScopeChange={vi.fn()}
        onToggleItem={onToggleItem}
      />,
    );

    const row = screen.getByTestId("capability-row-codex-plugin-a");
    expect(
      screen.getByText("Codex plugin support is pending verification."),
    ).toBeInTheDocument();
    expect(
      within(row).getByText("Runtime emission is not verified."),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Enable Codex Plugin A" }),
    ).toBeDisabled();
    fireEvent.click(
      within(row).getByRole("button", { name: "Enable Codex Plugin A" }),
    );
    expect(onToggleItem).not.toHaveBeenCalled();
  });

  it("renders every backend apply status from metadata-driven row state", () => {
    const statuses = [
      "applied",
      "staged-idle",
      "staged-next-turn",
      "deferred-next-conversation",
      "unsupported",
      "rejected",
      "none",
    ] as const;
    const view = baseView({
      items: statuses.map((status, index) => ({
        itemId: `status-${status}`,
        displayName: `Status ${index}`,
        backend: "claude",
        capabilityKind: "skill",
        cascadeKind: "claude-skills",
        source: { kind: "sdk-runtime" },
        nativeDefault: { enabled: true },
        ownEffectiveState: { enabled: true, originLayer: "native" },
        effectiveState: { enabled: true, originLayer: "native" },
        originLayer: "native",
        runtimeVisibility: "runtime-visible",
        runtimeEmittable: true,
        stale: false,
        applyStatus: status,
        diagnostics: [],
      })),
    });

    render(
      <AgentCapabilityPanel
        title="Claude Skills"
        view={view}
        layerOptions={[{ label: "Global", scope: { level: "global" } }]}
        selectedScope={{ level: "global" }}
        onScopeChange={vi.fn()}
      />,
    );

    for (const status of statuses.filter((status) => status !== "none")) {
      expect(screen.getByText(status.replaceAll("-", " "))).toBeInTheDocument();
    }
  });
});

describe("fixed capability panels", () => {
  it("renders separate Claude Skills and Codex Plugins panels through the shared panel experience", () => {
    const codexView = baseView({
      cascadeKind: "codex-plugins",
      backend: "codex",
      metadata: {
        cascadeKind: "codex-plugins",
        backend: "codex",
        capabilityKind: "plugin",
        applySemantics: "next-turn",
        discoverySupport: "unavailable-pending-verification",
        runtimeVisibility: "unsupported",
        compositionSupport: "verification-gated",
      },
      items: [],
    });

    render(
      <>
        <ClaudeSkillsPanel
          view={baseView()}
          layerOptions={[
            {
              label: "Project",
              scope: { level: "project", projectName: "remote-ai-manager" },
            },
          ]}
          selectedScope={{ level: "project", projectName: "remote-ai-manager" }}
          onScopeChange={vi.fn()}
        />
        <CodexPluginsPanel
          view={codexView}
          layerOptions={[
            {
              label: "Project",
              scope: { level: "project", projectName: "remote-ai-manager" },
            },
          ]}
          selectedScope={{ level: "project", projectName: "remote-ai-manager" }}
          onScopeChange={vi.fn()}
        />
      </>,
    );

    expect(
      screen.getByRole("heading", { name: "Claude Skills" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Codex Plugins" }),
    ).toBeInTheDocument();
  });
});
