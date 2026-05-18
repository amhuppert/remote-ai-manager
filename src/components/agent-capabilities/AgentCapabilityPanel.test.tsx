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
        source: {
          kind: "user-file",
          path: "/home/alex/.claude/skills/planner",
        },
        nativeDefault: { enabled: true },
        ownEffectiveState: { enabled: true, originLayer: "native" },
        inheritedEffectiveState: { enabled: true, originLayer: "native" },
        effectiveState: { enabled: false, originLayer: "project" },
        originLayer: "project",
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
  it("renders the capability row fields needed to distinguish current, inherited, stale, pending, and diagnostic states", () => {
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

    const reviewer = screen.getByTestId("capability-row-reviewer");
    expect(within(reviewer).getByText("Reviewer")).toBeInTheDocument();
    expect(
      within(reviewer).getByText("plugin: quality-pack"),
    ).toBeInTheDocument();
    expect(within(reviewer).getByText("backend claude")).toBeInTheDocument();
    expect(within(reviewer).getByText("native enabled")).toBeInTheDocument();
    expect(
      within(reviewer).getByText("effective disabled"),
    ).toBeInTheDocument();
    expect(within(reviewer).getByText("current disabled")).toBeInTheDocument();
    expect(
      within(reviewer).getByText("inherited enabled from project"),
    ).toBeInTheDocument();
    expect(
      within(reviewer).getByText("origin conversation"),
    ).toBeInTheDocument();
    expect(within(reviewer).getByText("runtime visible")).toBeInTheDocument();
    expect(within(reviewer).getByText("emittable")).toBeInTheDocument();
    expect(within(reviewer).getByText("staged idle")).toBeInTheDocument();

    const planner = screen.getByTestId("capability-row-planner");
    expect(
      within(planner).getByText("disabled by planning-pack from project"),
    ).toBeInTheDocument();
    expect(
      within(planner).getByText("Disabled by planning-pack."),
    ).toBeInTheDocument();

    expect(
      screen.getByText("One skill source could not be read."),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("capability-row-legacy")).getAllByText("stale")
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

  it("keeps stale stored intent editable while showing it is not runtime-emittable", () => {
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
    expect(within(legacy).getByText("not emittable")).toBeInTheDocument();
    const disableButton = within(legacy).getByRole("button", {
      name: "Disable legacy",
    });
    expect(disableButton).not.toBeDisabled();
    fireEvent.click(disableButton);
    expect(onToggleItem).toHaveBeenCalledWith("legacy", false);
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
