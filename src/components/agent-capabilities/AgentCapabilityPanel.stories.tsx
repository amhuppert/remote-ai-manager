import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityViewResponse,
  AgentCapabilityViewRow,
} from "@/lib/agent-capabilities/schemas";

import { AgentCapabilityPanel } from "./AgentCapabilityPanel";

const layerOptions = [
  { label: "Global", scope: { level: "global" } as const },
  {
    label: "Project",
    scope: { level: "project", projectName: "remote-ai-manager" } as const,
  },
  {
    label: "Session",
    scope: {
      level: "session",
      projectName: "remote-ai-manager",
      sessionName: "capabilities",
    } as const,
  },
  {
    label: "Conversation",
    scope: {
      level: "conversation",
      projectName: "remote-ai-manager",
      sessionName: "capabilities",
      conversationId: "conv-1",
    } as const,
  },
];

const sharedActions = {
  onScopeChange: fn(),
  onToggleItem: fn(),
  onResetItem: fn(),
  onRefresh: fn(),
  onOpenPlugin: fn(),
};

const meta = {
  title: "Agent Capabilities/AgentCapabilityPanel",
  component: AgentCapabilityPanel,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AgentCapabilityPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NativeInheritedOverridden: Story = {
  args: {
    title: "Claude Skills",
    view: viewWithRows([
      row({ itemId: "native-skill", displayName: "Native Skill" }),
      row({
        itemId: "inherited-skill",
        displayName: "Inherited Skill",
        effectiveState: { enabled: true, originLayer: "project" },
        inheritedEffectiveState: { enabled: true, originLayer: "project" },
        originLayer: "project",
      }),
      row({
        itemId: "overridden-skill",
        displayName: "Overridden Skill",
        effectiveState: { enabled: false, originLayer: "conversation" },
        currentLayerValue: { enabled: false, originLayer: "conversation" },
        inheritedEffectiveState: { enabled: true, originLayer: "session" },
        originLayer: "conversation",
      }),
    ]),
    layerOptions,
    selectedScope: layerOptions[3]!.scope,
    ...sharedActions,
  },
};

export const ParentStalePendingFailedDiagnostic: Story = {
  args: {
    title: "Claude Skills",
    view: viewWithRows(
      [
        row({
          itemId: "parent-disabled-skill",
          displayName: "Parent Disabled Skill",
          source: { kind: "plugin", pluginId: "planning-pack" },
          owningPluginId: "planning-pack",
          ownEffectiveState: { enabled: true, originLayer: "global" },
          inheritedEffectiveState: { enabled: true, originLayer: "global" },
          effectiveState: { enabled: false, originLayer: "project" },
          inheritedDisableReason: {
            pluginId: "planning-pack",
            originLayer: "project",
          },
        }),
        row({
          itemId: "stale-stored-skill",
          displayName: "Stale Stored Skill",
          source: { kind: "project-file", path: ".claude/skills/stale" },
          stale: true,
          runtimeVisibility: "stale",
          runtimeEmittable: false,
          applyStatus: "unsupported",
        }),
        row({
          itemId: "pending-skill",
          displayName: "Pending Skill",
          applyStatus: "staged-idle",
        }),
        row({
          itemId: "failed-skill",
          displayName: "Failed Skill",
          applyStatus: "rejected",
          diagnostics: [
            {
              severity: "error",
              code: "agent-capability-apply-failed",
              message: "Apply failed during idle reload.",
              cascadeKind: "claude-skills",
              backend: "claude",
              itemId: "failed-skill",
            },
          ],
        }),
        row({
          itemId: "diagnostic-skill",
          displayName: "Diagnostic Skill",
          diagnostics: [
            {
              severity: "warning",
              code: "agent-capabilities.discovery.source-unreadable",
              message: "Skill source could not be read.",
              cascadeKind: "claude-skills",
              backend: "claude",
              itemId: "diagnostic-skill",
            },
          ],
        }),
      ],
      {
        diagnostics: [
          {
            severity: "warning",
            code: "agent-capabilities.discovery.partial",
            message: "Discovery completed with diagnostics.",
            cascadeKind: "claude-skills",
            backend: "claude",
          },
        ],
      },
    ),
    layerOptions,
    selectedScope: layerOptions[3]!.scope,
    ...sharedActions,
  },
};

export const UnavailableCodexPlugins: Story = {
  args: {
    title: "Codex Plugins",
    view: viewWithRows(
      [
        row({
          itemId: "codex-plugin-a",
          displayName: "Codex Plugin A",
          cascadeKind: "codex-plugins",
          backend: "codex",
          capabilityKind: "plugin",
          source: { kind: "sdk-runtime" },
          nativeDefault: { enabled: false },
          ownEffectiveState: { enabled: false, originLayer: "native" },
          effectiveState: { enabled: false, originLayer: "native" },
          originLayer: "native",
          runtimeVisibility: "unavailable",
          runtimeEmittable: false,
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
        }),
      ],
      {
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
      },
    ),
    layerOptions,
    selectedScope: layerOptions[1]!.scope,
    ...sharedActions,
  },
};

export const PluginProvidedRows: Story = {
  args: {
    title: "Claude Skills",
    view: viewWithRows([
      row({
        itemId: "release-notes",
        displayName: "release-notes",
        source: { kind: "plugin", pluginId: "git-guardrails" },
        owningPluginId: "git-guardrails",
        currentLayerValue: { enabled: true, originLayer: "global" },
        ownEffectiveState: { enabled: true, originLayer: "global" },
        effectiveState: { enabled: true, originLayer: "global" },
        originLayer: "global",
      }),
      row({
        itemId: "commit-review",
        displayName: "commit-review",
        source: { kind: "plugin", pluginId: "git-guardrails" },
        owningPluginId: "git-guardrails",
        ownEffectiveState: { enabled: true, originLayer: "global" },
        inheritedEffectiveState: { enabled: true, originLayer: "global" },
        effectiveState: { enabled: false, originLayer: "global" },
        originLayer: "global",
        inheritedDisableReason: {
          pluginId: "git-guardrails",
          originLayer: "global",
        },
      }),
    ]),
    layerOptions,
    selectedScope: layerOptions[0]!.scope,
    ...sharedActions,
  },
};

export const InteractiveRegression: Story = {
  args: {
    title: "Claude Skills",
    view: viewWithRows([
      row({ itemId: "native-skill", displayName: "Native Skill" }),
      row({
        itemId: "stale-stored-skill",
        displayName: "Stale Stored Skill",
        stale: true,
        runtimeVisibility: "stale",
        runtimeEmittable: false,
      }),
      row({
        itemId: "long-unbroken-capability-identifier-with-diagnostics",
        displayName: "Long Identifier Capability",
        currentLayerValue: { enabled: true, originLayer: "conversation" },
        effectiveState: { enabled: true, originLayer: "conversation" },
        originLayer: "conversation",
        source: {
          kind: "user-file",
          path: "/home/alex/.claude/skills/long-unbroken-capability-identifier-with-diagnostics",
        },
        diagnostics: [
          {
            severity: "info",
            code: "agent-capability-diagnostic",
            message: "Long compact row text should wrap inside the row.",
            cascadeKind: "claude-skills",
            backend: "claude",
            itemId: "long-unbroken-capability-identifier-with-diagnostics",
          },
        ],
      }),
    ]),
    layerOptions,
    selectedScope: layerOptions[3]!.scope,
    ...sharedActions,
  },
};

export const ErrorRendering: Story = {
  args: {
    title: "Claude Skills",
    view: undefined,
    layerOptions,
    selectedScope: layerOptions[0]!.scope,
    errorMessage: "Capability view could not be loaded.",
    ...sharedActions,
  },
};

export const FivePanelsOverview: Story = {
  args: {
    title: "Claude Skills",
    view: viewForCascade("claude-skills"),
    layerOptions,
    selectedScope: layerOptions[1]!.scope,
    ...sharedActions,
  },
  render: () => (
    <div style={{ display: "grid", gap: "var(--space-md)" }}>
      {(
        [
          ["Claude Skills", "claude-skills"],
          ["Claude Plugins", "claude-plugins"],
          ["Claude Sub-Agents", "claude-agents"],
          ["Codex Skills", "codex-skills"],
          ["Codex Plugins", "codex-plugins"],
        ] as const
      ).map(([title, cascadeKind]) => (
        <AgentCapabilityPanel
          key={cascadeKind}
          title={title}
          view={viewForCascade(cascadeKind)}
          layerOptions={layerOptions}
          selectedScope={layerOptions[1]!.scope}
          {...sharedActions}
        />
      ))}
    </div>
  ),
};

function viewForCascade(
  cascadeKind: AgentCapabilityCascadeKind,
): AgentCapabilityViewResponse {
  const backend = cascadeKind.startsWith("codex") ? "codex" : "claude";
  const capabilityKind = cascadeKind.endsWith("plugins")
    ? "plugin"
    : cascadeKind.endsWith("agents")
      ? "agent"
      : "skill";
  return viewWithRows(
    [
      row({
        itemId: `${cascadeKind}-sample`,
        displayName: `${cascadeKind} sample`,
        cascadeKind,
        backend,
        capabilityKind,
      }),
    ],
    {
      cascadeKind,
      backend,
      metadata: {
        cascadeKind,
        backend,
        capabilityKind,
        applySemantics: backend === "codex" ? "next-turn" : "idle-live-apply",
        discoverySupport: "available",
        runtimeVisibility: backend === "codex" ? "source-only" : "sdk-runtime",
        compositionSupport: "translator",
      },
    },
  );
}

function viewWithRows(
  items: readonly AgentCapabilityViewRow[],
  overrides: Partial<AgentCapabilityViewResponse> = {},
): AgentCapabilityViewResponse {
  return {
    level: "conversation",
    projectName: "remote-ai-manager",
    sessionName: "capabilities",
    conversationId: "conv-1",
    cascadeKind: "claude-skills",
    backend: "claude",
    effectiveHash: "storybook-hash",
    metadata: {
      cascadeKind: "claude-skills",
      backend: "claude",
      capabilityKind: "skill",
      applySemantics: "idle-live-apply",
      discoverySupport: "available",
      runtimeVisibility: "sdk-runtime",
      compositionSupport: "translator",
    },
    diagnostics: [],
    items: [...items],
    ...overrides,
  };
}

function row(
  overrides: Partial<AgentCapabilityViewRow> = {},
): AgentCapabilityViewRow {
  const cascadeKind = overrides.cascadeKind ?? "claude-skills";
  const backend = overrides.backend ?? "claude";
  const capabilityKind = overrides.capabilityKind ?? "skill";
  return {
    itemId: "native-skill",
    displayName: "Native Skill",
    backend,
    capabilityKind,
    cascadeKind,
    source: { kind: "user-file", path: "/home/alex/.claude/skills/native" },
    nativeDefault: { enabled: true },
    ownEffectiveState: { enabled: true, originLayer: "native" },
    inheritedEffectiveState: { enabled: true, originLayer: "native" },
    effectiveState: { enabled: true, originLayer: "native" },
    originLayer: "native",
    runtimeVisibility: "runtime-visible",
    runtimeEmittable: true,
    stale: false,
    applyStatus: "none",
    diagnostics: [],
    ...overrides,
  };
}
